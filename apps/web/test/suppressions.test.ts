import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type QueuedMessage, type SentEmail, startMail } from "./mail-worker";

// Each workspace's suppression list: what Email Service's delivery events add to it through the
// queue, sending refusing what it holds, and owners and admins listing and removing entries.

const origin = "https://mail.test";
const QUEUE = "gateweave-mail-events";
const DAY = 24 * 60 * 60 * 1000;

const proofs = new Map<string, string>();

function dns(request: Request): Response {
	const url = new URL(request.url);
	const value = proofs.get(url.searchParams.get("name") ?? "");
	if (!value || url.searchParams.get("type") !== "TXT") return Response.json({ Status: 3 });
	return Response.json({
		Status: 0,
		Answer: [{ name: url.searchParams.get("name"), type: 16, data: `"${value}"` }],
	});
}

let mail: Awaited<ReturnType<typeof startMail>>;
let owner: Awaited<ReturnType<typeof signUp>>;
let counter = 0;

interface Entry {
	id: string;
	address: string;
	reason: string;
	provider: string;
	detail: string | null;
	firstAt: number;
	lastAt: number;
	expiresAt: number | null;
}

interface Refusal {
	ok: false;
	error: string;
	suppressed: string[];
}

async function directory(slug: string, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers: { ...owner.headers, origin, "content-type": "application/json" },
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as {
		domains: { id: string; name: string; proof: { value: string } | null }[];
		mailboxes: { id: string; name: string }[];
	};
}

/** A workspace of its own, with a proved domain and a mailbox with one address, help@. */
async function mailboxWithAddress() {
	const n = ++counter;
	const slug = `suppress-${n}`;
	const domain = `suppress${n}.example.com`;
	const workspaceId = await createWorkspace(
		mail,
		origin,
		{ ...owner.headers, "cf-connecting-ip": `198.51.100.${n}` },
		slug,
	);
	await directory(slug, { action: "add-domain", name: domain });
	const [added] = (await directory(slug)).domains;
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
	await directory(slug, { action: "check-domain", id: added.id });
	await directory(slug, { action: "add-mailbox", name: `Support ${n}` });
	const made = (await directory(slug)).mailboxes.find((box) => box.name === `Support ${n}`);
	if (!made) throw new Error("expected a mailbox");
	await directory(slug, {
		action: "add-address",
		domainId: added.id,
		mailboxId: made.id,
		localPart: "help",
		expiresInDays: null,
	});
	return { slug, workspaceId, domain, mailboxId: made.id, address: `help@${domain}` };
}

type Box = Awaited<ReturnType<typeof mailboxWithAddress>>;

function outbox(box: Box, body: unknown, headers: Record<string, string> = owner.headers) {
	return mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
		method: "POST",
		headers: { ...headers, origin, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const writing = (to: string[], draft: string = crypto.randomUUID()) => ({
	action: "send",
	draft,
	to,
	subject: `Hello ${++counter}`,
	text: "Hello there.",
});

/** Sends from the mailbox as its owner, and gives the id Email Service gave the message. */
async function sent(box: Box, to: string[]) {
	const body = writing(to);
	const response = await outbox(box, body);
	expect(response.status).toBe(200);
	const answer = (await response.json()) as { id: string; threadId: string; state: string };
	expect(answer.state).toBe("sent");
	const handed = (await mail.emails()).find((email: SentEmail) => email.subject === body.subject);
	if (!handed) throw new Error("expected the message at Email Service");
	return { ...answer, messageId: handed.messageId };
}

let queued = 0;

/**
 * An Email Sending event on the queue, from the mailbox's address. Without a message id, it is about
 * a message the mailbox doesn't have, as for a send Email Service refused, which gets none.
 */
function event(
	box: Box,
	type: string,
	recipient: string,
	{
		payload = {},
		at = Date.now(),
		messageId = `<not-sent-${queued}@outbox.test>`,
	}: { payload?: Record<string, unknown>; at?: number; messageId?: string } = {},
): QueuedMessage {
	return {
		id: `queued-${++queued}`,
		timestamp: new Date(),
		attempts: 1,
		body: {
			type: `cf.email.sending.message.${type}`,
			source: { zoneId: "zone", domain: box.domain, type: "email.sending" },
			metadata: { eventTimestamp: new Date(at).toISOString() },
			payload: {
				eventId: crypto.randomUUID(),
				messageId,
				sender: box.address,
				recipient,
				subject: "Hello",
				terminal: true,
				delivery: { status: type, provider: "external_smtp" },
				...payload,
			},
		},
	};
}

const hardBounce = (reason = "550 5.1.1 User unknown") => ({ bounce: { type: "hard", reason } });
const complaint = { complaint: { type: "abuse" } };
const listRefusal = (detail = "Recipient is suppressed") => ({
	rejection: { reason: "suppressed", party: "recipient", detail },
});

async function list(
	slug: string,
	{ q = "", before = "" }: { q?: string; before?: string } = {},
	headers: Record<string, string> = owner.headers,
) {
	const params = new URLSearchParams();
	if (q) params.set("q", q);
	if (before) params.set("before", before);
	const response = await mail.fetch(`${origin}/api/suppressions/${slug}?${params}`, { headers });
	return {
		status: response.status,
		body: (await response.json()) as { suppressions?: Entry[]; next?: string | null },
	};
}

async function entries(slug: string, q = "") {
	const { status, body } = await list(slug, { q });
	expect(status).toBe(200);
	return body.suppressions ?? [];
}

function remove(slug: string, id: string, headers: Record<string, string> = owner.headers) {
	return mail.fetch(`${origin}/api/suppressions/${slug}`, {
		method: "POST",
		headers: { ...headers, origin, "content-type": "application/json" },
		body: JSON.stringify({ action: "remove", id }),
	});
}

/** Someone new in the workspace, with this role. */
async function join(workspaceId: string, role = "member") {
	const who = await signUp(mail, origin, `Reader${++counter}`);
	const memberId = crypto.randomUUID();
	await mail.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(memberId, workspaceId, who.userId, role, Date.now())
		.run();
	return { ...who, memberId };
}

/** An agent of the workspace that may send from the mailbox, read by `reader` too. */
async function sendingAgent(box: Box, reader: { memberId: string }) {
	const made = await mail.fetch(`${origin}/api/auth/agents/create`, {
		method: "POST",
		headers: { ...owner.headers, origin, "content-type": "application/json" },
		body: JSON.stringify({ organizationId: box.workspaceId, name: "Sorter" }),
	});
	expect(made.status).toBe(200);
	const { agent, key } = (await made.json()) as {
		agent: { id: string; memberId: string };
		key: string;
	};
	await directory(box.slug, {
		action: "set-mailbox-access",
		mailboxId: box.mailboxId,
		everyone: false,
		memberIds: [agent.memberId, reader.memberId],
		senderIds: [agent.memberId],
	});
	const policy = async (sendPerDay: number) => {
		const set = await mail.fetch(`${origin}/api/auth/agents/set-policy`, {
			method: "POST",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify({ agentId: agent.id, sendPerDay, allowed: [] }),
		});
		expect(set.status).toBe(200);
	};
	const send = (to: string[]) =>
		mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify(writing(to)),
		});
	return { policy, send };
}

async function rows(workspaceId: string) {
	const { results } = await mail.db
		.prepare("SELECT address FROM mail_suppression WHERE organization_id = ? ORDER BY address")
		.bind(workspaceId)
		.all();
	return results.map((row: Record<string, unknown>) => String(row.address));
}

beforeAll(async () => {
	mail = await startMail(origin, {
		hosts: { "dns.test": dns },
		settings: { DNS_RESOLVER_URL: "https://dns.test/dns-query" },
	});
	owner = await signUp(mail, origin, "Owner");
});

afterAll(() => mail.dispose());

describe("what goes on a workspace's suppression list", () => {
	it("a complaint or a hard bounce about its mail, and the provider's refusal, nothing milder", async () => {
		const box = await mailboxWithAddress();
		const message = await sent(box, [
			"Ada@Example.org",
			"bob@example.org",
			"grace@example.org",
			"zoe@example.org",
		]);
		const about = (at: number) => ({ at, messageId: message.messageId });
		const at = Date.now() - 1000;
		const outcome = await mail.runQueue(QUEUE, [
			event(box, "bounced", "ada@example.org", { ...about(at), payload: hardBounce() }),
			event(box, "bounced", "bob@example.org", {
				...about(at),
				payload: hardBounce("554 5.7.1 Policy"),
			}),
			event(box, "complained", "grace@example.org", { ...about(at), payload: complaint }),
			event(box, "rejected", "lin@example.org", { at, payload: listRefusal() }),
			event(box, "bounced", "zoe@example.org", {
				...about(at),
				payload: { bounce: { type: "soft", reason: "452 4.2.2 Mailbox full" } },
			}),
			event(box, "deferred", "zoe@example.org", about(at)),
			event(box, "failed", "zoe@example.org", {
				...about(at),
				payload: { failure: { reason: "delivery_failed" } },
			}),
			event(box, "rejected", "zoe@example.org", {
				at,
				payload: { rejection: { reason: "validation" } },
			}),
		]);
		expect(outcome.retryMessages.every(({ delaySeconds }) => delaySeconds === 60)).toBe(true);
		const found = await entries(box.slug);
		const by = (address: string) => found.find((entry) => entry.address === address);
		expect(found.map(({ address }) => address).sort()).toEqual([
			"ada@example.org",
			"bob@example.org",
			"grace@example.org",
			"lin@example.org",
		]);
		expect(by("ada@example.org")).toMatchObject({
			reason: "bounced",
			provider: "cloudflare",
			detail: "550 5.1.1 User unknown",
			firstAt: at,
			expiresAt: null,
		});
		expect(by("bob@example.org")).toMatchObject({ reason: "bounced", expiresAt: at + 7 * DAY });
		expect(by("grace@example.org")).toMatchObject({ reason: "complained", expiresAt: null });
		expect(by("lin@example.org")).toMatchObject({
			reason: "rejected",
			detail: "Recipient is suppressed",
			expiresAt: at + 7 * DAY,
		});
	});

	it("not a bounce or a complaint about mail the mailbox has no record of sending", async () => {
		const box = await mailboxWithAddress();
		await mail.runQueue(QUEUE, [
			event(box, "complained", "ada@example.org", { payload: complaint }),
			event(box, "bounced", "bob@example.org", { payload: hardBounce() }),
		]);
		expect(await rows(box.workspaceId)).toEqual([]);
	});

	it("keeps the stronger reason, the later end and the newer words, in any order", async () => {
		const box = await mailboxWithAddress();
		const { messageId } = await sent(box, ["ada@example.org", "bob@example.org"]);
		const at = Date.now() - 10_000;
		// Weaker, then stronger, then a late weaker one: the complaint stays, for good.
		await mail.runQueue(QUEUE, [
			event(box, "rejected", "ada@example.org", { at, payload: listRefusal() }),
		]);
		await mail.runQueue(QUEUE, [
			event(box, "complained", "ada@example.org", { at: at + 1000, messageId, payload: complaint }),
		]);
		await mail.runQueue(QUEUE, [
			event(box, "bounced", "ada@example.org", {
				at: at + 500,
				messageId,
				payload: hardBounce("554 5.7.1 Policy"),
			}),
		]);
		// The other way round: the stronger one first.
		await mail.runQueue(QUEUE, [
			event(box, "complained", "bob@example.org", { at: at + 1000, messageId, payload: complaint }),
		]);
		await mail.runQueue(QUEUE, [
			event(box, "rejected", "bob@example.org", { at, payload: listRefusal() }),
		]);
		// Of the same reason, the newer event's words, whichever comes last.
		await mail.runQueue(QUEUE, [
			event(box, "rejected", "lin@example.org", { at: at + 2000, payload: listRefusal("newer") }),
		]);
		await mail.runQueue(QUEUE, [
			event(box, "rejected", "lin@example.org", { at: at + 1000, payload: listRefusal("older") }),
		]);
		const found = await entries(box.slug);
		const by = (address: string) => found.find((entry) => entry.address === address);
		for (const address of ["ada@example.org", "bob@example.org"]) {
			expect(by(address)).toMatchObject({
				reason: "complained",
				firstAt: at,
				lastAt: at + 1000,
				expiresAt: null,
			});
		}
		expect(by("lin@example.org")).toMatchObject({
			detail: "newer",
			firstAt: at + 1000,
			lastAt: at + 2000,
			expiresAt: at + 2000 + 7 * DAY,
		});
	});

	it("nothing from an event whose entry has already ended", async () => {
		const box = await mailboxWithAddress();
		const { messageId } = await sent(box, ["ada@example.org"]);
		await mail.runQueue(QUEUE, [
			event(box, "bounced", "ada@example.org", {
				at: Date.now() - 8 * DAY,
				messageId,
				payload: hardBounce("554 5.7.1 Policy"),
			}),
		]);
		expect(await rows(box.workspaceId)).toEqual([]);
		expect((await outbox(box, writing(["ada@example.org"]))).status).toBe(200);
	});

	it("is the workspace's own", async () => {
		const box = await mailboxWithAddress();
		const other = await mailboxWithAddress();
		const { messageId } = await sent(box, [
			"ada@example.org",
			"bob@example.org",
			"lin@example.org",
		]);
		await mail.runQueue(QUEUE, [
			event(box, "complained", "ada@example.org", { messageId, payload: complaint }),
		]);
		expect(await entries(other.slug)).toEqual([]);
		expect((await outbox(other, writing(["ada@example.org"]))).status).toBe(200);
		const [entry] = await entries(box.slug);
		if (!entry) throw new Error("expected an entry");
		// Another workspace's admin can't remove it by its id.
		expect((await remove(other.slug, entry.id)).status).toBe(404);
		expect(await entries(box.slug)).toHaveLength(1);
		// Events from another domain's subscription, or from an address that isn't a mailbox's, add
		// nothing.
		const elsewhere = event(box, "complained", "bob@example.org", {
			messageId,
			payload: complaint,
		});
		await mail.runQueue(QUEUE, [
			{
				...elsewhere,
				body: {
					...(elsewhere.body as object),
					source: { type: "email.sending", domain: other.domain },
				},
			},
			event({ ...box, address: `notifications@${box.domain}` }, "complained", "lin@example.org", {
				messageId,
				payload: complaint,
			}),
		]);
		expect((await entries(box.slug)).map(({ address }) => address)).toEqual(["ada@example.org"]);
		expect(await entries(other.slug)).toEqual([]);
	});

	it("is logged as how many, never who", async () => {
		const box = await mailboxWithAddress();
		const { messageId } = await sent(box, ["private.person@example.org"]);
		await mail.runQueue(QUEUE, [
			event(box, "complained", "private.person@example.org", { messageId, payload: complaint }),
		]);
		const lines = mail.logs.filter(({ message }) => message.startsWith("delivery events:"));
		expect(lines.at(-1)?.message).toContain('"suppressed":1');
		expect(mail.logs.map(({ message }) => message).join("\n")).not.toContain("private.person");
	});
});

describe("sending to an address on the list", () => {
	it("is refused, naming it, until an admin removes it, and a draft already sent still answers", async () => {
		const box = await mailboxWithAddress();
		const first = writing(["grace@example.org"]);
		const graceSent = await outbox(box, first);
		const graceAnswer = (await graceSent.json()) as { id: string; state: string };
		const handed = (await mail.emails()).find((email) => email.subject === first.subject);
		const { messageId } = await sent(box, ["ada@example.org"]);
		const bouncedAt = Date.now() - 1000;
		await mail.runQueue(QUEUE, [
			event(box, "bounced", "ada@example.org", { at: bouncedAt, messageId, payload: hardBounce() }),
			event(box, "complained", "grace@example.org", {
				messageId: handed?.messageId,
				payload: complaint,
			}),
		]);
		// The draft that went before is what became of it, whatever came since.
		const repeated = await outbox(box, first);
		expect(repeated.status).toBe(200);
		expect(await repeated.json()).toMatchObject({ id: graceAnswer.id, state: "sent" });

		const before = (await mail.emails()).length;
		const draft = crypto.randomUUID();
		const refused = await outbox(box, writing(["Ada@Example.org", "lin@example.org"], draft));
		expect(refused.status).toBe(409);
		const said = (await refused.json()) as Refusal;
		expect(said.suppressed).toEqual(["ada@example.org"]);
		expect(said.error).toContain("ada@example.org (bounced)");
		expect(said.error).toContain("Settings, under Suppressions");
		expect(await mail.emails()).toHaveLength(before);

		const ada = (await entries(box.slug)).find((entry) => entry.address === "ada@example.org");
		if (!ada) throw new Error("expected an entry");
		expect((await remove(box.slug, ada.id)).status).toBe(200);
		expect((await entries(box.slug)).map(({ address }) => address)).toEqual(["grace@example.org"]);
		const again = await remove(box.slug, ada.id);
		expect(again.status).toBe(404);
		expect(await again.json()).toMatchObject({ gone: true });
		// The same draft goes now: nothing of it was kept.
		const went = await outbox(box, writing(["ada@example.org", "lin@example.org"], draft));
		expect(went.status).toBe(200);
		expect(((await went.json()) as { state: string }).state).toBe("sent");

		// The bounce again, as a queue may hand it over again, doesn't put it back; a new one does.
		await mail.runQueue(QUEUE, [
			event(box, "bounced", "ada@example.org", { at: bouncedAt, messageId, payload: hardBounce() }),
		]);
		expect((await entries(box.slug)).map(({ address }) => address)).toEqual(["grace@example.org"]);
		await mail.runQueue(QUEUE, [
			event(box, "bounced", "ada@example.org", {
				messageId,
				payload: hardBounce("550 5.1.1 Gone"),
			}),
		]);
		expect(
			(await entries(box.slug)).find((entry) => entry.address === "ada@example.org"),
		).toMatchObject({ reason: "bounced", detail: "550 5.1.1 Gone" });
	});

	it("refuses to try again a message whose address came onto it since", async () => {
		const box = await mailboxWithAddress();
		const blocked = "refuse-E_RECIPIENT_SUPPRESSED@example.org";
		const first = await outbox(box, writing([blocked]));
		const answer = (await first.json()) as { id: string; state: string; code: string };
		expect(answer).toMatchObject({ state: "refused", code: "E_RECIPIENT_SUPPRESSED" });
		// Email Service tells of the refusal as an event, which names the address.
		await mail.runQueue(QUEUE, [event(box, "rejected", blocked, { payload: listRefusal() })]);
		const again = await outbox(box, { action: "send-again", message: answer.id });
		expect(again.status).toBe(409);
		expect(((await again.json()) as Refusal).suppressed).toEqual([blocked.toLowerCase()]);
	});

	it("stops a message that waited, when its address came onto it meanwhile", {
		timeout: 60_000,
	}, async () => {
		const box = await mailboxWithAddress();
		const busy = `busy-1@${box.slug}.example.org`;
		const body = writing([busy]);
		const waiting = (await (await outbox(box, body)).json()) as {
			id: string;
			threadId: string;
			state: string;
		};
		expect(waiting.state).toBe("waiting");
		await mail.runQueue(QUEUE, [event(box, "rejected", busy, { payload: listRefusal() })]);
		let status: { state: string; code: string | null } | undefined;
		for (let waited = 0; status?.state !== "refused" && waited < 45_000; waited += 1_000) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			const response = await mail.fetch(
				`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${waiting.threadId}`,
				{ headers: owner.headers },
			);
			const page = (await response.json()) as {
				messages: { sent: { status: { state: string; code: string | null } } }[];
			};
			status = page.messages[0]?.sent.status;
		}
		expect(status).toMatchObject({ state: "refused", code: "mail:suppressed" });
		expect((await mail.emails()).filter((email) => email.subject === body.subject)).toEqual([]);
	});

	it("is refused for an agent once its own day has counted it, and its approval without reasons", async () => {
		const box = await mailboxWithAddress();
		const reader = await join(box.workspaceId);
		const agent = await sendingAgent(box, reader);
		const { messageId } = await sent(box, ["ada@example.org"]);
		await mail.runQueue(QUEUE, [
			event(box, "complained", "ada@example.org", { messageId, payload: complaint }),
		]);

		// An agent not let send learns nothing of the list.
		await agent.policy(0);
		expect((await agent.send(["ada@example.org"])).status).toBe(403);
		await agent.policy(2);

		// Held for approval, then its address comes onto the list before anyone approves it.
		const written = await agent.send(["grace@example.org"]);
		const held = (await written.json()) as { id: string; state: string };
		expect(held.state).toBe("held");
		await mail.runQueue(QUEUE, [
			event(box, "rejected", "grace@example.org", { payload: listRefusal() }),
		]);
		const approve = await outbox(box, { action: "approve", message: held.id }, reader.headers);
		expect(approve.status).toBe(409);
		const told = (await approve.json()) as Refusal;
		expect(told.suppressed).toEqual(["grace@example.org"]);
		// A member who may not see the list isn't told why.
		expect(told.error).not.toContain("(on the provider's list)");

		// Its own day counts a refusal, the second of two, so a key can't test addresses for free,
		// and it isn't told why either.
		const refused = await agent.send(["ada@example.org"]);
		expect(refused.status).toBe(409);
		const said = (await refused.json()) as Refusal;
		expect(said.suppressed).toEqual(["ada@example.org"]);
		expect(said.error).not.toContain("spam)");
		expect((await agent.send(["lin@example.org"])).status).toBe(429);
	});
});

describe("the list's page", () => {
	it("shows only to owners and admins, and changes only from the app", async () => {
		const box = await mailboxWithAddress();
		await mail.runQueue(QUEUE, [
			event(box, "rejected", "ada@example.org", { payload: listRefusal() }),
		]);
		const [entry] = await entries(box.slug);
		if (!entry) throw new Error("expected an entry");
		const member = await join(box.workspaceId);
		expect((await list(box.slug, {}, member.headers)).status).toBe(403);
		expect((await remove(box.slug, entry.id, member.headers)).status).toBe(403);
		const admin = await join(box.workspaceId, "admin");
		expect((await list(box.slug, {}, admin.headers)).status).toBe(200);
		const stranger = await signUp(mail, origin, "Stranger");
		expect((await list(box.slug, {}, stranger.headers)).status).toBe(404);
		// The session cookie, sent from another site or from none.
		for (const from of [{ origin: "https://elsewhere.test" }, {}] as Record<string, string>[]) {
			const elsewhere = await mail.fetch(`${origin}/api/suppressions/${box.slug}`, {
				method: "POST",
				headers: { cookie: owner.headers.cookie, "content-type": "application/json", ...from },
				body: JSON.stringify({ action: "remove", id: entry.id }),
			});
			expect(elsewhere.status).toBe(403);
		}
		expect(await entries(box.slug)).toHaveLength(1);
	});

	it("searches any part of an address, however long, taking every character as it is", async () => {
		const box = await mailboxWithAddress();
		const long = `${"a.very.long.name".repeat(4)}_x@example.org`;
		await mail.runQueue(QUEUE, [
			event(box, "rejected", long, { payload: listRefusal() }),
			event(box, "rejected", "grace@example.org", { payload: listRefusal() }),
		]);
		expect((await entries(box.slug, long.toUpperCase())).map((e) => e.address)).toEqual([long]);
		expect((await entries(box.slug, "_x@")).map((e) => e.address)).toEqual([long]);
		expect((await entries(box.slug, "GRACE")).map((e) => e.address)).toEqual(["grace@example.org"]);
		expect(await entries(box.slug, "%")).toEqual([]);
	});

	it("lists the most recent first, a page at a time, each entry once", async () => {
		const box = await mailboxWithAddress();
		const base = Date.now() - 60_000;
		// Five to a time, so that pages break among entries of the same time.
		await mail.runQueue(
			QUEUE,
			Array.from({ length: 55 }, (_, i) =>
				event(box, "rejected", `p${i}@example.org`, {
					at: base + Math.floor(i / 5) * 1000,
					payload: listRefusal(),
				}),
			),
		);
		const first = await list(box.slug);
		expect(first.body.suppressions).toHaveLength(50);
		expect(first.body.next).toEqual(expect.any(String));
		const second = await list(box.slug, { before: first.body.next ?? "" });
		expect(second.body.next).toBeNull();
		const all = [...(first.body.suppressions ?? []), ...(second.body.suppressions ?? [])];
		expect(new Set(all.map(({ address }) => address)).size).toBe(55);
		const ordered = [...all].sort((a, b) => b.lastAt - a.lastAt || (b.id < a.id ? -1 : 1));
		expect(all.map(({ id }) => id)).toEqual(ordered.map(({ id }) => id));
	});

	it("is pruned of ended entries, and of removed ones once no older event can come", async () => {
		const box = await mailboxWithAddress();
		await mail.runQueue(
			QUEUE,
			["ended", "removed-long-ago", "removed-now", "live"].map((name) =>
				event(box, "rejected", `${name}@example.org`, { payload: listRefusal() }),
			),
		);
		for (const entry of await entries(box.slug)) {
			if (entry.address.startsWith("removed")) {
				expect((await remove(box.slug, entry.id)).status).toBe(200);
			}
		}
		await mail.db
			.prepare("UPDATE mail_suppression SET expires_at = ? WHERE address = 'ended@example.org'")
			.bind(Date.now() - 1000)
			.run();
		await mail.db
			.prepare(
				"UPDATE mail_suppression SET removed_at = ? WHERE address = 'removed-long-ago@example.org'",
			)
			.bind(Date.now() - 16 * DAY)
			.run();
		await mail.runScheduled();
		expect(await rows(box.workspaceId)).toEqual(["live@example.org", "removed-now@example.org"]);
	});
});
