import { afterAll, beforeAll, expect, it } from "vitest";
import { startMail } from "./mail-worker";
import { fromWorkerOn, whileJunkGoesOn } from "./workers";

// Better Auth turns its limiter on only when NODE_ENV is "production", which a Worker never sets,
// so the deployed app took unlimited password guesses (TRK-23). Once on, it counted in each
// isolate's memory, so every isolate gave an attacker a fresh allowance (TRK-24).

const origin = "https://mail.test";

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin, { isolates: 2 });
});

afterAll(async () => {
	await mail?.dispose();
});

async function signIn(headers: Record<string, string>, isolate = 0) {
	const response = await mail.fetchIn(isolate, `${origin}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, ...headers },
		body: JSON.stringify({ email: "nobody@example.com", password: "not-the-password" }),
	});
	return response.status;
}

it("limits sign-in attempts from one client", async () => {
	const client = { "cf-connecting-ip": "203.0.113.7" };
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) statuses.push(await signIn(client));
	expect(statuses).toEqual([401, 401, 401, 429]);

	expect(await signIn({ "cf-connecting-ip": "203.0.113.8" })).toBe(401);
});

it("tells clients apart by the address Cloudflare saw, not one they claim", async () => {
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		statuses.push(
			await signIn({
				"cf-connecting-ip": "198.51.100.20",
				"x-forwarded-for": `192.0.2.${attempt + 1}`,
			}),
		);
	}
	expect(statuses).toEqual([401, 401, 401, 429]);
});

it("counts a client's attempts in every isolate together", async () => {
	const client = { "cf-connecting-ip": "203.0.113.30" };
	const statuses = [];
	for (const isolate of [0, 1, 0, 1]) statuses.push(await signIn(client, isolate));
	expect(statuses).toEqual([401, 401, 401, 429]);
	// Had the Durable Object failed, each isolate would have fallen back to its own count.
	expect(mail.logs.filter((log) => log.message.startsWith("rate limit:"))).toEqual([]);
});

it("counts Workers on different zones apart", async () => {
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		statuses.push(await signIn(fromWorkerOn("one.example")));
	}
	expect(statuses).toEqual([401, 401, 401, 429]);
	expect(await signIn(fromWorkerOn("other.example"))).toBe(401);
});

it("gives nobody a way out of a limit by saying they are a Worker", async () => {
	const statuses = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		statuses.push(
			await signIn({ "cf-connecting-ip": "203.0.113.60", "cf-worker": `zone-${attempt}.example` }),
		);
	}
	expect(statuses).toEqual([401, 401, 401, 429]);
});

it("counts Workers on different zones apart for a read from Better Auth", async () => {
	const get = (zone: string) =>
		mail.fetchIn(0, `${origin}/api/auth/get-session`, { headers: fromWorkerOn(zone) });
	const { answer, statuses } = await whileJunkGoesOn(
		() => get("junk.example"),
		110,
		() => get("other.example"),
	);
	expect(statuses).toContain(429);
	expect(answer.status).not.toBe(429);
});

it("limits how fast one client creates workspaces", async () => {
	const client = { "cf-connecting-ip": "203.0.113.40" };
	const signedUp = await mail.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, ...client },
		body: JSON.stringify({ name: "Busy", email: "busy@example.com", password: "a-long-password" }),
	});
	expect(signedUp.status).toBe(200);
	const cookie = signedUp.headers
		.getSetCookie()
		.map((header) => header.split(";")[0])
		.join("; ");

	const statuses = [];
	for (let n = 0; n < 11; n++) {
		const response = await mail.fetch(`${origin}/api/auth/organization/create`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, cookie, ...client },
			body: JSON.stringify({ name: `Workspace ${n}`, slug: `busy-${n}` }),
		});
		statuses.push(response.status);
	}
	expect(statuses).toEqual([...Array(10).fill(200), 429]);
});
