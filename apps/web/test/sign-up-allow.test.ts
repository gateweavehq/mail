import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMail } from "./mail-worker";
import { OIDC, OIDC_VARS, standInProvider } from "./oidc-provider";

// A deployment closes sign-up with SIGN_UP_ALLOW. The server decides, wherever an account would
// come from: the sign-up form, GitHub or the provider. On a closed server only an address a
// provider proved makes an account, one the list names or a workspace invited: the form makes
// none, for anyone. A refusal must leave nothing behind, read the same for every address, and
// never stop someone who already has an account. A domain on the list counts only for exactly
// that domain, and a setting that is there but empty closes the server rather than opening it.

const origin = "https://mail.test";
const PASSWORD = "a-long-test-password";
const GITHUB_SECRET = "github-secret-for-tests";
const ASK = "https://gateweave.test/waitlist?from=mail";
const CLOSED_WORDS =
	"This server takes new accounts by invitation. If you already have an account, sign in.";
const REFUSAL = { code: "SIGN_UP_CLOSED", message: CLOSED_WORDS };

// Three copies of the Worker on one database. The first has a list.
/** The copy without the setting at all, where the accounts "from before the list" are made. */
const OPEN = 1;
/** The copy whose setting is there with nothing in it but separators. */
const EMPTIED = 2;

type Provider = Awaited<ReturnType<typeof standInProvider>>;
type Mail = Awaited<ReturnType<typeof startMail>>;

let mail: Mail;
let provider: Provider;

/** Who GitHub says each code is. */
const gitHubPeople = new Map<string, { id: number; email: string; verified: boolean }>();

async function gitHubTokens(request: Request) {
	const form = new URLSearchParams(await request.text());
	if (form.get("client_secret") !== GITHUB_SECRET) {
		return Response.json({ error: "incorrect_client_credentials" });
	}
	return Response.json({
		access_token: form.get("code"),
		token_type: "bearer",
		scope: "user:email",
	});
}

function gitHubApi(request: Request) {
	const code = (request.headers.get("authorization") ?? "").replace("Bearer ", "");
	const person = gitHubPeople.get(code);
	if (!person) return new Response(null, { status: 401 });
	if (new URL(request.url).pathname === "/user") {
		return Response.json({
			id: person.id,
			login: `person-${person.id}`,
			name: "Grace Hopper",
			email: person.email,
		});
	}
	return Response.json([{ email: person.email, primary: true, verified: person.verified }]);
}

beforeAll(async () => {
	provider = await standInProvider();
	mail = await startMail(origin, {
		isolates: 3,
		settings: {
			...OIDC_VARS,
			GITHUB_CLIENT_ID: "github-client-for-tests",
			GITHUB_CLIENT_SECRET: GITHUB_SECRET,
		},
		isolateSettings: [
			{
				// In mixed case, with an entry that is neither an address nor a domain.
				SIGN_UP_ALLOW: "Ada@Example.com, @Study.Example\n not-an-entry",
				SIGN_UP_REQUEST_URL: ASK,
			},
			// Not set at all, which is the only thing that leaves sign-up open.
			{},
			{ SIGN_UP_ALLOW: " ,\n, " },
		],
		hosts: {
			[new URL(OIDC.issuer).host]: async (request: Request) =>
				(await provider.outbound(request, new URL(request.url))) ??
				new Response("Not the provider", { status: 502 }),
			"github.com": gitHubTokens,
			"api.github.com": gitHubApi,
		},
	});
});

afterAll(async () => {
	await mail?.dispose();
});

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

/** Each request comes from its own address, because sign-ins are limited per address. */
let clients = 0;
function newClient() {
	clients += 1;
	return `198.51.${100 + Math.floor(clients / 250)}.${clients % 250}`;
}

function authApi(path: string, body: object, { isolate = 0, cookie = "" } = {}) {
	return mail.fetchIn(isolate, `${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": newClient(),
			"content-type": "application/json",
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
}

function signUp(email: string, isolate = 0) {
	return authApi(
		"/sign-up/email",
		{ name: "Sam Password", email, password: PASSWORD },
		{ isolate },
	);
}

/**
 * What a refusal must leave as it was: how many accounts, ways into them, sessions and
 * verifications there are, and whether an account has this address.
 */
async function rows(email: string) {
	const count = async (table: string) =>
		(await mail.db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
	const person = await mail.db
		.prepare("SELECT id FROM user WHERE lower(email) = lower(?)")
		.bind(email)
		.first();
	return {
		users: await count("user"),
		accounts: await count("account"),
		sessions: await count("session"),
		verifications: await count("verification"),
		hasAccount: person !== null,
	};
}

async function isSignedIn(cookie: string) {
	if (!cookie) return false;
	const response = await mail.fetch(`${origin}/api/auth/get-session`, { headers: { cookie } });
	return (await response.json()) !== null;
}

/** The form is refused, in the one answer, and nothing is left of the try. */
async function expectFormRefused(email: string, isolate = 0) {
	const before = await rows(email);
	const response = await signUp(email, isolate);
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual(REFUSAL);
	expect(response.headers.getSetCookie()).toEqual([]);
	expect(await rows(email)).toEqual(before);
}

/** To a provider and back with a code. Where Mail sends the browser then, and its cookie. */
async function through(
	providerId: "oidc" | "github",
	code: (authorize: URL) => string,
	{
		errorCallbackURL = "/login?redirect=%2F",
		isolate = 0,
	}: {
		/** Where a refusal goes, as the sign-in page says it. Null says nothing, as the page never does. */
		errorCallbackURL?: string | null;
		isolate?: number;
	} = {},
) {
	const client = newClient();
	const pressed = await mail.fetchIn(isolate, `${origin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({
			provider: providerId,
			callbackURL: "/",
			...(errorCallbackURL !== null && { errorCallbackURL }),
		}),
	});
	expect(pressed.status).toBe(200);
	const authorize = new URL(((await pressed.json()) as { url: string }).url);
	const query = new URLSearchParams({
		code: code(authorize),
		state: authorize.searchParams.get("state") ?? "",
		...(providerId === "oidc" && { iss: OIDC.issuer }),
	});
	const back = await mail.fetchIn(isolate, `${origin}/api/auth/callback/${providerId}?${query}`, {
		headers: { cookie: cookieOf(pressed), "cf-connecting-ip": client },
	});
	expect(back.status).toBe(302);
	return {
		location: new URL(back.headers.get("location") ?? "", origin),
		cookie: cookieOf(back),
	};
}

let subjects = 0;

/** Someone the provider knows comes back from it, their address verified there unless said. */
function throughProvider(
	email: string,
	claims: { email_verified?: unknown } = {},
	options: Parameters<typeof through>[2] = {},
) {
	subjects += 1;
	const sub = `subject-${subjects}`;
	return through(
		"oidc",
		(authorize) =>
			provider.grant(authorize, {
				sub,
				name: "Pat Provider",
				email,
				email_verified: true,
				...claims,
			}),
		options,
	);
}

function throughGitHub(email: string, verified = true) {
	subjects += 1;
	const code = `github-code-${subjects}`;
	gitHubPeople.set(code, { id: 5000 + subjects, email, verified });
	return through("github", () => code);
}

/** What a refused sign-in through a provider must look like, and leave. */
async function expectRefused(
	email: string,
	signIn: () => Promise<{ location: URL; cookie: string }>,
) {
	const before = await rows(email);
	expect(before.hasAccount).toBe(false);
	const { location, cookie } = await signIn();
	// Mail's own sign-in page, which has words for the code, and as it was: not Better Auth's page.
	expect(location.origin).toBe(origin);
	expect(location.pathname).toBe("/login");
	expect(location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
	expect(location.searchParams.get("redirect")).toBe("/");
	expect(await isSignedIn(cookie)).toBe(false);
	expect(await rows(email)).toEqual(before);
}

async function expectAdmitted(
	email: string,
	signIn: () => Promise<{ location: URL; cookie: string }>,
) {
	const { location, cookie } = await signIn();
	expect(location.pathname).toBe("/");
	expect(location.searchParams.get("error")).toBeNull();
	expect(await isSignedIn(cookie)).toBe(true);
	expect((await rows(email)).hasAccount).toBe(true);
	return cookie;
}

/** Someone with an account from before the list, a workspace of theirs, and an invitation to it. */
async function invite(email: string, slug: string) {
	const inviter = await signUp(`${slug}-owner@elsewhere.example`, OPEN);
	expect(inviter.status).toBe(200);
	const cookie = cookieOf(inviter);
	const workspace = await authApi(
		"/organization/create",
		{ name: slug, slug },
		{ isolate: OPEN, cookie },
	);
	expect(workspace.status).toBe(200);
	const { id: organizationId } = (await workspace.json()) as { id: string };
	const invited = await authApi(
		"/organization/invite-member",
		{ email, role: "member", organizationId },
		{ cookie },
	);
	expect(invited.status).toBe(200);
	return ((await invited.json()) as { id: string }).id;
}

async function page(path: string, isolate = 0) {
	const response = await mail.fetchIn(isolate, `${origin}${path}`);
	expect(response.status).toBe(200);
	return response.text();
}

/** What the page tells someone, in its alert. */
function alertOf(html: string) {
	return /<p role="alert"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;
}

/** An address that only looks like one the list names, by its domain or by itself. */
const NEAR_MISSES = [
	"x@evilstudy.example",
	"x@study.example.evil.org",
	"x@sub.study.example",
	"x@study.exampl",
	"study.example@evil.org",
	"xada@example.com",
	"ada@example.com.evil.org",
	"ada+tag@example.com",
];

describe("the sign-up form on a server with a list", () => {
	it.each([
		["an address that is not on the list", "stranger@elsewhere.example"],
		// Typing an address proves nothing, so the list does not count for one.
		["a listed address", "ada@example.com"],
		["an address at a listed domain", "typed@study.example"],
		...NEAR_MISSES.map((email) => ["one that only looks listed", email]),
	])("refuses %s (%s), and leaves nothing behind", async (_which, email) => {
		expect((await rows(email)).hasAccount).toBe(false);
		await expectFormRefused(email);
	});

	it("refuses an invited address too, which would otherwise be in ahead of its owner", async () => {
		const email = "invited-typed@elsewhere.example";
		await invite(email, "invites-typed");
		await expectFormRefused(email);
		expect((await rows(email)).hasAccount).toBe(false);
	});

	it("so nobody gets in by typing, to make a workspace and invite the next address", async () => {
		// What a typed, invited address could do before: a session at once, then a workspace of
		// its own, then an invitation to any other address, which came in the same way.
		const first = "chain-one@elsewhere.example";
		await invite(first, "chain");
		const typed = await signUp(first);
		expect(typed.status).toBe(403);
		const cookie = cookieOf(typed);
		expect(await isSignedIn(cookie)).toBe(false);
		const workspace = await authApi(
			"/organization/create",
			{ name: "chain-two", slug: "chain-two" },
			{ cookie },
		);
		expect(workspace.status).toBe(401);
	});

	it("refuses before reading what was sent, whatever it is", async () => {
		for (const body of [{}, { email: 7 }, { email: "stranger@elsewhere.example", name: "" }]) {
			const response = await authApi("/sign-up/email", body);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual(REFUSAL);
		}
	});

	it("answers an address that has an account as it answers one that has none", async () => {
		expect((await signUp("here-already@elsewhere.example", OPEN)).status).toBe(200);
		const before = await rows("here-already@elsewhere.example");

		const taken = await signUp("here-already@elsewhere.example");
		const free = await signUp("never-here@elsewhere.example");
		expect(taken.status).toBe(403);
		expect(free.status).toBe(taken.status);
		expect(await taken.text()).toBe(await free.text());
		expect(await rows("here-already@elsewhere.example")).toEqual(before);
	});
});

describe("the provider on a server with a list", () => {
	it("admits a listed address the provider verified, in any case", async () => {
		await expectAdmitted("ada@example.com", () => throughProvider("Ada@Example.COM"));
	});

	it("admits an address at a listed domain the provider verified, in any case", async () => {
		await expectAdmitted("pat@study.example", () => throughProvider("Pat@STUDY.Example"));
	});

	it("refuses an address that is not on the list, and leaves nothing behind", async () => {
		await expectRefused("stranger-oidc@elsewhere.example", () =>
			throughProvider("stranger-oidc@elsewhere.example"),
		);
	});

	it.each(NEAR_MISSES)("refuses %s, which only looks listed", async (email) => {
		await expectRefused(email, () => throughProvider(email));
	});

	it.each([
		["false", false],
		["nothing", undefined],
		["the text 'true'", "true"],
	])("refuses a listed address the provider did not verify (%s)", async (_said, email_verified) => {
		await expectRefused("unproved@study.example", () =>
			throughProvider("unproved@study.example", { email_verified }),
		);
	});

	it("sends a refusal that names no page of its own to the sign-in page all the same", async () => {
		const email = "nowhere-to-go@elsewhere.example";
		const before = await rows(email);
		const { location, cookie } = await throughProvider(email, {}, { errorCallbackURL: null });
		expect(`${location.origin}${location.pathname}`).toBe(`${origin}/login`);
		expect(location.searchParams.get("error")).toBe("SIGN_UP_CLOSED");
		expect(await isSignedIn(cookie)).toBe(false);
		expect(await rows(email)).toEqual(before);
	});
});

describe("GitHub on a server with a list", () => {
	it("admits a listed address GitHub verified", async () => {
		await expectAdmitted("grace@study.example", () => throughGitHub("grace@study.example"));
	});

	it("refuses an address that is not on the list, and leaves nothing behind", async () => {
		await expectRefused("stranger-github@elsewhere.example", () =>
			throughGitHub("stranger-github@elsewhere.example"),
		);
	});

	it("refuses an address that only looks listed", async () => {
		await expectRefused("x@evilstudy.example", () => throughGitHub("x@evilstudy.example"));
	});

	it("refuses a listed address GitHub did not verify", async () => {
		await expectRefused("unproved-github@study.example", () =>
			throughGitHub("unproved-github@study.example", false),
		);
	});
});

describe("someone who has an account, on a server with a list that does not name them", () => {
	it("still signs in with their password", async () => {
		const email = "password-before@elsewhere.example";
		expect((await signUp(email, OPEN)).status).toBe(200);

		const response = await authApi("/sign-in/email", { email, password: PASSWORD });
		expect(response.status).toBe(200);
		expect(await isSignedIn(cookieOf(response))).toBe(true);
	});

	it("still signs in through the provider", async () => {
		const email = "provider-before@elsewhere.example";
		subjects += 1;
		const person = { sub: `subject-${subjects}`, name: "Pat", email, email_verified: true };
		// Their account was made while the server had no list.
		await expectAdmitted(email, () =>
			through("oidc", (url) => provider.grant(url, person), { isolate: OPEN }),
		);
		const made = await rows(email);

		const { location, cookie } = await through("oidc", (url) => provider.grant(url, person));
		expect(location.pathname).toBe("/");
		expect(await isSignedIn(cookie)).toBe(true);
		expect((await rows(email)).users).toBe(made.users);
	});
});

describe("an invitation on a server with a list", () => {
	it("lets the invited address in through the provider that verified it, though no list names it", async () => {
		await invite("invited-oidc@elsewhere.example", "invites-oidc");
		await expectAdmitted("invited-oidc@elsewhere.example", () =>
			throughProvider("Invited-OIDC@elsewhere.example"),
		);
	});

	it("lets the invited address in through GitHub, which verified it", async () => {
		await invite("invited-github@elsewhere.example", "invites-github");
		await expectAdmitted("invited-github@elsewhere.example", () =>
			throughGitHub("invited-github@elsewhere.example"),
		);
	});

	it("lets it in through neither when they did not verify it", async () => {
		const email = "invited-unproved@elsewhere.example";
		await invite(email, "invites-unproved");
		await expectRefused(email, () => throughProvider(email, { email_verified: false }));
		await expectRefused(email, () => throughGitHub(email, false));
	});

	it("lets nobody else in", async () => {
		await invite("invited-one@elsewhere.example", "invites-one");
		for (const email of ["invited-two@elsewhere.example", "xinvited-one@elsewhere.example"]) {
			await expectRefused(email, () => throughProvider(email));
		}
	});

	it("lets nobody in once it has expired, was withdrawn or was used", async () => {
		for (const [state, change] of [
			["expired", "expires_at = 1000"],
			["canceled", "status = 'canceled'"],
			["accepted", "status = 'accepted'"],
		] as const) {
			const email = `invited-${state}@elsewhere.example`;
			const id = await invite(email, `invites-${state}`);
			await mail.db.prepare(`UPDATE invitation SET ${change} WHERE id = ?`).bind(id).run();
			await expectRefused(email, () => throughProvider(email));
		}
	});
});

describe("a setting that is there with nothing in it", () => {
	it("closes the form, rather than opening the server", async () => {
		await expectFormRefused("anyone-at-all@elsewhere.example", EMPTIED);
	});

	it("names nobody, so a verified address gets in only by an invitation", async () => {
		await expectRefused("ada@example.com.example", () =>
			throughProvider("ada@example.com.example", {}, { isolate: EMPTIED }),
		);
		await invite("invited-emptied@elsewhere.example", "invites-emptied");
		await expectAdmitted("invited-emptied@elsewhere.example", () =>
			throughProvider("invited-emptied@elsewhere.example", {}, { isolate: EMPTIED }),
		);
	});

	it("says on the sign-in page that sign-up is closed", async () => {
		const html = await page("/login", EMPTIED);
		expect(html).toContain(CLOSED_WORDS);
		expect(html).not.toContain("Create an account");
	});

	it("tells whoever runs the server, who may have meant to open it", async () => {
		const told = mail.logs.filter(({ message }) => message.includes("names nobody"));
		expect(told.length).toBeGreaterThan(0);
		for (const { level, message } of told) {
			expect(level).toBe("warn");
			expect(message).toContain("SIGN_UP_ALLOW");
			expect(message).toContain("Remove the setting to open sign-up");
		}
	});
});

describe("what the closed answer does and does not hide", () => {
	it("sends someone whose address has an account they cannot be linked to back with another code", async () => {
		// Not hidden from whoever a provider vouches for: Better Auth answers before any account
		// would be made. The address has a password and has not been verified here.
		const email = "has-password@elsewhere.example";
		expect((await signUp(email, OPEN)).status).toBe(200);
		const before = await rows(email);

		const { location, cookie } = await throughProvider(email);
		expect(location.pathname).toBe("/login");
		expect(location.searchParams.get("error")).toBe("account_not_linked");
		expect(await isSignedIn(cookie)).toBe(false);
		expect(await rows(email)).toEqual(before);
	});

	it("reads the same on the sign-in page either way", async () => {
		const closed = alertOf(await page("/login?error=SIGN_UP_CLOSED"));
		expect(closed).toBe(CLOSED_WORDS);
		expect(alertOf(await page("/login?error=account_not_linked"))).toBe(closed);
	});

	it("still tells someone on a server without a list why their account was not linked", async () => {
		expect(alertOf(await page("/login?error=account_not_linked", OPEN))).toContain(
			"already has an account",
		);
	});
});

describe("the sign-in page", () => {
	it("says accounts are by invitation, links to where to ask, and offers no sign-up", async () => {
		const html = await page("/login");
		expect(html).toContain(CLOSED_WORDS);
		expect(html).toContain(`href="${ASK}"`);
		expect(html).toContain("Ask for access");
		expect(html).not.toContain("Create an account");
		expect(html).toContain("Continue with Gateweave");
	});

	it("offers no sign-up to someone an invitation's old link sent either", async () => {
		const html = await page("/login?mode=sign-up&email=invited%40elsewhere.example");
		expect(html).not.toContain("Create your account");
		expect(html).not.toContain("Create an account");
		expect(html).toContain("Sign in to Gateweave Mail");
		expect(html).toContain(
			"Invited? Continue with Gateweave or GitHub, under the address your invitation names.",
		);
	});

	it("has words for someone a provider sent back refused", async () => {
		const html = await page("/login?error=SIGN_UP_CLOSED&error_description=Anything+at+all");
		expect(alertOf(html)).toBe(CLOSED_WORDS);
		expect(html).not.toContain("Anything at all");
	});

	it("is as it always was on a server without a list", async () => {
		const html = await page("/login", OPEN);
		expect(html).toContain("Create an account");
		expect(html).not.toContain("by invitation");
		expect(html).not.toContain("Ask for access");
		expect(await page("/login?mode=sign-up", OPEN)).toContain("Create your account");
	});
});

describe("an invitation's page", () => {
	it("sends someone new to sign in, not to a form that would refuse them", async () => {
		const id = await invite("invited-page@elsewhere.example", "invites-page");
		const html = await page(`/invite/${id}`);
		expect(html).toContain("invited-page@elsewhere.example");
		expect(html).not.toContain("Create an account");
		expect(html).toContain("continue with the sign-in provider");
	});

	it("is as it always was on a server without a list", async () => {
		const id = await invite("invited-open-page@elsewhere.example", "invites-open-page");
		expect(await page(`/invite/${id}`, OPEN)).toContain("Create an account");
	});
});

describe("a server without the setting", () => {
	it("takes anyone's sign-up, as before", async () => {
		const response = await signUp("anyone@elsewhere.example", OPEN);
		expect(response.status).toBe(200);
		expect(await isSignedIn(cookieOf(response))).toBe(true);
	});

	it("lets an invited address make its account with a password, as before", async () => {
		await invite("invited-open@elsewhere.example", "invites-open");
		expect((await signUp("invited-open@elsewhere.example", OPEN)).status).toBe(200);
	});

	it("takes anyone the provider knows, verified there or not", async () => {
		await expectAdmitted("unverified-open@elsewhere.example", () =>
			throughProvider(
				"unverified-open@elsewhere.example",
				{ email_verified: false },
				{ isolate: OPEN },
			),
		);
	});

	it("still says so when an address has an account", async () => {
		expect((await signUp("twice@elsewhere.example", OPEN)).status).toBe(200);
		const again = await signUp("twice@elsewhere.example", OPEN);
		expect(again.status).toBe(422);
		expect(await again.json()).toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
	});
});

describe("the list itself", () => {
	it("tells whoever runs the server how many entries it could not use, and not which", async () => {
		const told = mail.logs.filter(({ message }) => message.includes("ignored"));
		expect(told.length).toBeGreaterThan(0);
		for (const { level, message } of told) {
			expect(level).toBe("warn");
			expect(message).toContain("SIGN_UP_ALLOW: ignored 1 of its entries");
			expect(message).not.toContain("not-an-entry");
			expect(message.toLowerCase()).not.toContain("ada@example.com");
		}
	});
});
