import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type SentEmail, startMail } from "./mail-worker";

// Which of an agent's mail waits for a person (MAIL-58): a new agent sends on its own, an owner or
// admin may have all of its mail wait or what goes to anyone a list doesn't name, an agent from
// before the choice keeps exactly what it had, and mail that stays inside the agent's own
// workspace never waits. Through the built Worker in workerd, as an agent's key reaches it.

const origin = "https://mail.test";
const RECEIVER = "hooks.example";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Small, so that a mailbox fills up with one message. */
const MAILBOX_BYTES = 400_000;

const proofs = new Map<string, string>();
/** Where each domain's mail goes. A domain made here takes its mail through Cloudflare. */
const mailHosts = new Map<string, string[]>();
/** Domains DNS can't answer for. */
const unanswered = new Set<string>();

function dns(request: Request): Response {
	const url = new URL(request.url);
	const name = url.searchParams.get("name") ?? "";
	if ([...unanswered].some((domain) => name === domain || name.endsWith(`.${domain}`))) {
		return new Response("busy", { status: 503 });
	}
	if (url.searchParams.get("type") === "MX") {
		const hosts = mailHosts.get(name) ?? [];
		if (hosts.length === 0) return Response.json({ Status: 3 });
		return Response.json({
			Status: 0,
			Answer: hosts.map((host, at) => ({ name, type: 15, data: `${(at + 1) * 10} ${host}.` })),
		});
	}
	const value = proofs.get(name);
	if (!value) return Response.json({ Status: 3 });
	return Response.json({ Status: 0, Answer: [{ name, type: 16, data: `"${value}"` }] });
}

/** What the receiver that stands in for a webhook's got, by path. */
const told: { path: string; type: string; message: string }[] = [];

async function receiver(request: Request): Promise<Response> {
	const body = (await request.json()) as { type: string; data: { message: { id: string } } };
	told.push({
		path: new URL(request.url).pathname,
		type: body.type,
		message: body.data.message.id,
	});
	return new Response("ok");
}

type Mail = Awaited<ReturnType<typeof startMail>>;

let mail: Mail;
let owner: Awaited<ReturnType<typeof signUp>>;
let counter = 0;

interface Sent {
	ok: true;
	id: string;
	threadId: string;
	state: string;
	code: string | null;
}

type Approval = "never" | "unlisted" | "always";

interface Policy {
	sendPerDay: number;
	approval: Approval;
	allowed: string[];
	insideWaits: boolean;
}

async function directory(slug: string, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers: { ...owner.headers, origin, "content-type": "application/json" },
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as {
		ok?: boolean;
		proved?: boolean;
		domains: { id: string; name: string; proof: { value: string } | null }[];
		mailboxes: { id: string; name: string; addresses: { id: string; address: string }[] }[];
	};
}

/** A workspace of its own, with a proved domain whose DNS agrees today, and mailboxes on demand. */
async function workspace() {
	const n = ++counter;
	const slug = `approval-${n}`;
	const domain = `approval${n}.example.com`;
	const workspaceId = await createWorkspace(
		mail,
		origin,
		{ ...owner.headers, "cf-connecting-ip": `198.51.100.${n % 250}` },
		slug,
	);
	await directory(slug, { action: "add-domain", name: domain });
	const [added] = (await directory(slug)).domains;
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
	mailHosts.set(domain, ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net"]);
	expect((await directory(slug, { action: "check-domain", id: added.id })).proved).toBe(true);
	const mailbox = async (localPart: string) => {
		const name = `${localPart} ${n}`;
		await directory(slug, { action: "add-mailbox", name });
		const made = (await directory(slug)).mailboxes.find((box) => box.name === name);
		if (!made) throw new Error("expected a mailbox");
		await directory(slug, {
			action: "add-address",
			domainId: added.id,
			mailboxId: made.id,
			localPart,
			expiresInDays: null,
		});
		const address = `${localPart}@${domain}`;
		const addressId = (await directory(slug)).mailboxes
			.find((box) => box.id === made.id)
			?.addresses.find((one) => one.address === address)?.id;
		if (!addressId) throw new Error("expected the address");
		return { slug, id: made.id, address, addressId };
	};
	return { slug, workspaceId, domain, mailbox, desk: await mailbox("desk") };
}

type Space = Awaited<ReturnType<typeof workspace>>;
type Box = Space["desk"];

/** Asks Better Auth's agents plugin, as the owner unless someone else asks. */
function auth(path: string, body: unknown, headers: Record<string, string> = owner.headers) {
	return mail.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: { ...headers, origin, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** An agent of the workspace as its owner makes it, let send from the workspace's desk. */
async function agentOf(space: Space) {
	const response = await mail.fetch(`${origin}/api/auth/agents/create`, {
		method: "POST",
		headers: {
			...owner.headers,
			origin,
			"content-type": "application/json",
			// From an address of its own each time, as making agents is limited to a few a minute.
			"cf-connecting-ip": `192.0.2.${++counter % 250}`,
		},
		body: JSON.stringify({ organizationId: space.workspaceId, name: `Courier ${counter}` }),
	});
	expect(response.status).toBe(200);
	const { agent, key } = (await response.json()) as {
		agent: { id: string; memberId: string; policy: Policy };
		key: string;
	};
	const access = await directory(space.slug, {
		action: "set-mailbox-access",
		mailboxId: space.desk.id,
		everyone: false,
		memberIds: [agent.memberId],
		senderIds: [agent.memberId],
	});
	expect(access.ok).toBe(true);
	return { ...agent, key };
}

type Agent = Awaited<ReturnType<typeof agentOf>>;

/** Saves an agent's policy, as its page does, and gives the answer. */
async function setPolicy(agent: Agent, policy: Partial<Policy>) {
	const response = await auth("/agents/set-policy", {
		agentId: agent.id,
		sendPerDay: 20,
		allowed: [],
		...policy,
	});
	return response;
}

async function saved(agent: Agent, policy: Partial<Policy>): Promise<Policy> {
	const response = await setPolicy(agent, policy);
	expect(response.status).toBe(200);
	return ((await response.json()) as { policy: Policy }).policy;
}

/** The agent's policy as the Agents page reads it. */
async function listedPolicy(space: Space, agent: Agent): Promise<Policy | undefined> {
	const response = await mail.fetch(
		`${origin}/api/auth/agents/list?organizationId=${space.workspaceId}`,
		{ headers: owner.headers },
	);
	const agents = (await response.json()) as { id: string; policy: Policy }[];
	return agents.find((one) => one.id === agent.id)?.policy;
}

/** A policy's row as it was stored before the choice: no `approval`, and this list. */
async function storedAsBefore(agent: Agent, allowed: string[], sendPerDay = 20) {
	await mail.db
		.prepare(
			`INSERT INTO agent_policy (member_id, send_per_day, allowed, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (member_id) DO UPDATE SET
				send_per_day = excluded.send_per_day, allowed = excluded.allowed, approval = NULL`,
		)
		.bind(agent.memberId, sendPerDay, JSON.stringify(allowed), Date.now())
		.run();
}

/** An agent's message, as it sends it with its key from the workspace's desk. */
function agentSends(space: Space, agent: Agent, to: string[], cc: string[] = [], more = {}) {
	return mail.fetch(`${origin}/api/mail/${space.slug}/${space.desk.id}/outbox`, {
		method: "POST",
		headers: { authorization: `Bearer ${agent.key}`, "content-type": "application/json" },
		body: JSON.stringify({
			action: "send",
			draft: crypto.randomUUID(),
			to,
			cc,
			subject: `Update ${++counter}`,
			text: "Your order shipped.",
			...more,
		}),
	});
}

/** What became of an agent's message: `sent`, `held`, or how sending went. */
async function stateOf(space: Space, agent: Agent, to: string[], cc: string[] = []) {
	const response = await agentSends(space, agent, to, cc);
	expect(response.status).toBe(200);
	return ((await response.json()) as Sent).state;
}

/** Asks the agent API over REST, with the agent's key. */
function api(agent: Agent, method: string, path: string, body?: unknown) {
	return mail.fetch(`${origin}/api/v1${path}`, {
		method,
		headers: { authorization: `Bearer ${agent.key}`, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

/** The mailbox's messages, newest first, as its owner reads them. */
async function messages(box: Box) {
	const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.id}`, {
		headers: owner.headers,
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { messages: { id: string; subject: string | null }[] })
		.messages;
}

/** What the stand-in for Email Service sent to this address. */
async function sentTo(address: string): Promise<SentEmail[]> {
	return (await mail.emails()).filter((email) =>
		[email.to, email.cc ?? []].flat().includes(address),
	);
}

/** How a message the desk keeps is being sent now. */
async function sendingState(space: Space, sent: Sent) {
	const response = await mail.fetch(
		`${origin}/api/mail/${space.slug}/${space.desk.id}/threads/${sent.threadId}`,
		{ headers: owner.headers },
	);
	const page = (await response.json()) as {
		messages: { id: string; sent: { status: { state: string } | null } | null }[];
	};
	return page.messages.find((one) => one.id === sent.id)?.sent?.status?.state ?? "";
}

/** What the agent's log says of the mail it wrote, oldest first. */
async function logOf(agent: Agent) {
	const { results } = await mail.db
		.prepare(
			`SELECT action, detail FROM agent_log
			WHERE agent_member_id = ? AND action LIKE 'message.%' ORDER BY rowid`,
		)
		.bind(agent.memberId)
		.all<{ action: string; detail: string | null }>();
	return results;
}

beforeAll(async () => {
	mail = await startMail(origin, {
		hosts: { "cloudflare-dns.com": dns, [RECEIVER]: receiver },
		settings: { MAILBOX_BYTES: String(MAILBOX_BYTES) },
	});
	owner = await signUp(mail, origin, "Owner");
});

afterAll(async () => {
	await mail?.dispose();
});

describe("a new agent", () => {
	it("is made to send on its own, a few messages a day, with its policy stored", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const made: Policy = { sendPerDay: 20, approval: "never", allowed: [], insideWaits: false };
		expect(agent.policy).toEqual(made);
		expect(await listedPolicy(space, agent)).toEqual(made);
		const row = await mail.db
			.prepare("SELECT send_per_day, allowed, approval FROM agent_policy WHERE member_id = ?")
			.bind(agent.memberId)
			.first();
		expect(row).toEqual({ send_per_day: 20, allowed: "[]", approval: "never" });

		const outside = `ada.${space.slug}@example.org`;
		expect(await stateOf(space, agent, [outside])).toBe("sent");
		expect(await sentTo(outside)).toHaveLength(1);
	});
});

describe("an agent's policy, changed by an owner or admin", () => {
	it("has everything wait, or what its list doesn't name, or nothing", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const listed = `ops.${space.slug}@example.org`;
		const other = `ada.${space.slug}@example.org`;

		expect(await saved(agent, { approval: "always" })).toMatchObject({ approval: "always" });
		expect(await stateOf(space, agent, [other])).toBe("held");
		expect(await sentTo(other)).toHaveLength(0);
		// A list kept under it lets nothing through.
		await saved(agent, { approval: "always", allowed: [listed] });
		expect(await stateOf(space, agent, [listed])).toBe("held");

		expect(await saved(agent, { approval: "unlisted", allowed: [listed] })).toEqual({
			sendPerDay: 20,
			approval: "unlisted",
			allowed: [listed],
			insideWaits: false,
		});
		expect(await stateOf(space, agent, [listed])).toBe("sent");
		expect(await stateOf(space, agent, [other])).toBe("held");
		expect(await stateOf(space, agent, [listed], [other])).toBe("held");

		// And a list kept under "never" holds nothing back.
		expect(await saved(agent, { approval: "never", allowed: [listed] })).toMatchObject({
			approval: "never",
		});
		expect(await stateOf(space, agent, [other])).toBe("sent");
		expect(await listedPolicy(space, agent)).toMatchObject({ approval: "never" });
	});

	it("is what its list alone used to say when a page from before saves it", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		// No `approval` in the body, as the dialog sent before there was a choice.
		const empty = await auth("/agents/set-policy", {
			agentId: agent.id,
			sendPerDay: 5,
			allowed: [],
		});
		expect(((await empty.json()) as { policy: Policy }).policy).toMatchObject({
			approval: "always",
		});
		const withList = await auth("/agents/set-policy", {
			agentId: agent.id,
			sendPerDay: 5,
			allowed: ["@acme.test"],
		});
		expect(((await withList.json()) as { policy: Policy }).policy).toMatchObject({
			approval: "unlisted",
			allowed: ["@acme.test"],
		});
	});

	it("refuses a list of nobody, and a word it doesn't know", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		expect((await setPolicy(agent, { approval: "unlisted", allowed: [] })).status).toBe(400);
		expect((await setPolicy(agent, { approval: "sometimes" as Approval })).status).toBe(400);
		expect(await listedPolicy(space, agent)).toMatchObject({ approval: "never" });
	});

	it("needs a recent sign-in, and an owner or admin", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		await saved(agent, { approval: "always" });
		const join = async (role: string) => {
			const who = await signUp(mail, origin, `${role}${++counter}`);
			await mail.db
				.prepare(
					"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(crypto.randomUUID(), space.workspaceId, who.userId, role, Date.now())
				.run();
			return who;
		};
		const member = await join("member");
		expect((await setPolicy(agent, { approval: "never" })).status).toBe(200);
		await saved(agent, { approval: "always" });
		const refused = await auth(
			"/agents/set-policy",
			{ agentId: agent.id, sendPerDay: 20, allowed: [], approval: "never" },
			member.headers,
		);
		expect(refused.status).toBe(403);

		const admin = await join("admin");
		await mail.db
			.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
			.bind(Date.now() - 2 * DAY_MS, admin.userId)
			.run();
		const late = await auth(
			"/agents/set-policy",
			{ agentId: agent.id, sendPerDay: 20, allowed: [], approval: "never" },
			admin.headers,
		);
		expect(late.status).toBe(403);
		expect(((await late.json()) as { code?: string }).code).toBe("SESSION_NOT_FRESH");
		expect(await listedPolicy(space, agent)).toMatchObject({ approval: "always" });
	});
});

describe("an agent from before there was a choice", () => {
	it("with an empty list still has everything wait, inside its workspace too", async () => {
		const space = await workspace();
		const inside = await space.mailbox("billing");
		const agent = await agentOf(space);
		await storedAsBefore(agent, [], 7);
		expect(await listedPolicy(space, agent)).toEqual({
			sendPerDay: 7,
			approval: "always",
			allowed: [],
			insideWaits: true,
		});
		expect(await stateOf(space, agent, [`ada.${space.slug}@example.org`])).toBe("held");
		expect(await stateOf(space, agent, [inside.address])).toBe("held");
		expect(await messages(inside)).toHaveLength(0);
	});

	it("with a list still sends to its list alone, and the rest waits", async () => {
		const space = await workspace();
		const inside = await space.mailbox("billing");
		const agent = await agentOf(space);
		const listed = `ops.${space.slug}@example.org`;
		await storedAsBefore(agent, [listed]);
		expect(await listedPolicy(space, agent)).toEqual({
			sendPerDay: 20,
			approval: "unlisted",
			allowed: [listed],
			insideWaits: true,
		});
		expect(await stateOf(space, agent, [listed])).toBe("sent");
		expect(await stateOf(space, agent, [`ada.${space.slug}@example.org`])).toBe("held");
		expect(await stateOf(space, agent, [listed], [inside.address])).toBe("held");
		expect(await stateOf(space, agent, [inside.address])).toBe("held");
	});

	it("without a policy of its own still has everything wait, 20 messages a day", async () => {
		const space = await workspace();
		const inside = await space.mailbox("billing");
		const agent = await agentOf(space);
		await mail.db
			.prepare("DELETE FROM agent_policy WHERE member_id = ?")
			.bind(agent.memberId)
			.run();
		expect(await listedPolicy(space, agent)).toEqual({
			sendPerDay: 20,
			approval: "always",
			allowed: [],
			insideWaits: true,
		});
		expect(await stateOf(space, agent, [`ada.${space.slug}@example.org`])).toBe("held");
		expect(await stateOf(space, agent, [inside.address])).toBe("held");
		// Its own read of its policy says the same.
		const read = (await (await api(agent, "GET", "/mailboxes")).json()) as {
			sending: Record<string, unknown>;
		};
		expect(read.sending).toEqual({ perDay: 20, approval: "always", withoutApproval: [] });
	});

	it("gets mail inside its workspace through only once a person saves its policy", async () => {
		const space = await workspace();
		const inside = await space.mailbox("billing");
		const agent = await agentOf(space);
		await storedAsBefore(agent, []);
		expect(await stateOf(space, agent, [inside.address])).toBe("held");
		// Saved as it stood: everything still waits, but for mail that stays inside.
		expect(await saved(agent, { approval: "always" })).toMatchObject({
			approval: "always",
			insideWaits: false,
		});
		expect(await stateOf(space, agent, [inside.address])).toBe("sent");
		expect(await stateOf(space, agent, [`ada.${space.slug}@example.org`])).toBe("held");
	});
});

describe("mail that stays inside the agent's own workspace", () => {
	it("never waits, To and Cc, whatever the policy says", async () => {
		const space = await workspace();
		const billing = await space.mailbox("billing");
		const sales = await space.mailbox("sales");
		const agent = await agentOf(space);

		await saved(agent, { approval: "always" });
		expect(await stateOf(space, agent, [billing.address], [sales.address])).toBe("sent");
		expect(await messages(billing)).toHaveLength(1);
		expect(await messages(sales)).toHaveLength(1);
		// It reached nobody through a provider.
		expect(await sentTo(billing.address)).toHaveLength(0);

		await saved(agent, { approval: "unlisted", allowed: ["@elsewhere.example"] });
		expect(await stateOf(space, agent, [billing.address])).toBe("sent");
		// In any case of letters, as the directory reads an address.
		expect(await stateOf(space, agent, [billing.address.toUpperCase()])).toBe("sent");
		expect(await messages(billing)).toHaveLength(3);
	});

	it("follows the policy when it goes to another workspace on the same server", async () => {
		const space = await workspace();
		const theirs = await workspace();
		const agent = await agentOf(space);
		await saved(agent, { approval: "always" });
		expect(await stateOf(space, agent, [theirs.desk.address])).toBe("held");
		expect(await messages(theirs.desk)).toHaveLength(0);

		// And goes there on its own when the policy lets it.
		await saved(agent, { approval: "unlisted", allowed: [`@${theirs.domain}`] });
		expect(await stateOf(space, agent, [theirs.desk.address])).toBe("sent");
		await saved(agent, { approval: "never" });
		expect(await stateOf(space, agent, [theirs.desk.address])).toBe("sent");
		expect(await messages(theirs.desk)).toHaveLength(2);
	});

	it("follows the policy when anyone it goes to is outside the workspace", async () => {
		const space = await workspace();
		const theirs = await workspace();
		const billing = await space.mailbox("billing");
		const agent = await agentOf(space);
		await saved(agent, { approval: "always" });
		const outside = `ada.${space.slug}@example.org`;
		expect(await stateOf(space, agent, [billing.address, outside])).toBe("held");
		expect(await stateOf(space, agent, [billing.address], [outside])).toBe("held");
		expect(await stateOf(space, agent, [billing.address], [theirs.desk.address])).toBe("held");
		expect(await messages(billing)).toHaveLength(0);
		expect(await sentTo(outside)).toHaveLength(0);

		// A list covers the outsider, and then the rest must be listed or inside: it isn't both.
		await saved(agent, { approval: "unlisted", allowed: [outside] });
		expect(await stateOf(space, agent, [billing.address], [outside])).toBe("held");
	});

	it("isn't an address that ended, was removed, or only looks like the workspace's", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		await saved(agent, { approval: "always" });

		const ended = await space.mailbox("ended");
		await mail.db
			.prepare("UPDATE mail_address SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1_000, ended.addressId)
			.run();
		expect(await stateOf(space, agent, [ended.address])).toBe("held");

		const removed = await space.mailbox("removed");
		await directory(space.slug, { action: "remove-address", id: removed.addressId });
		expect(await stateOf(space, agent, [removed.address])).toBe("held");

		for (const lookalike of [
			`desk@mail.${space.domain}`,
			`desk@${space.domain}.example`,
			`desk@x${space.domain}`,
			`nobody@${space.domain}`,
		]) {
			expect(await stateOf(space, agent, [lookalike]), lookalike).toBe("held");
		}
		expect(await messages(ended)).toHaveLength(0);
	});

	it("isn't a domain whose DNS no longer says today what the directory says", async () => {
		const agent = async (change: (space: Space) => void) => {
			const space = await workspace();
			const billing = await space.mailbox("billing");
			const made = await agentOf(space);
			await saved(made, { approval: "always" });
			change(space);
			return stateOf(space, made, [billing.address]);
		};
		expect(await agent((space) => proofs.delete(`_gateweave-mail.${space.domain}`))).toBe("held");
		expect(await agent((space) => mailHosts.set(space.domain, ["aspmx.l.google.com"]))).toBe(
			"held",
		);
		expect(await agent((space) => unanswered.add(space.domain))).toBe("held");
		expect(await agent(() => {})).toBe("sent");
	});
});

describe("a paused agent", () => {
	it("sends nothing, inside its workspace or out", async () => {
		const space = await workspace();
		const billing = await space.mailbox("billing");
		const agent = await agentOf(space);
		expect((await auth("/agents/pause", { agentId: agent.id })).status).toBe(200);
		for (const to of [billing.address, `ada.${space.slug}@example.org`]) {
			// The app's own route knows a paused key no more than a revoked one; its API says why.
			expect((await agentSends(space, agent, [to])).status).toBe(404);
			const response = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages`, {
				to: [to],
				subject: "While paused",
				text: "Hello.",
			});
			expect(response.status).toBe(403);
			expect(((await response.json()) as { error: string }).error).toMatch(/paused/);
		}
		expect(await messages(billing)).toHaveLength(0);
	});

	it("has mail inside its workspace that waited to be tried again held for a person", {
		timeout: 90_000,
	}, async () => {
		const space = await workspace();
		const billing = await space.mailbox("billing");
		const agent = await agentOf(space);
		await saved(agent, { approval: "always" });
		// The mailbox it goes to is full, so the message waits to be tried again.
		const big = [
			"From: Ada Lovelace <ada@example.org>",
			`To: ${billing.address}`,
			"Subject: Big",
			"Date: Sun, 08 Nov 2026 09:00:00 +0000",
			`Message-ID: <big-${++counter}@example.org>`,
			"",
			...Array.from({ length: Math.floor((MAILBOX_BYTES - 200) / 78) }, () => "x".repeat(76)),
			"",
		].join("\r\n");
		expect(await mail.deliver("ada@example.org", billing.address, big)).toMatchObject({
			status: 200,
		});
		const [kept] = await messages(billing);

		const written = await agentSends(space, agent, [billing.address]);
		const waiting = (await written.json()) as Sent;
		expect(waiting).toMatchObject({ state: "waiting", code: "mail:direct_full" });

		expect((await auth("/agents/pause", { agentId: agent.id })).status).toBe(200);
		// Room now, so only the pause keeps it from arriving at the next try.
		const removed = await mail.fetch(`${origin}/api/mail/${space.slug}/${billing.id}/${kept?.id}`, {
			method: "DELETE",
			headers: { ...owner.headers, origin },
		});
		expect(removed.status).toBe(200);
		let state = waiting.state;
		for (let waited = 0; state !== "held" && waited < 60_000; waited += 1_000) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			state = await sendingState(space, waiting);
		}
		expect(state).toBe("held");
		expect(await messages(billing)).toHaveLength(0);
	});
});

describe("an agent's day", () => {
	it("refuses the message after its last, whichever way its mail goes", async () => {
		for (const approval of ["never", "unlisted", "always"] as const) {
			const space = await workspace();
			const billing = await space.mailbox("billing");
			const agent = await agentOf(space);
			const listed = `ops.${space.slug}@example.org`;
			await saved(agent, {
				sendPerDay: 2,
				approval,
				allowed: approval === "unlisted" ? [listed] : [],
			});
			expect(await stateOf(space, agent, [listed]), approval).toBe(
				approval === "always" ? "held" : "sent",
			);
			// Mail inside the workspace counts like any other.
			expect(await stateOf(space, agent, [billing.address]), approval).toBe("sent");
			for (const to of [listed, billing.address]) {
				const over = await agentSends(space, agent, [to]);
				expect(over.status, approval).toBe(429);
				expect(((await over.json()) as { error: string }).error).toMatch(/^This agent has written/);
			}
			expect(await sentTo(listed), approval).toHaveLength(approval === "always" ? 0 : 1);
		}
	});
});

describe("an agent, of its own policy", () => {
	it("reads it, and what it reads is what happens", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const sending = async () =>
			((await (await api(agent, "GET", "/mailboxes")).json()) as { sending: unknown }).sending;
		expect(await sending()).toEqual({ perDay: 20, approval: "never", withoutApproval: [] });
		await saved(agent, { sendPerDay: 5, approval: "unlisted", allowed: ["@acme.test"] });
		expect(await sending()).toEqual({
			perDay: 5,
			approval: "unlisted",
			withoutApproval: ["@acme.test"],
		});
		// A list kept under another choice lets nothing through, so it isn't given as one that does.
		await saved(agent, { sendPerDay: 5, approval: "always", allowed: ["@acme.test"] });
		expect(await sending()).toEqual({ perDay: 5, approval: "always", withoutApproval: [] });
	});

	it("can't change it, by any route or by anything it sends", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		await saved(agent, { approval: "always" });
		const key = { authorization: `Bearer ${agent.key}` };
		const outside = `ada.${space.slug}@example.org`;

		// The route that changes a policy takes a person's session, never a key.
		const asked = await auth(
			"/agents/set-policy",
			{ agentId: agent.id, sendPerDay: 1000, allowed: [], approval: "never" },
			key,
		);
		expect(asked.status).not.toBe(200);

		// No operation of the agent API has a policy to write.
		const document = (await (await mail.fetch(`${origin}/api/v1/openapi.json`)).json()) as {
			paths: Record<string, Record<string, unknown>>;
		};
		const writes = Object.entries(document.paths).flatMap(([path, methods]) =>
			Object.keys(methods)
				.filter((method) => method !== "get")
				.map((method) => `${method} ${path}`),
		);
		expect(writes.filter((route) => /polic|approv|sending|limit/i.test(route))).toEqual([]);
		for (const [method, path] of [
			["POST", "/policy"],
			["PATCH", "/mailboxes"],
			["PUT", "/mailboxes"],
			["POST", "/sending"],
			["PATCH", "/sending"],
		] as const) {
			const response = await api(agent, method, path, { approval: "never", sendPerDay: 1000 });
			expect([404, 405], `${method} ${path}`).toContain(response.status);
		}

		// Nor does a field a send carries: the route's own, and the API's.
		const extras = {
			approval: "never",
			hold: false,
			state: "sent",
			policy: { approval: "never" },
			sending: { approval: "never", withoutApproval: [outside] },
			allowed: [outside],
		};
		const direct = await agentSends(space, agent, [outside], [], extras);
		expect(((await direct.json()) as Sent).state).toBe("held");
		const over = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages`, {
			to: [outside],
			subject: "Let me through",
			text: "Please.",
			...extras,
		});
		const answer = (await over.json()) as Record<string, unknown>;
		expect(answer.state).toBe("held");
		expect(await sentTo(outside)).toHaveLength(0);
		expect(await listedPolicy(space, agent)).toEqual({
			sendPerDay: 20,
			approval: "always",
			allowed: [],
			insideWaits: false,
		});

		// And a send answers in the same shape, held or sent.
		await saved(agent, { approval: "never" });
		const gone = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages`, {
			to: [outside],
			subject: "On my own",
			text: "Hello.",
		});
		const sent = (await gone.json()) as Record<string, unknown>;
		expect(sent.state).toBe("sent");
		expect(Object.keys(sent).sort()).toEqual(Object.keys(answer).sort());
		expect(Object.keys(sent).sort()).toEqual(["id", "state", "threadId"]);
	});
});

describe("what is told of an agent's mail", () => {
	it("is held only when it waits, to webhooks and in its log alike", async () => {
		const space = await workspace();
		const billing = await space.mailbox("billing");
		const agent = await agentOf(space);
		const path = `/approval-${++counter}`;
		const made = await mail.fetch(`${origin}/api/webhooks/${space.slug}`, {
			method: "POST",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify({
				action: "create",
				input: {
					url: `https://${RECEIVER}${path}`,
					events: ["message.held", "message.sent"],
					mailboxIds: [space.desk.id],
				},
			}),
		});
		expect(made.status).toBe(200);
		const outside = `ada.${space.slug}@example.org`;
		const write = async (to: string) =>
			(await (await agentSends(space, agent, [to])).json()) as Sent;

		const alone = await write(outside);
		await saved(agent, { approval: "always" });
		const inside = await write(billing.address);
		const waits = await write(outside);
		expect([alone.state, inside.state, waits.state]).toEqual(["sent", "sent", "held"]);

		const deadline = Date.now() + 15_000;
		const mine = () => told.filter((one) => one.path === path);
		while (mine().length < 3 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const byMessage = Object.fromEntries(mine().map((one) => [one.message, one.type]));
		expect(byMessage).toEqual({
			[alone.id]: "message.sent",
			[inside.id]: "message.sent",
			[waits.id]: "message.held",
		});

		// Its log names each message it sent on its own, with whom it went to.
		expect(await logOf(agent)).toEqual([
			{ action: "message.sent", detail: outside },
			{ action: "message.sent", detail: billing.address },
			{ action: "message.held", detail: outside },
		]);
	});
});
