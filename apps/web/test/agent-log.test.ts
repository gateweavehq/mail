import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "./accounts";
import { agentWorld } from "./agent-world";

// An agent's log, through the built Worker in workerd: what the agent did with its key, over the
// agent API, and what people did to it, for the workspace's owners and admins only, kept 90 days.

const origin = "https://mail.test";
const RECEIVER = "hooks.example";
const DAY = 24 * 60 * 60 * 1000;

const world = agentWorld(origin, "log");
const { workspace, agentOf, auth, arrive } = world;

beforeAll(() => world.start({ [RECEIVER]: () => new Response("ok") }));
afterAll(() => world.dispose());

type Space = Awaited<ReturnType<typeof workspace>>;

interface Entry {
	id: string;
	at: number;
	action: string;
	by: { agent: true } | { agent: false; name: string | null };
	mailbox: { id: string; name: string | null } | null;
	target: string | null;
	subject: string | null;
	detail: string | null;
	thread: string | null;
}

interface Page {
	entries: Entry[];
	next: { at: number; id: string } | null;
}

/** Asks the agent API with a key, a GET's input in its query. */
async function asAgent(key: string, method: string, path: string, data: object = {}) {
	const url = new URL(`${origin}/api/v1${path}`);
	const json = method === "POST" || method === "PATCH";
	if (!json) {
		for (const [name, value] of Object.entries(data)) url.searchParams.set(name, String(value));
	}
	const response = await world.mail.fetch(url.href, {
		method,
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		...(json ? { body: JSON.stringify(data) } : {}),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Asks a mailbox's outbox as the owner, as the app's page does. */
async function outbox(space: Space, body: object) {
	const response = await world.mail.fetch(
		`${origin}/api/mail/${space.slug}/${space.signUps.id}/outbox`,
		{
			method: "POST",
			headers: { ...world.owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return (await response.json()) as Record<string, unknown>;
}

const logUrl = (space: Space, agentId: string, query = "") =>
	`${origin}/api/agents/${space.slug}/${agentId}/log${query}`;

async function log(space: Space, agentId: string, query = ""): Promise<Page> {
	const response = await world.mail.fetch(logUrl(space, agentId, query), {
		headers: world.owner.headers,
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return (await response.json()) as Page;
}

/** Every entry, oldest first, as each says it happened. */
async function wholeLog(space: Space, agentId: string): Promise<Entry[]> {
	const entries: Entry[] = [];
	let query = "";
	for (;;) {
		const page = await log(space, agentId, query);
		entries.push(...page.entries);
		if (!page.next) break;
		query = `?beforeAt=${page.next.at}&beforeId=${page.next.id}`;
	}
	return entries.reverse();
}

const actionsOf = (entries: Entry[]) => entries.map((entry) => entry.action);

describe("an agent's log", () => {
	it("notes what the agent did with its key and what people did to it, never what mail says", {
		timeout: 90_000,
	}, async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const domain = `${space.slug}.example.org`;
		expect(
			(
				await auth("/agents/set-policy", {
					agentId: agent.id,
					sendPerDay: 20,
					allowed: [`@${domain}`],
				})
			).status,
		).toBe(200);

		// Reading: a code alone, then the message, then a person reading it, which isn't the agent's.
		const secret = "The private words of this message";
		await arrive(space.signUps.address, {
			subject: "Your sign-in code",
			body: `${secret}. Code: 482913`,
		});
		const code = await asAgent(agent.key, "GET", "/verification-code", {
			to: space.signUps.address,
			from: "shop.example",
			timeoutSeconds: 0,
		});
		expect(code.body).toMatchObject({ found: true, code: "482913" });
		const messageId = String(code.body.messageId);
		const box = `/mailboxes/${space.signUps.id}`;
		const read = await asAgent(agent.key, "GET", `${box}/messages/${messageId}`);
		expect(read.status).toBe(200);
		const byPerson = await world.mail.fetch(
			`${origin}/api/mail/${space.slug}/${space.signUps.id}/${messageId}`,
			{ headers: world.owner.headers },
		);
		expect(byPerson.status).toBe(200);

		// Mail: one that goes, one a person approves, one a person rejects, and a reply.
		const sent = await asAgent(agent.key, "POST", `${box}/messages`, {
			to: [`ada@${domain}`],
			subject: "Goes on its own",
			text: "Hello.",
		});
		expect(sent.body).toMatchObject({ state: "sent" });
		const approved = await asAgent(agent.key, "POST", `${box}/messages`, {
			to: [`bo@elsewhere-${space.slug}.example.org`],
			subject: "Approved by a person",
			text: "Hello.",
		});
		expect(approved.body).toMatchObject({ state: "held" });
		expect(await outbox(space, { action: "approve", message: approved.body.id })).toMatchObject({
			ok: true,
		});
		const rejected = await asAgent(agent.key, "POST", `${box}/messages`, {
			to: [`cy@elsewhere-${space.slug}.example.org`],
			subject: "Rejected by a person",
			text: "Hello.",
		});
		expect(rejected.body).toMatchObject({ state: "held" });
		expect(await outbox(space, { action: "discard", message: rejected.body.id })).toMatchObject({
			ok: true,
		});

		// Addresses.
		const made = await asAgent(agent.key, "POST", `${box}/addresses`, {
			domain: space.domain,
			localPart: "logged",
			days: 2,
		});
		expect(made.status).toBe(200);
		const ended = await asAgent(agent.key, "DELETE", `${box}/addresses/${made.body.id}`);
		expect(ended.status).toBe(200);

		// Webhooks: its own changes, and an admin's to its webhook.
		const hook = await asAgent(agent.key, "POST", "/webhooks", {
			url: `https://${RECEIVER}/in?token=receivers-own-token`,
			events: ["message.received"],
		});
		expect(hook.status).toBe(200);
		const hookId = String((hook.body.webhook as { id: string }).id);
		expect(
			(await asAgent(agent.key, "PATCH", `/webhooks/${hookId}`, { active: false })).status,
		).toBe(200);
		const resumed = await world.mail.fetch(`${origin}/api/webhooks/${space.slug}`, {
			method: "POST",
			headers: { ...world.owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify({ action: "update", id: hookId, patch: { active: true } }),
		});
		expect(resumed.status).toBe(200);
		expect((await asAgent(agent.key, "POST", `/webhooks/${hookId}/test`)).status).toBe(200);
		expect((await asAgent(agent.key, "DELETE", `/webhooks/${hookId}`)).status).toBe(200);

		// People: pause, resume, a key made and revoked, a new name, its mailbox taken away.
		expect((await auth("/agents/pause", { agentId: agent.id })).status).toBe(200);
		expect((await auth("/agents/resume", { agentId: agent.id })).status).toBe(200);
		const key = await auth("/agents/create-key", { agentId: agent.id });
		expect(key.status).toBe(200);
		const keyId = ((await key.json()) as { key: { id: string } }).key.id;
		expect((await auth("/agents/revoke-key", { keyId })).status).toBe(200);
		expect((await auth("/agents/update", { agentId: agent.id, name: "Renamed" })).status).toBe(200);
		const taken = await world.directory(space.slug, {
			action: "set-mailbox-access",
			mailboxId: space.signUps.id,
			everyone: false,
			memberIds: [],
			senderIds: [],
		});
		expect(taken.ok).toBe(true);

		const entries = await wholeLog(space, agent.id);
		expect(actionsOf(entries)).toEqual([
			"agent.made",
			"key.made",
			"access.changed",
			"address-policy.changed",
			"policy.changed",
			"code.read",
			"message.read",
			"message.sent",
			"message.held",
			"message.approved",
			"message.held",
			"message.rejected",
			"address.made",
			"address.ended",
			"webhook.made",
			"webhook.changed",
			"webhook.changed",
			"webhook.tested",
			"webhook.deleted",
			"agent.paused",
			"agent.resumed",
			"key.made",
			"key.revoked",
			"agent.renamed",
			"access.changed",
		]);
		const one = (action: string, nth = 0) =>
			entries.filter((entry) => entry.action === action)[nth];
		const owner = { agent: false, name: "Owner" };
		const signUps = { id: space.signUps.id, name: space.signUps.name };
		expect(one("access.changed")).toMatchObject({
			by: owner,
			mailbox: signUps,
			detail: "may read and send",
		});
		expect(one("access.changed", 1)).toMatchObject({ by: owner, detail: "can't read it" });
		expect(one("code.read")).toMatchObject({
			by: { agent: true },
			mailbox: signUps,
			target: messageId,
			subject: "Your sign-in code",
		});
		expect(one("message.read")).toMatchObject({ by: { agent: true }, target: messageId });
		expect(one("message.read")?.thread).toEqual(expect.any(String));
		expect(one("message.sent")).toMatchObject({
			by: { agent: true },
			target: sent.body.id,
			subject: "Goes on its own",
			detail: `ada@${domain}`,
		});
		expect(one("message.approved")).toMatchObject({
			by: owner,
			target: approved.body.id,
			subject: "Approved by a person",
		});
		expect(one("message.rejected")).toMatchObject({ by: owner, target: rejected.body.id });
		expect(one("address.made")).toMatchObject({
			by: { agent: true },
			detail: `logged@${space.domain}`,
		});
		expect(one("address.ended")).toMatchObject({ detail: `logged@${space.domain}` });
		// The host alone: a URL's path and query are the receiver's, and can hold a token.
		expect(one("webhook.made")).toMatchObject({ by: { agent: true }, detail: RECEIVER });
		expect(one("webhook.changed")).toMatchObject({ by: { agent: true }, detail: "paused" });
		expect(one("webhook.changed", 1)).toMatchObject({ by: owner, detail: "resumed" });
		expect(one("agent.renamed")).toMatchObject({ by: owner, detail: "Renamed" });
		expect(one("key.revoked")).toMatchObject({ by: owner, target: keyId });

		// What a message says is never kept, nor a receiver's token.
		const rows = await world.mail.db
			.prepare("SELECT * FROM agent_log WHERE organization_id = ?")
			.bind(space.workspaceId)
			.all();
		expect(rows.results).toHaveLength(entries.length);
		const stored = JSON.stringify(rows.results);
		expect(stored).not.toContain(secret);
		expect(stored).not.toContain("482913");
		expect(stored).not.toContain("receivers-own-token");

		// One kind at a time.
		const reads = await log(space, agent.id, "?kind=reads");
		expect(actionsOf(reads.entries)).toEqual(["message.read", "code.read"]);
		const people = await log(space, agent.id, "?kind=people");
		expect(people.entries.every((entry) => !entry.by.agent)).toBe(true);
		expect(
			(
				await world.mail.fetch(logUrl(space, agent.id, "?kind=gossip"), {
					headers: world.owner.headers,
				})
			).status,
		).toBe(400);
	});

	it("keeps a subject without the code it gives, and a search without its words", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		await arrive(space.signUps.address, { subject: "771204 is your sign-in code", body: "Hi." });
		await arrive(space.signUps.address, { subject: "", body: "No subject at all." });
		const code = await asAgent(agent.key, "GET", "/verification-code", {
			to: space.signUps.address,
			from: "shop.example",
			subject: "sign-in",
			timeoutSeconds: 0,
		});
		expect(code.body).toMatchObject({ found: true, code: "771204" });
		const box = `/mailboxes/${space.signUps.id}`;
		// What it finds doesn't matter here, as the index catches up after mail arrives.
		const searched = await asAgent(agent.key, "GET", `${box}/threads`, { query: "subject" });
		expect(searched.status).toBe(200);
		// Its next page isn't another search, and a list without words isn't one at all.
		await asAgent(agent.key, "GET", `${box}/threads`, { query: "subject", cursor: "1.x" });
		const listed = await asAgent(agent.key, "GET", `${box}/threads`);
		const thread = (listed.body.threads as { id: string; subject: string }[]).find(
			(one) => one.subject === "",
		);
		expect(thread).toBeDefined();
		const read = await asAgent(agent.key, "GET", `${box}/threads/${thread?.id}`);
		expect(read.status).toBe(200);

		const reads = await log(space, agent.id, "?kind=reads");
		expect(actionsOf(reads.entries)).toEqual(["message.read", "mail.searched", "code.read"]);
		expect(reads.entries[2]).toMatchObject({ subject: "••• is your sign-in code" });
		expect(reads.entries[1]).toMatchObject({
			by: { agent: true },
			mailbox: { id: space.signUps.id },
			subject: null,
			detail: null,
		});
		// A message without a subject keeps an empty one, so its page can still open its thread.
		expect(reads.entries[0]).toMatchObject({ subject: "", thread: thread?.id });

		const rows = await world.mail.db
			.prepare("SELECT * FROM agent_log WHERE organization_id = ?")
			.bind(space.workspaceId)
			.all();
		const stored = JSON.stringify(rows.results);
		expect(stored).not.toContain("771204");
		expect(stored).not.toContain("No subject at all");
	});

	it("pages through older entries, and keeps only those of the last 90 days", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const before = (await wholeLog(space, agent.id)).length;
		const now = Date.now();
		const insert = (id: string, at: number) =>
			world.mail.db
				.prepare(
					"INSERT INTO agent_log (id, organization_id, agent_member_id, by_agent, action, at) VALUES (?, ?, ?, 1, 'message.read', ?)",
				)
				.bind(id, space.workspaceId, agent.memberId, at);
		await world.mail.db.batch([
			...Array.from({ length: 60 }, (_, n) => insert(`paged-${n}`, now - (n + 1) * 60_000)),
			insert("too-old", now - 91 * DAY),
			insert("old-enough", now - 89 * DAY),
		]);

		const first = await log(space, agent.id);
		expect(first.entries).toHaveLength(50);
		expect(first.next).not.toBeNull();
		const all = await wholeLog(space, agent.id);
		expect(all).toHaveLength(before + 62);
		expect(new Set(all.map((entry) => entry.id)).size).toBe(all.length);
		// Newest first, page after page.
		const times = all.map((entry) => entry.at);
		expect(times).toEqual([...times].sort((one, other) => one - other));

		await world.mail.runScheduled();
		const kept = (await wholeLog(space, agent.id)).map((entry) => entry.id);
		expect(kept).not.toContain("too-old");
		expect(kept).toContain("old-enough");
		expect(kept).toHaveLength(before + 61);
	});

	it("goes with its agent", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		expect((await wholeLog(space, agent.id)).length).toBeGreaterThan(0);
		expect((await auth("/agents/delete", { agentId: agent.id })).status).toBe(200);
		const left = await world.mail.db
			.prepare("SELECT COUNT(*) AS n FROM agent_log WHERE agent_member_id = ?")
			.bind(agent.memberId)
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
		expect(
			(await world.mail.fetch(logUrl(space, agent.id), { headers: world.owner.headers })).status,
		).toBe(404);
	});

	it("is shown to nobody but the workspace's owners and admins", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const theirs = await agentOf(await workspace());
		const member = await signUp(world.mail, origin, "Member");
		await world.mail.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(crypto.randomUUID(), space.workspaceId, member.userId, "member", Date.now())
			.run();
		const stranger = await signUp(world.mail, origin, "Stranger");
		for (const [who, headers] of [
			["a member", member.headers],
			["someone outside", stranger.headers],
			["the agent itself", { authorization: `Bearer ${agent.key}` }],
			[
				"an owner's cookies with a key",
				{ ...world.owner.headers, authorization: `Bearer ${agent.key}` },
			],
			["nobody signed in", {}],
		] as const) {
			const response = await world.mail.fetch(logUrl(space, agent.id), { headers });
			expect(response.status, who).toBe(404);
		}
		expect(
			(await world.mail.fetch(logUrl(space, theirs.id), { headers: world.owner.headers })).status,
		).toBe(404);
	});
});
