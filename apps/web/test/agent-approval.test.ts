import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { fromCloudflare } from "./agent-world";
import { type SentEmail, startMail } from "./mail-worker";

// Which of an agent's mail waits for a person (MAIL-58): a new agent sends on its own, an owner or
// admin may have all of its mail wait or what goes to anyone a list doesn't name, an agent from
// before the choice keeps exactly what it had, and mail that stays inside the agent's own
// workspace never waits. Through the built Worker in workerd, as an agent's key reaches it.

const origin = "https://mail.test";
const RECEIVER = "hooks.example";
const DAY_MS = 24 * 60 * 60 * 1000;

/** How many messages a workspace may send a day in these tests: more than any test but one sends. */
const SEND_PER_DAY = 5;

/** Small, so that a mailbox fills up with one message. */
const MAILBOX_BYTES = 400_000;

const proofs = new Map<string, string>();
/** Where each domain's mail goes. A domain made here takes its mail through Cloudflare. */
const mailHosts = new Map<string, string[]>();
/** Domains DNS can't answer for. */
const unanswered = new Set<string>();

/** What happens, once, when DNS is next asked about a domain: before it answers. */
const beforeAnswering = new Map<string, () => Promise<void>>();

async function dns(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const name = url.searchParams.get("name") ?? "";
	for (const [domain, first] of beforeAnswering) {
		if (name === domain || name.endsWith(`.${domain}`)) {
			beforeAnswering.delete(domain);
			await first();
		}
	}
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
	anyRecipient: boolean;
	webhookHosts: string[];
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
		inspectMailboxes: true,
		hosts: { "cloudflare-dns.com": dns, [RECEIVER]: receiver },
		settings: { MAILBOX_BYTES: String(MAILBOX_BYTES), SEND_PER_DAY: String(SEND_PER_DAY) },
	});
	owner = await signUp(mail, origin, "Owner");
});

afterAll(async () => {
	await mail?.dispose();
});

/** A received message kept by a mailbox, with the headers the receiving provider adds. */
async function receive(
	box: Box,
	from: string,
	headers: string[] = [],
	verdict = "none",
	to = box.address,
) {
	const subject = `Inbound ${++counter}`;
	const raw = [
		...fromCloudflare(from.split("@")[1] ?? "", verdict),
		`From: Customer <${from}>`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: <${counter}@example.com>`,
		...headers,
		"",
		"Customer correspondence.",
	].join("\r\n");
	expect((await mail.deliver("relay@example.org", box.address, raw)).status).toBe(200);
	const received = (await messages(box)).find((message) => message.subject === subject);
	if (!received) throw new Error("Expected the received message");
	return received.id;
}

describe("where an agent may send on its own", () => {
	it("holds sends during the first hour of a clipped From check, then logs definitive refusals", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const writer = "writer@example.org";
		const other = "unrelated@example.org";
		const id = await receive(space.desk, writer);
		const sql = await mail.mailboxStorage(space.desk.id);
		const now = Date.now();
		await sql.exec(
			"UPDATE message SET sender_address = NULL, sender_check_at = ?, sender_check_started = ? WHERE id = ?",
			now + 60_000,
			now - 59 * 60_000,
			id,
		);
		for (const target of [writer, other]) {
			const pending = await agentSends(space, agent, [target]);
			expect(pending.status).toBe(503);
			expect(await pending.json()).toMatchObject({
				error: "Mail could not finish checking this agent's recipients. Try sending again shortly.",
			});
		}
		expect(await logOf(agent)).toEqual([]);
		await sql.exec("UPDATE message SET sender_check_started = ? WHERE id = ?", now - 3_600_000, id);
		for (const target of [writer, other]) {
			expect((await agentSends(space, agent, [target])).status).toBe(403);
		}
		expect(await logOf(agent)).toEqual(
			[writer, other].map((detail) => ({ action: "message.refused", detail })),
		);
		await sql.exec("UPDATE message SET sender_check_at = 0 WHERE id = ?", id);
		expect(await stateOf(space, agent, [writer])).toBe("sent");
	});

	it("stops checking a missing original after three alarm attempts and refuses the recipient", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const id = await receive(space.desk, "missing@example.org");
		const sql = await mail.mailboxStorage(space.desk.id);
		const [row] = await sql.exec<{ object: string }>("SELECT object FROM message WHERE id = ?", id);
		if (!row) throw new Error("Expected the stored original");
		await mail.bucket.delete(row.object);
		const send = () => agentSends(space, agent, ["unknown@example.org"]);
		for (let attempt = 1; attempt <= 3; attempt++) {
			// Move the retry close enough to run the real alarm during the test. A check is recorded
			// with its start, as on arrival.
			await sql.exec(
				"UPDATE message SET sender_address = NULL, sender_check_at = ?, sender_check_started = coalesce(sender_check_started, ?) WHERE id = ?",
				Date.now() + 500,
				Date.now(),
				id,
			);
			expect((await send()).status).toBe(503);
			await expect
				.poll(
					async () =>
						(await sql.exec("SELECT sender_attempts FROM message WHERE id = ?", id))[0]
							?.sender_attempts,
				)
				.toBe(attempt);
		}
		await expect
			.poll(() => sql.exec("SELECT sender_address, sender_check_at FROM message WHERE id = ?", id))
			.toEqual([{ sender_address: null, sender_check_at: null }]);
		expect((await send()).status).toBe(403);
		expect(await logOf(agent)).toEqual([
			{ action: "message.refused", detail: "unknown@example.org" },
		]);
	});

	it("normalizes an IDN, case and a trailing dot against a received From on send_email", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		await receive(space.desk, "customer@xn--exmple-cua.com");
		const response = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages`, {
			to: ["Customer@Ex\u00e4mple.com."],
			subject: "Update",
			text: "Shipped.",
		});
		expect(await response.json()).toMatchObject({ state: "sent" });
		expect(await sentTo("customer@xn--exmple-cua.com")).toHaveLength(1);
	});

	it("logs only the first five refused recipients and answers with all seven", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const to = Array.from({ length: 7 }, (_, i) => `unknown${i}@example.net`);
		const response = await agentSends(space, agent, to);
		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: string }).error).toContain(to.join(", "));
		expect(await logOf(agent)).toEqual([
			{ action: "message.refused", detail: `${to.slice(0, 5).join(", ")} and 2 more` },
		]);
	});

	it("retries a failed DNS lookup before storing, refusing or counting a workspace send", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const billing = await space.mailbox("billing");
		await saved(agent, { approval: "never", sendPerDay: 1 });
		unanswered.add(space.domain);
		const send = () =>
			api(agent, "POST", `/mailboxes/${space.desk.id}/messages`, {
				to: [billing.address],
				subject: "Update",
				text: "Ready.",
			});
		try {
			expect((await send()).status).toBe(503);
			expect(await messages(space.desk)).toEqual([]);
			expect(await messages(billing)).toEqual([]);
			expect(await sentTo(billing.address)).toEqual([]);
			expect(await logOf(agent)).toEqual([]);
		} finally {
			unanswered.delete(space.domain);
		}
		expect(await (await send()).json()).toMatchObject({ state: "sent" });
	});

	it("accepts a local recipient known to another readable mailbox while DNS is down", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const billing = await space.mailbox("billing");
		await directory(space.slug, {
			action: "set-mailbox-access",
			mailboxId: billing.id,
			everyone: false,
			memberIds: [agent.memberId],
			senderIds: [],
		});
		await receive(billing, billing.address);
		await receive(billing, "external@sender.test");
		unanswered.add(space.domain);
		try {
			expect(await stateOf(space, agent, [billing.address, "external@sender.test"])).toBe("sent");
			expect(
				(await agentSends(space, agent, [billing.address, "unknown@foreign.test"])).status,
			).toBe(403);
		} finally {
			unanswered.delete(space.domain);
		}
	});

	it("refuses and logs a reply to another agent's outside recipient", async () => {
		const space = await workspace();
		const other = await agentOf(space);
		const to = "x@evil.test";
		await saved(other, { approval: "never", anyRecipient: true });
		const first = (await (await agentSends(space, other, [to], ["copy@evil.test"])).json()) as Sent;
		const agent = await agentOf(space);
		const reply = () =>
			api(agent, "POST", `/mailboxes/${space.desk.id}/messages/${first.id}/reply`, {
				text: "Received.",
			});
		expect((await reply()).status).toBe(403);
		expect(await logOf(agent)).toEqual([{ action: "message.refused", detail: to }]);
		await saved(agent, { approval: "never", allowed: [to] });
		expect(await (await reply()).json()).toMatchObject({ state: "sent" });
		expect(await sentTo("copy@evil.test")).toHaveLength(1);
	});

	it("keeps a person's outside recipient on a reply", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const to = "x@evil.test";
		const written = await mail.fetch(`${origin}/api/mail/${space.slug}/${space.desk.id}/outbox`, {
			method: "POST",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify({
				action: "send",
				draft: crypto.randomUUID(),
				to: [to],
				subject: "Update",
				text: "First.",
			}),
		});
		expect(written.status).toBe(200);
		const first = (await written.json()) as Sent;
		const reply = await api(
			agent,
			"POST",
			`/mailboxes/${space.desk.id}/messages/${first.id}/reply`,
			{ text: "Another update." },
		);
		expect(await reply.json()).toMatchObject({ state: "sent" });
		expect((await sentTo(to)).at(-1)).toMatchObject({
			from: expect.anything(),
			to: [to],
			text: expect.stringContaining("Another update."),
		});
	});

	it("drops a sent message's Cc that repeats To with different case on reply", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const id = await receive(
			space.desk,
			space.desk.address,
			["Cc: a@example.test, copy@example.test"],
			"none",
			"A@Example.test",
		);
		const sql = await mail.mailboxStorage(space.desk.id);
		await sql.exec("UPDATE message SET sent_by = ? WHERE id = ?", agent.memberId, id);
		const reply = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages/${id}/reply`, {
			text: "Received.",
		});
		expect(await reply.json()).toMatchObject({ state: "sent" });
		expect((await sentTo("copy@example.test")).at(-1)).toMatchObject({
			to: [expect.stringMatching(/^a@example\.test$/i)],
			cc: ["copy@example.test"],
		});
	});

	it("drops a malformed stored Cc when replying to sent mail", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const id = await receive(space.desk, space.desk.address, [
			"Cc: good@example.org, Bad <broken@>",
		]);
		const sql = await mail.mailboxStorage(space.desk.id);
		await sql.exec("UPDATE message SET sent_by = ? WHERE id = ?", agent.memberId, id);
		const reply = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages/${id}/reply`, {
			text: "Received.",
		});
		expect(await reply.json()).toMatchObject({ state: "sent" });
		expect((await sentTo("good@example.org")).at(-1)).toMatchObject({ cc: ["good@example.org"] });
	});

	it("keeps this agent's original To and Cc after its allowed list narrows", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const to = "first@example.net",
			cc = "copied@example.net";
		await saved(agent, { approval: "never", allowed: [to, cc] });
		const first = (await (await agentSends(space, agent, [to], [cc])).json()) as Sent;
		await saved(agent, { approval: "never", allowed: [] });
		const reply = await api(
			agent,
			"POST",
			`/mailboxes/${space.desk.id}/messages/${first.id}/reply`,
			{ text: "Another update." },
		);
		expect(await reply.json()).toMatchObject({ state: "sent" });
		expect((await sentTo(to)).at(-1)).toMatchObject({ cc: [cc] });
		expect(await sentTo(cc)).toHaveLength(2);
	});

	it("refuses unknown To and Cc before storing mail or spending the agent's last send", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const from = "outsider@example.com";
		const unknown = "evil@example.net";
		const elsewhere = "another@example.net";
		await receive(space.desk, from);
		await saved(agent, { approval: "never", sendPerDay: 1 });
		const path = `/mailboxes/${space.desk.id}/messages`;
		const body = { subject: "Customer list", text: "Private message body." };
		const refused = await api(agent, "POST", path, {
			...body,
			to: [unknown],
			cc: [from, elsewhere],
		});
		expect(refused.status).toBe(403);
		const error = ((await refused.json()) as { error: string }).error;
		expect(error).toContain(unknown);
		expect(error).toContain(elsewhere);
		expect(error).toMatch(/owner|admin/i);
		expect(error).toMatch(/allowed/i);
		expect(error).not.toContain(from);
		expect(await messages(space.desk)).toHaveLength(1);
		expect(await sentTo(unknown)).toHaveLength(0);
		const response = await mail.fetch(
			`${origin}/api/agents/${space.slug}/${agent.id}/log?kind=mail`,
			{
				headers: owner.headers,
			},
		);
		const log = (await response.json()) as {
			entries: { action: string; subject: string; detail: string }[];
		};
		expect(log.entries).toHaveLength(1);
		expect(log.entries[0]).toMatchObject({ action: "message.refused", subject: body.subject });
		expect(log.entries[0]?.detail).toContain(unknown);
		expect(log.entries[0]?.detail).toContain(elsewhere);
		expect(JSON.stringify(log)).not.toContain(body.text);
		const send = () => api(agent, "POST", path, { ...body, to: [from] });
		expect(await (await send()).json()).toMatchObject({ state: "sent" });
		expect((await send()).status).toBe(429);
		expect(await sentTo(from)).toHaveLength(1);
	});

	it("allows an unknown recipient after the owner turns off target restrictions", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const path = `/mailboxes/${space.desk.id}/messages`;
		const body = { subject: "Order", text: "Delivered." };
		const unknown = "evil@example.net";
		await saved(agent, {
			approval: "never",
			anyRecipient: true,
			webhookHosts: ["hooks.example.org"],
		});
		expect(await saved(agent, { approval: "never", sendPerDay: 3 })).toMatchObject({
			anyRecipient: true,
			webhookHosts: ["hooks.example.org"],
		});
		expect((await listedPolicy(space, agent))?.anyRecipient).toBe(true);
		const changes = await mail.fetch(
			`${origin}/api/agents/${space.slug}/${agent.id}/log?kind=people`,
			{ headers: owner.headers },
		);
		const recent = (await changes.json()) as {
			entries: { action: string; detail: string; by: { agent: boolean; name: string } }[];
		};
		expect(recent.entries.find((entry) => entry.action === "policy.changed")).toMatchObject({
			by: { agent: false, name: "Owner" },
			detail: expect.stringMatching(/any recipient/i),
		});
		expect(await (await api(agent, "POST", path, { ...body, to: [unknown] })).json()).toMatchObject(
			{ state: "sent" },
		);
		await saved(agent, { approval: "never", anyRecipient: false });
		const { results } = await mail.db
			.prepare(
				"SELECT detail FROM agent_log WHERE agent_member_id = ? AND action = 'policy.changed' ORDER BY rowid",
			)
			.bind(agent.memberId)
			.all<{ detail: string }>();
		expect(results.map((row: { detail: string }) => row.detail)).toEqual([
			expect.stringContaining("Any recipient and webhook host allowed"),
			expect.stringContaining("Any recipient and webhook host allowed"),
			expect.stringContaining("Target restrictions on"),
		]);
	});

	it("uses From in mail still held by any mailbox it may read", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const other = await space.mailbox("correspondence");
		const from = "Writer@example.org";
		const id = await receive(other, from);
		const grant = async (readers: string[]) =>
			directory(space.slug, {
				action: "set-mailbox-access",
				mailboxId: other.id,
				everyone: false,
				memberIds: readers,
				senderIds: [],
			});
		await grant([]);
		expect((await agentSends(space, agent, [from])).status).toBe(403);
		await grant([agent.memberId]);
		await saved(agent, { approval: "never", allowed: ["listed@example.net"] });
		expect(
			await stateOf(space, agent, [other.address, "listed@example.net"], [from.toLowerCase()]),
		).toBe("sent");
		expect((await agentSends(space, agent, ["relay@example.org"])).status).toBe(403);
		const removed = await mail.fetch(`${origin}/api/mail/${space.slug}/${other.id}/${id}`, {
			method: "DELETE",
			headers: { ...owner.headers, origin },
		});
		expect(removed.status).toBe(200);
		expect((await agentSends(space, agent, [from])).status).toBe(403);
	});

	it("refuses and logs a proved foreign Reply-To before spending the day's only send", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		await saved(agent, { approval: "never", sendPerDay: 1 });
		const from = "a@sender.test";
		const victim = "victim@elsewhere.test";
		const id = await receive(space.desk, from, [`Reply-To: ${victim}`], "pass");
		const reply = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages/${id}/reply`, {
			text: "Received.",
		});
		expect(reply.status).toBe(403);
		expect(await logOf(agent)).toEqual([{ action: "message.refused", detail: victim }]);
		expect(await messages(space.desk)).toHaveLength(1);
		expect(await sentTo(victim)).toEqual([]);
		expect(await stateOf(space, agent, [from])).toBe("sent");
	});

	it("drops a same-domain Cc on an unproved reply", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const from = "a@freemail.test";
		const id = await receive(space.desk, from, ["Cc: b@freemail.test"]);
		const reply = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages/${id}/reply`, {
			text: "Received.",
		});
		expect(await reply.json()).toMatchObject({ state: "sent" });
		expect(await sentTo(from)).toHaveLength(1);
		expect(await sentTo("b@freemail.test")).toHaveLength(0);
	});

	it("refuses a subdomain Reply-To on proved mail", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const id = await receive(space.desk, "a@sender.test", ["Reply-To: u@sub.sender.test"], "pass");
		const reply = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages/${id}/reply`, {
			text: "Received.",
		});
		expect(reply.status).toBe(403);
		expect(await logOf(agent)).toEqual([
			{ action: "message.refused", detail: "u@sub.sender.test" },
		]);
	});

	it("normalizes IDN, case and a trailing dot in a proved From domain on reply", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const to = "u@xn--bcher-kva.test";
		const id = await receive(space.desk, "a@B\u00dcCHER.TEST.", [`Reply-To: ${to}`], "pass");
		const reply = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages/${id}/reply`, {
			text: "Received.",
		});
		expect(await reply.json()).toMatchObject({ state: "sent" });
		expect(await sentTo(to)).toHaveLength(1);
	});

	it("keeps only permitted Cc on a proved reply", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const colleague = "colleague@sender.test";
		const id = await receive(
			space.desk,
			"a@sender.test",
			[`Cc: victim@elsewhere.test, ${colleague}`],
			"pass",
		);
		const reply = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages/${id}/reply`, {
			text: "Received.",
		});
		expect(await reply.json()).toMatchObject({ state: "sent" });
		expect((await sentTo(colleague)).at(-1)).toMatchObject({ cc: [colleague] });
	});

	it("uses Reply-To only on proved incoming mail and drops unknown Cc on an unproved reply", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const from = "customer@example.com";
		const replyTo = "help@example.com";
		const unknown = "reply-elsewhere@example.net";
		const reply = async (id: string) => {
			const answer = await api(agent, "POST", `/mailboxes/${space.desk.id}/messages/${id}/reply`, {
				text: "Your order arrived.",
			});
			expect(await answer.json()).toMatchObject({ state: "sent" });
		};
		const proved = await receive(space.desk, from, ["Reply-To: help@EXAMPLE.COM."], "pass");
		await reply(proved);
		expect(await sentTo(replyTo)).toHaveLength(1);
		expect(await sentTo(from)).toHaveLength(0);
		const unproved = await receive(
			space.desk,
			from,
			[`Reply-To: ${unknown}`, `Cc: ${unknown}`],
			"fail",
		);
		await reply(unproved);
		expect(await sentTo(from)).toHaveLength(1);
		expect(await sentTo(unknown)).toHaveLength(0);
		expect((await agentSends(space, agent, [replyTo], [], { replyTo: proved })).status).toBe(403);
		const listed = "billing@example.org";
		await saved(agent, { approval: "never", allowed: [listed] });
		const copied = await receive(space.desk, from, [`Cc: ${listed}, ${unknown}`]);
		await reply(copied);
		expect((await sentTo(listed)).map((email) => email.cc)).toEqual([[listed]]);
		expect(await sentTo(unknown)).toHaveLength(0);
		await saved(agent, { approval: "never", anyRecipient: true });
		await reply(unproved);
		expect((await sentTo(unknown)).at(-1)).toMatchObject({ to: [from], cc: [unknown] });
	});
});

describe("a new agent", () => {
	it("is made to send on its own, a few messages a day, with its policy stored", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const made: Policy = {
			sendPerDay: 20,
			approval: "never",
			allowed: [],
			insideWaits: false,
			webhookHosts: [],
			anyRecipient: false,
		};
		expect(agent.policy).toEqual(made);
		expect(await listedPolicy(space, agent)).toEqual(made);
		const row = await mail.db
			.prepare("SELECT send_per_day, allowed, approval FROM agent_policy WHERE member_id = ?")
			.bind(agent.memberId)
			.first();
		expect(row).toEqual({ send_per_day: 20, allowed: "[]", approval: "never" });

		const outside = `ada.${space.slug}@example.org`;
		expect((await agentSends(space, agent, [outside])).status).toBe(403);
		expect(await sentTo(outside)).toHaveLength(0);
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
			webhookHosts: [],
			anyRecipient: false,
		});
		expect(await stateOf(space, agent, [listed])).toBe("sent");
		expect(await stateOf(space, agent, [other])).toBe("held");
		expect(await stateOf(space, agent, [listed], [other])).toBe("held");

		// Under "never" a listed recipient goes and an unknown recipient is refused.
		expect(await saved(agent, { approval: "never", allowed: [listed] })).toMatchObject({
			approval: "never",
		});
		expect(await stateOf(space, agent, [listed])).toBe("sent");
		expect((await agentSends(space, agent, [other])).status).toBe(403);
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
			webhookHosts: [],
			anyRecipient: false,
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
			webhookHosts: [],
			anyRecipient: false,
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
			webhookHosts: [],
			webhookHostsPending: true,
			anyRecipient: false,
		});
		expect(await stateOf(space, agent, [`ada.${space.slug}@example.org`])).toBe("held");
		expect(await stateOf(space, agent, [inside.address])).toBe("held");
		// Its own read of its policy says the same.
		const read = (await (await api(agent, "GET", "/mailboxes")).json()) as {
			sending: Record<string, unknown>;
		};
		expect(read.sending).toEqual({
			perDay: 20,
			approval: "always",
			webhookHosts: [],
			withoutApproval: [],
		});
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
			webhookHosts: [],
			anyRecipient: false,
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
		expect((await agentSends(space, agent, [theirs.desk.address])).status).toBe(403);
		await saved(agent, { approval: "never", allowed: [theirs.desk.address] });
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

	it("sends nothing when it is paused after its key was read, before its message is", async () => {
		const space = await workspace();
		const billing = await space.mailbox("billing");
		const agent = await agentOf(space);
		const keyUsed = async () =>
			(
				await mail.db
					.prepare("SELECT last_used_at FROM agent_key WHERE user_id = ?")
					.bind(agent.id)
					.first<{ last_used_at: number | null }>()
			)?.last_used_at ?? null;
		expect(await keyUsed()).toBeNull();

		// The message arrives slowly: its key is read when the request begins, and the rest of it
		// only once the test lets it through, as a large one's files would over a slow line.
		const whole = new TextEncoder().encode(
			JSON.stringify({
				action: "send",
				draft: crypto.randomUUID(),
				to: [billing.address],
				cc: [`ada.${space.slug}@example.org`],
				subject: "Written while it ran",
				text: "Sent after the pause?",
			}),
		);
		let finish = () => {};
		let abandon = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(whole.slice(0, 20));
				finish = () => {
					controller.enqueue(whole.slice(20));
					controller.close();
				};
				abandon = () => controller.error(new Error("The test gave up on this upload."));
			},
		});
		const answer = mail.fetchStreamed(
			`${origin}/api/mail/${space.slug}/${space.desk.id}/outbox`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${agent.key}`, "content-type": "application/json" },
			},
			body,
		);
		// It may fail while the test is still waiting, before anything awaits it; a failure is still
		// thrown where it is awaited below.
		answer.catch(() => {});
		let finished = false;
		try {
			// The key's use is noted once the key, and whether its agent is paused, has been read.
			for (let waited = 0; (await keyUsed()) === null && waited < 20_000; waited += 100) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(await keyUsed()).not.toBeNull();
			expect((await auth("/agents/pause", { agentId: agent.id })).status).toBe(200);
			finished = true;
			finish();

			const response = await answer;
			expect(response.status).toBe(403);
			expect(((await response.json()) as { error: string }).error).toMatch(
				/^This agent is paused\./,
			);
		} finally {
			// Should the test fail before it lets the message through, the upload is broken off, never
			// finished: finishing it would send what the test expects refused. Either way the request
			// has ended before the test does, so nothing of it is left for the next one.
			if (!finished) abandon();
			await answer.catch(() => {});
		}
		expect(await messages(billing)).toHaveLength(0);
		expect(await sentTo(`ada.${space.slug}@example.org`)).toHaveLength(0);
		expect(await logOf(agent)).toEqual([]);
	});

	it("sends nothing inside its workspace when it is paused while the directory is asked", async () => {
		const space = await workspace();
		const billing = await space.mailbox("billing");
		const agent = await agentOf(space);
		// Everything waits, so mail inside the workspace goes only once the directory and DNS said
		// it stays there, which is when the pause lands: as DNS is asked, before it answers.
		await saved(agent, { approval: "always" });
		let paused = 0;
		beforeAnswering.set(space.domain, async () => {
			paused = (await auth("/agents/pause", { agentId: agent.id })).status;
		});
		const response = await agentSends(space, agent, [billing.address]);
		expect(paused).toBe(200);
		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: string }).error).toMatch(/^This agent is paused\./);
		expect(await messages(billing)).toHaveLength(0);
		expect(await logOf(agent)).toEqual([]);
	});

	it("sends nothing inside its workspace when it is deleted while the directory is asked", async () => {
		const space = await workspace();
		const billing = await space.mailbox("billing");
		const agent = await agentOf(space);
		await saved(agent, { approval: "always" });
		// Deleting an agent takes its membership, and any pause, with it: nothing is left to say it
		// was stopped but that it is gone.
		let deleted = 0;
		beforeAnswering.set(space.domain, async () => {
			deleted = (await auth("/agents/delete", { agentId: agent.id })).status;
		});
		const response = await agentSends(space, agent, [billing.address]);
		expect(deleted).toBe(200);
		// As a revoked key is refused.
		expect(response.status).toBe(404);
		expect(await messages(billing)).toHaveLength(0);
		// Not even a copy in the mailbox it wrote from, and nothing in a log of its own.
		expect(await messages(space.desk)).toHaveLength(0);
		expect(await sentTo(billing.address)).toHaveLength(0);
		expect(await logOf(agent)).toEqual([]);
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
				allowed: [listed],
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

describe("the workspace's day", () => {
	/** Writes until the workspace's day is used up, and gives the answer to the message after. */
	async function afterTheLast(space: Space, agent: Agent, to: () => string) {
		for (let sent = 0; sent < SEND_PER_DAY; sent++) {
			expect(await stateOf(space, agent, [to()]), `message ${sent + 1}`).toBe("sent");
		}
		return agentSends(space, agent, [to()]);
	}

	it("refuses what an agent that sends on its own writes after the workspace's last", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		expect(agent.policy.sendPerDay).toBeGreaterThan(SEND_PER_DAY);
		await saved(agent, { approval: "never", allowed: ["@example.org"] });
		let n = 0;
		const over = await afterTheLast(space, agent, () => `day${++n}.${space.slug}@example.org`);
		expect(over.status).toBe(429);
		expect(((await over.json()) as { error: string }).error).toMatch(/^This workspace has sent/);
		expect(await sentTo(`day${n}.${space.slug}@example.org`)).toHaveLength(0);
	});

	it("refuses mail inside the workspace after its last too, though it waits for nobody", async () => {
		const space = await workspace();
		const billing = await space.mailbox("billing");
		const agent = await agentOf(space);
		// Everything else waits, so only mail that stays inside goes, and counts as it goes.
		await saved(agent, { approval: "always" });
		const over = await afterTheLast(space, agent, () => billing.address);
		expect(over.status).toBe(429);
		expect(((await over.json()) as { error: string }).error).toMatch(/^This workspace has sent/);
		expect(await messages(billing)).toHaveLength(SEND_PER_DAY);
	});
});

describe("an agent, of its own policy", () => {
	it("reads it, and what it reads is what happens", async () => {
		const space = await workspace();
		const agent = await agentOf(space);
		const sending = async () =>
			((await (await api(agent, "GET", "/mailboxes")).json()) as { sending: unknown }).sending;
		expect(await sending()).toEqual({
			perDay: 20,
			approval: "never",
			webhookHosts: [],
			withoutApproval: [],
		});
		await saved(agent, {
			approval: "never",
			allowed: ["@acme.test"],
			webhookHosts: ["hooks.example.org"],
		});
		expect(await sending()).toMatchObject({
			withoutApproval: ["@acme.test"],
			webhookHosts: ["hooks.example.org"],
		});
		await saved(agent, {
			sendPerDay: 5,
			approval: "unlisted",
			allowed: ["@acme.test"],
			webhookHosts: [],
		});
		expect(await sending()).toEqual({
			perDay: 5,
			approval: "unlisted",
			webhookHosts: [],
			withoutApproval: ["@acme.test"],
		});
		// A list kept under another choice lets nothing through, so it isn't given as one that does.
		await saved(agent, { sendPerDay: 5, approval: "always", allowed: ["@acme.test"] });
		expect(await sending()).toEqual({
			perDay: 5,
			approval: "always",
			webhookHosts: [],
			withoutApproval: [],
		});
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
			webhookHosts: [],
			anyRecipient: false,
		});

		// And a send answers in the same shape, held or sent.
		await saved(agent, { approval: "never", allowed: [outside] });
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

		await saved(agent, { approval: "never", allowed: [outside] });
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
		// Long enough for one too many to come: a `message.held` before a `message.sent` for mail
		// that never waited would be an event nobody should hear.
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		// Everything told of each message, in the order it came, and of no other message.
		const sequence = (id: string) =>
			mine()
				.filter((one) => one.message === id)
				.map((one) => one.type);
		expect(mine()).toHaveLength(3);
		expect(sequence(alone.id)).toEqual(["message.sent"]);
		expect(sequence(inside.id)).toEqual(["message.sent"]);
		expect(sequence(waits.id)).toEqual(["message.held"]);

		// Its log names each message it sent on its own, with whom it went to.
		expect(await logOf(agent)).toEqual([
			{ action: "message.sent", detail: outside },
			{ action: "message.sent", detail: billing.address },
			{ action: "message.held", detail: outside },
		]);
	});
});
