import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMail } from "./mail-worker";

// Mail signs people in with GitHub and never acts for them with that token, so one in its database
// could only ever be a liability.

const origin = "https://mail.test";
const SECRET = "github-secret-for-tests";

let mail: Awaited<ReturnType<typeof startMail>>;
let clients = 0;

/** GitHub's side of the sign-in: the code becomes a token, here the same text as the code. */
async function gitHubTokens(request: Request) {
	const form = new URLSearchParams(await request.text());
	if (form.get("client_secret") !== SECRET) {
		return Response.json({ error: "incorrect_client_credentials" });
	}
	return Response.json({
		access_token: form.get("code"),
		refresh_token: "a-refresh-token",
		expires_in: 28800,
		refresh_token_expires_in: 15811200,
		token_type: "bearer",
		scope: "user:email",
	});
}

/** GitHub's API, which knows who someone is from that token. */
function gitHubApi(request: Request) {
	const id = Number((request.headers.get("authorization") ?? "").replace("Bearer ", ""));
	const email = `github-${id}@example.com`;
	if (new URL(request.url).pathname === "/user") {
		return Response.json({
			id,
			login: `person-${id}`,
			name: "Grace Hopper",
			email,
			avatar_url: `https://avatars.githubusercontent.com/u/${id}`,
		});
	}
	return Response.json([{ email, primary: true, verified: true }]);
}

beforeAll(async () => {
	mail = await startMail(origin, {
		settings: { GITHUB_CLIENT_ID: "github-client-for-tests", GITHUB_CLIENT_SECRET: SECRET },
		hosts: { "github.com": gitHubTokens, "api.github.com": gitHubApi },
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

/** The whole way to GitHub and back, as the person with this id. Returns who Mail says they are. */
async function signIn(id: number) {
	clients += 1;
	const client = `198.51.100.${clients}`;
	const pressed = await mail.fetch(`${origin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": client, "content-type": "application/json" },
		body: JSON.stringify({ provider: "github", callbackURL: "/" }),
	});
	expect(pressed.status).toBe(200);
	const { url } = (await pressed.json()) as { url: string };
	const state = new URL(url).searchParams.get("state") ?? "";

	const query = new URLSearchParams({ code: String(id), state });
	const back = await mail.fetch(`${origin}/api/auth/callback/github?${query}`, {
		headers: { cookie: cookieOf(pressed), "cf-connecting-ip": client },
	});
	expect(back.status).toBe(302);

	const session = await mail.fetch(`${origin}/api/auth/get-session`, {
		headers: { cookie: cookieOf(back), "cf-connecting-ip": client },
	});
	return (await session.json()) as { user: { id: string; email: string } } | null;
}

function gitHubAccount(id: number) {
	return mail.db
		.prepare("SELECT * FROM account WHERE provider_id = 'github' AND account_id = ?")
		.bind(String(id))
		.first<Record<string, unknown>>();
}

const NO_TOKENS = {
	access_token: null,
	refresh_token: null,
	id_token: null,
	access_token_expires_at: null,
	refresh_token_expires_at: null,
};

describe("signing in with GitHub", () => {
	it("keeps none of GitHub's tokens, the first time or the next", async () => {
		const first = await signIn(101);
		expect(first?.user.email).toBe("github-101@example.com");
		expect(await gitHubAccount(101)).toMatchObject(NO_TOKENS);

		const next = await signIn(101);
		expect(next?.user.id).toBe(first?.user.id);
		expect(await gitHubAccount(101)).toMatchObject(NO_TOKENS);
	});

	it("keeps the picture GitHub gives", async () => {
		const { user } = (await signIn(103)) as { user: { id: string } };
		const row = await mail.db
			.prepare("SELECT image FROM user WHERE id = ?")
			.bind(user.id)
			.first<{ image: string | null }>();
		expect(row).toEqual({ image: "https://avatars.githubusercontent.com/u/103" });
	});
});
