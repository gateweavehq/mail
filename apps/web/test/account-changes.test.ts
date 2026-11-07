import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMail } from "./mail-worker";

// Changing a name or a password on the account page (AGT-97). The cookie behind either request may
// be a stolen one, so a rename can reach a name and nothing else, and a new password needs the old
// one, a limit on guesses, and an email to the person.

const origin = "https://mail.test";
const PASSWORD = "a-long-test-password";
const NEW_PASSWORD = "another-long-test-password";

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin);
});

afterAll(async () => {
	await mail?.dispose();
});

let clients = 0;
/** Each test counts as its own client, so that rate limits stay out of what it is about. */
const newClient = () => `203.0.113.${++clients}`;

function authApi(path: string, init: { client: string; cookie?: string; body?: object }) {
	return mail.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			"content-type": "application/json",
			...(init.cookie && { cookie: init.cookie }),
		},
		body: JSON.stringify(init.body ?? {}),
	});
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

async function signUp(client: string, name: string, email: string) {
	const response = await authApi("/sign-up/email", {
		client,
		body: { name, email, password: PASSWORD },
	});
	expect(response.status).toBe(200);
	const { user } = (await response.json()) as { user: { id: string } };
	return { id: user.id, email, cookie: cookieOf(response) };
}

function signIn(client: string, email: string, password: string) {
	return authApi("/sign-in/email", { client, body: { email, password } });
}

/** Who a cookie is signed in as, if anyone. */
async function sessionOf(cookie: string) {
	const response = await mail.fetch(`${origin}/api/auth/get-session`, {
		headers: { origin, cookie, "cf-connecting-ip": "203.0.113.250" },
	});
	return (await response.json()) as { user: { name: string } } | null;
}

function userRow(id: string) {
	return mail.db
		.prepare("SELECT name, image FROM user WHERE id = ?")
		.bind(id)
		.first<{ name: string; image: string | null }>();
}

const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

describe("changing a name", () => {
	it("changes it for what comes next", async () => {
		const client = newClient();
		const person = await signUp(client, "Remy", "remy@account.test");
		const renamed = await authApi("/update-user", {
			client,
			cookie: person.cookie,
			body: { name: "Remy Rivers" },
		});
		expect(renamed.status).toBe(200);
		expect((await userRow(person.id))?.name).toBe("Remy Rivers");
		expect((await sessionOf(person.cookie))?.user.name).toBe("Remy Rivers");
	});

	it("keeps it without the spaces around it", async () => {
		const client = newClient();
		const person = await signUp(client, "Sana", "sana@account.test");
		const renamed = await authApi("/update-user", {
			client,
			cookie: person.cookie,
			body: { name: "  Sana Sol  " },
		});
		expect(renamed.status).toBe(200);
		expect((await userRow(person.id))?.name).toBe("Sana Sol");
	});

	// The picture is an address other members' browsers fetch, so this is not only about tidiness.
	it.each([
		["a picture beside it", { name: "Taken", image: "https://elsewhere.test/a.png" }],
		["a picture alone", { image: "https://elsewhere.test/a.png" }],
		["an address", { name: "Taken", email: "other@account.test" }],
		["a verified address", { name: "Taken", emailVerified: true }],
		["no name at all", {}],
	])("takes nothing but a name: %s", async (_what, body) => {
		const client = newClient();
		const person = await signUp(client, "Tess", `tess-${client}@account.test`);
		const refused = await authApi("/update-user", { client, cookie: person.cookie, body });
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("INVALID_NAME");
		expect(await userRow(person.id)).toEqual({ name: "Tess", image: null });
	});

	it.each([
		["empty", ""],
		["only spaces", "   "],
		["too long", "x".repeat(101)],
		["not text", 42],
	])("refuses one that is %s", async (_what, name) => {
		const client = newClient();
		const person = await signUp(client, "Uma", `uma-${client}@account.test`);
		const refused = await authApi("/update-user", {
			client,
			cookie: person.cookie,
			body: { name },
		});
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("INVALID_NAME");
		expect((await userRow(person.id))?.name).toBe("Uma");
	});

	it("takes the longest one it allows", async () => {
		const client = newClient();
		const person = await signUp(client, "Vic", "vic@account.test");
		const longest = "x".repeat(100);
		const renamed = await authApi("/update-user", {
			client,
			cookie: person.cookie,
			body: { name: longest },
		});
		expect(renamed.status).toBe(200);
		expect((await userRow(person.id))?.name).toBe(longest);
	});

	it("stops at ten a minute", async () => {
		const client = newClient();
		const person = await signUp(client, "Wes", "wes@account.test");
		const rename = (name: string) =>
			authApi("/update-user", { client, cookie: person.cookie, body: { name } });
		for (let tries = 0; tries < 10; tries++) {
			expect((await rename(`Wes ${tries}`)).status).toBe(200);
		}
		expect((await rename("Wes again")).status).toBe(429);
		expect((await userRow(person.id))?.name).toBe("Wes 9");
	});

	it("needs a session", async () => {
		const refused = await authApi("/update-user", {
			client: newClient(),
			body: { name: "Nobody" },
		});
		expect(refused.status).toBe(401);
	});
});

describe("signing up", () => {
	it.each([
		["only spaces", "   "],
		["too long", "x".repeat(101)],
	])("refuses a name that is %s, as renaming does", async (_what, name) => {
		const client = newClient();
		const email = `name-${client}@account.test`;
		const refused = await authApi("/sign-up/email", {
			client,
			body: { name, email, password: PASSWORD },
		});
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("INVALID_NAME");
		expect((await signIn(newClient(), email, PASSWORD)).status).toBe(401);
	});

	it("keeps a name without the spaces around it", async () => {
		const person = await signUp(newClient(), "  Xan  ", "xan@account.test");
		expect((await userRow(person.id))?.name).toBe("Xan");
	});
});

describe("changing a password", () => {
	const change = (
		client: string,
		cookie: string,
		currentPassword: string,
		newPassword: string,
		rest: object = {},
	) =>
		authApi("/change-password", {
			client,
			cookie,
			body: { currentPassword, newPassword, ...rest },
		});

	const toldAbout = async (email: string) =>
		(await mail.emails()).filter(
			(each) => each.to === email && each.subject === "Your Gateweave Mail password was changed",
		);

	it("needs the current one, and leaves everything as it was without it", async () => {
		const client = newClient();
		const person = await signUp(client, "Yara", "yara@account.test");
		const refused = await change(client, person.cookie, "not-the-password", NEW_PASSWORD);
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("INVALID_PASSWORD");

		expect(await sessionOf(person.cookie)).not.toBeNull();
		expect((await signIn(newClient(), person.email, PASSWORD)).status).toBe(200);
		expect((await signIn(newClient(), person.email, NEW_PASSWORD)).status).toBe(401);
		expect(await toldAbout(person.email)).toEqual([]);
	});

	// Someone holding a stolen cookie would otherwise have a way to guess at the password.
	it("stops counting guesses at five a minute", async () => {
		const client = newClient();
		const person = await signUp(client, "Zed", "zed@account.test");
		const guess = () => change(client, person.cookie, "a-guess", NEW_PASSWORD);
		for (let tries = 0; tries < 5; tries++) expect((await guess()).status).toBe(400);
		expect((await guess()).status).toBe(429);
		expect((await signIn(newClient(), person.email, PASSWORD)).status).toBe(200);
	});

	it("refuses a new one that is too short", async () => {
		const client = newClient();
		const person = await signUp(client, "Abe", "abe@account.test");
		const refused = await change(client, person.cookie, PASSWORD, "short");
		expect(refused.status).toBe(400);
		expect(await codeOf(refused)).toBe("PASSWORD_TOO_SHORT");
		expect((await signIn(newClient(), person.email, PASSWORD)).status).toBe(200);
	});

	it("needs a session", async () => {
		const refused = await authApi("/change-password", {
			client: newClient(),
			body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
		});
		expect(refused.status).toBe(401);
	});

	it("lets them sign in with the new one and not the old", async () => {
		const client = newClient();
		const person = await signUp(client, "Bea", "bea@account.test");
		const changed = await change(client, person.cookie, PASSWORD, NEW_PASSWORD);
		expect(changed.status).toBe(200);
		expect((await signIn(newClient(), person.email, PASSWORD)).status).toBe(401);
		expect((await signIn(newClient(), person.email, NEW_PASSWORD)).status).toBe(200);
	});

	it("ends every other session, and keeps this browser signed in", async () => {
		const client = newClient();
		const person = await signUp(client, "Cal", "cal@account.test");
		const elsewhere = cookieOf(await signIn(newClient(), person.email, PASSWORD));

		const changed = await change(client, person.cookie, PASSWORD, NEW_PASSWORD);
		expect(changed.status).toBe(200);

		expect(await sessionOf(elsewhere)).toBeNull();
		expect(await sessionOf(person.cookie)).toBeNull();
		expect(await sessionOf(cookieOf(changed))).not.toBeNull();
	});

	// Whoever knew the old password may be why it is changing, and may be the one asking.
	it("ends other sessions even when the request asks to keep them", async () => {
		const client = newClient();
		const person = await signUp(client, "Dov", "dov@account.test");
		const elsewhere = cookieOf(await signIn(newClient(), person.email, PASSWORD));
		const changed = await change(client, person.cookie, PASSWORD, NEW_PASSWORD, {
			revokeOtherSessions: false,
		});
		expect(changed.status).toBe(200);
		expect(await sessionOf(elsewhere)).toBeNull();
	});

	it("tells the person by email, without the password", async () => {
		const client = newClient();
		const person = await signUp(client, "Eda", "eda@account.test");
		expect((await change(client, person.cookie, PASSWORD, NEW_PASSWORD)).status).toBe(200);
		await vi.waitFor(async () => expect(await toldAbout(person.email)).toHaveLength(1));
		const [sent] = await toldAbout(person.email);
		expect(JSON.stringify(sent)).not.toContain(NEW_PASSWORD);
	});
});
