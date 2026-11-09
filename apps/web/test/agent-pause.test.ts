import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "./accounts";
import { agentWorld } from "./agent-world";

// Pausing an agent, through the built Worker in workerd: its key does nothing anywhere until an
// owner or admin resumes it, and what it wrote that waits to be tried again goes to a person.

const origin = "https://mail.test";

const world = agentWorld(origin, "pause");
const { workspace, agentOf, auth, arrive } = world;

beforeAll(() => world.start());
afterAll(() => world.dispose());

const PAUSED = /^This agent is paused\. An owner or admin of its workspace can resume it/;

type Space = Awaited<ReturnType<typeof workspace>>;

/** Asks the agent API with a key: what a route takes besides its path, in a JSON body. */
async function rest(key: string, method: string, path: string, data?: Record<string, unknown>) {
	const response = await world.mail.fetch(`${origin}/api/v1${path}`, {
		method,
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	});
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown> & { error?: string },
	};
}

/** Opens an MCP session with a key, and says how the server answered. */
async function mcp(key: string) {
	const response = await world.mail.fetch(`${origin}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${key}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "pause-test", version: "1.0.0" },
			},
		}),
	});
	const text = await response.text();
	return { status: response.status, text };
}

interface Listed {
	id: string;
	paused: { at: number; by: string | null } | null;
}

async function listed(space: Space, agentId: string): Promise<Listed | undefined> {
	const response = await world.mail.fetch(
		`${origin}/api/auth/agents/list?organizationId=${space.workspaceId}`,
		{ headers: world.owner.headers },
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as Listed[]).find((one) => one.id === agentId);
}

/** What became of a message the workspace sent, as its thread shows it to the owner. */
async function stateOf(space: Space, threadId: string): Promise<string | undefined> {
	const response = await world.mail.fetch(
		`${origin}/api/mail/${space.slug}/${space.signUps.id}/threads/${threadId}`,
		{ headers: world.owner.headers },
	);
	expect(response.status).toBe(200);
	const page = (await response.json()) as {
		messages: { sent?: { status?: { state: string } } }[];
	};
	return page.messages[0]?.sent?.status?.state;
}

describe("pausing an agent", () => {
	it("is for owners and admins, and its page says who did it and when", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const before = Date.now();
		const paused = await auth("/agents/pause", { agentId: agent.id });
		expect(paused.status).toBe(200);
		const { paused: pause } = (await paused.json()) as { paused: Listed["paused"] };
		expect(pause).toEqual({ at: expect.any(Number), by: "Owner" });
		expect(pause?.at).toBeGreaterThanOrEqual(before - 1000);
		expect((await listed(space, agent.id))?.paused).toEqual(pause);

		// Paused again, it stays paused as it first was.
		expect((await auth("/agents/pause", { agentId: agent.id })).status).toBe(200);
		expect((await listed(space, agent.id))?.paused).toEqual(pause);

		// Nobody else may resume it: not the agent with its own key, nor someone outside the workspace.
		const asAgent = await world.mail.fetch(`${origin}/api/auth/agents/resume`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${agent.key}`,
				origin,
				"content-type": "application/json",
			},
			body: JSON.stringify({ agentId: agent.id }),
		});
		expect(asAgent.status).toBe(401);
		const stranger = await signUp(world.mail, origin, "Stranger");
		for (const path of ["/agents/resume", "/agents/pause"]) {
			const theirs = await world.mail.fetch(`${origin}/api/auth${path}`, {
				method: "POST",
				headers: { ...stranger.headers, origin, "content-type": "application/json" },
				body: JSON.stringify({ agentId: agent.id }),
			});
			expect(theirs.status).toBe(403);
		}
		expect((await listed(space, agent.id))?.paused).toEqual(pause);

		expect((await auth("/agents/resume", { agentId: agent.id })).status).toBe(200);
		expect((await listed(space, agent.id))?.paused).toBeNull();
	});

	it("stops its key on every way in, keeps its mail arriving, and resuming gives it back", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const box = `/mailboxes/${space.signUps.id}`;
		const made = await rest(agent.key, "POST", `${box}/addresses`, {
			domain: space.domain,
			localPart: "paused-agent",
			days: 2,
		});
		expect(made.status).toBe(200);
		expect((await auth("/agents/pause", { agentId: agent.id })).status).toBe(200);

		for (const [method, path, data] of [
			["GET", "/mailboxes", undefined],
			["GET", `${box}/threads`, undefined],
			["POST", `${box}/messages`, { to: ["ada@example.org"], subject: "Hi", text: "Hi." }],
			["POST", `${box}/addresses`, { domain: space.domain, localPart: "another", days: 1 }],
			["GET", "/webhooks", undefined],
		] as const) {
			const answer = await rest(agent.key, method, path, data);
			expect(answer.status, `${method} ${path}`).toBe(403);
			expect(answer.body.error).toMatch(PAUSED);
		}
		const session = await mcp(agent.key);
		expect(session.status).toBe(403);
		expect(JSON.parse(session.text).error.message).toMatch(PAUSED);
		// The app's own routes know it no more than a revoked key.
		for (const path of [
			`/api/directory/${space.slug}`,
			`/api/mail/${space.slug}/${space.signUps.id}/threads`,
		]) {
			const own = await world.mail.fetch(`${origin}${path}`, {
				headers: { authorization: `Bearer ${agent.key}` },
			});
			expect(own.status, path).toBe(404);
		}

		// Mail to the address it made still arrives, for people to read.
		await arrive(`paused-agent@${space.domain}`, { subject: "While it was paused" });
		const threads = await world.mail.fetch(
			`${origin}/api/mail/${space.slug}/${space.signUps.id}/threads`,
			{ headers: world.owner.headers },
		);
		expect(JSON.stringify(await threads.json())).toContain("While it was paused");

		expect((await auth("/agents/resume", { agentId: agent.id })).status).toBe(200);
		expect((await rest(agent.key, "GET", "/mailboxes")).status).toBe(200);
		expect((await mcp(agent.key)).status).toBe(200);
	});

	it("puts what it wrote that waits to be tried again in a person's hands", {
		timeout: 60_000,
	}, async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		const policy = await auth("/agents/set-policy", {
			agentId: agent.id,
			sendPerDay: 20,
			allowed: [`@${domain}`],
		});
		expect(policy.status).toBe(200);
		// Email Service is busy the first time, so it waits to be tried again by itself.
		const to = `busy-1@${domain}`;
		const sent = await rest(agent.key, "POST", `/mailboxes/${space.signUps.id}/messages`, {
			to: [to],
			subject: "Waiting",
			text: "Hello.",
		});
		expect(sent.body).toMatchObject({ state: "waiting" });
		const { id, threadId } = sent.body as { id: string; threadId: string };
		expect((await auth("/agents/pause", { agentId: agent.id })).status).toBe(200);

		let state = await stateOf(space, threadId);
		for (let waited = 0; state === "waiting" && waited < 40_000; waited += 1_000) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			state = await stateOf(space, threadId);
		}
		expect(state).toBe("held");
		const sentTo = async () =>
			(await world.mail.emails()).filter((email) => [email.to].flat().includes(to));
		expect(await sentTo()).toEqual([]);

		// A person may still approve it, while the agent stays paused.
		const approved = await world.mail.fetch(
			`${origin}/api/mail/${space.slug}/${space.signUps.id}/outbox`,
			{
				method: "POST",
				headers: { ...world.owner.headers, origin, "content-type": "application/json" },
				body: JSON.stringify({ action: "approve", message: id }),
			},
		);
		expect(await approved.json()).toMatchObject({ ok: true, state: "sent" });
		expect(await sentTo()).toHaveLength(1);
		expect((await listed(space, agent.id))?.paused).not.toBeNull();
	});

	it("holds what it wrote once it is deleted too, but lets go what a person approved", {
		timeout: 60_000,
	}, async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		const policy = await auth("/agents/set-policy", {
			agentId: agent.id,
			sendPerDay: 20,
			allowed: [`@${domain}`],
		});
		expect(policy.status).toBe(200);
		const send = async (to: string) => {
			const sent = await rest(agent.key, "POST", `/mailboxes/${space.signUps.id}/messages`, {
				to: [to],
				subject: "Waiting",
				text: "Hello.",
			});
			return sent.body as { id: string; threadId: string; state: string };
		};
		// Its own: Email Service is busy the first time, so it waits to be tried again by itself.
		const own = `busy-1@${domain}`;
		const waiting = await send(own);
		expect(waiting.state).toBe("waiting");
		// One its policy holds, which a person approves, and which then waits in the same way.
		const theirs = `busy-1@elsewhere-${space.slug}.example.org`;
		const held = await send(theirs);
		expect(held.state).toBe("held");
		const approved = await world.mail.fetch(
			`${origin}/api/mail/${space.slug}/${space.signUps.id}/outbox`,
			{
				method: "POST",
				headers: { ...world.owner.headers, origin, "content-type": "application/json" },
				body: JSON.stringify({ action: "approve", message: held.id }),
			},
		);
		expect(await approved.json()).toMatchObject({ ok: true, state: "waiting" });

		// Paused, then deleted, which takes its pause with it.
		expect((await auth("/agents/pause", { agentId: agent.id })).status).toBe(200);
		expect((await auth("/agents/delete", { agentId: agent.id })).status).toBe(200);

		const states = async () =>
			[await stateOf(space, waiting.threadId), await stateOf(space, held.threadId)] as const;
		let now = await states();
		for (let waited = 0; now.includes("waiting") && waited < 40_000; waited += 1_000) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			now = await states();
		}
		expect(now).toEqual(["held", "sent"]);
		const sentTo = async (to: string) =>
			(await world.mail.emails()).filter((email) => [email.to].flat().includes(to));
		expect(await sentTo(own)).toEqual([]);
		expect(await sentTo(theirs)).toHaveLength(1);
	});

	it("tells a request that was waiting for mail that it was paused, not that its key went", {
		timeout: 30_000,
	}, async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const waiting = rest(agent.key, "GET", `/wait?mailbox=${space.signUps.id}&timeoutSeconds=20`);
		// Long enough for it to have looked once and gone to sleep.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect((await auth("/agents/pause", { agentId: agent.id })).status).toBe(200);
		const answer = await waiting;
		expect(answer.status).toBe(403);
		expect(answer.body.error).toMatch(PAUSED);
	});
});
