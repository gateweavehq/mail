import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startMail } from "./mail-worker";

// What became of mail sent through Resend: the built Worker in workerd, and a stand-in for Resend's
// API that sends nothing, gives each message an id, and keeps the webhooks Mail makes. Events go to
// the webhook's address signed as Resend's are, one recipient each, as measured on 2026-11-09.

const origin = "https://mail.test";
const FULL_KEY = "re_FullAccess_1234567890abcd";
const SENDING_KEY = "re_SendingOnly_0987654321wxyz";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

interface Webhook {
	id: string;
	endpoint: string;
	events: string[];
	secret: string;
	status: "enabled" | "disabled";
}

const webhooks = new Map<string, Webhook>();
/** Each request Resend's API got, as its method and path. */
const asked: string[] = [];
/** What Resend was asked to send, with the id it gave. */
const emails: { id: string; subject: string; to: string[]; cc: string[] }[] = [];

const restricted = () =>
	Response.json(
		{ name: "restricted_api_key", message: "This API key is restricted to only send emails" },
		{ status: 401 },
	);

async function resend(request: Request): Promise<Response> {
	const url = new URL(request.url);
	asked.push(`${request.method} ${url.pathname}`);
	const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	if (key !== FULL_KEY && key !== SENDING_KEY) {
		return Response.json({ name: "validation_error" }, { status: 400 });
	}
	if (url.pathname === "/emails" && request.method === "POST") {
		const body = (await request.json()) as { subject: string; to: string[]; cc?: string[] };
		const id = crypto.randomUUID();
		emails.push({ id, subject: body.subject, to: body.to, cc: body.cc ?? [] });
		return Response.json({ id });
	}
	if (key === SENDING_KEY) return restricted();
	if (url.pathname === "/domains") return Response.json({ data: [] });
	if (url.pathname === "/webhooks" && request.method === "POST") {
		const body = (await request.json()) as { endpoint: string; events: string[] };
		const id = crypto.randomUUID();
		const secret = `whsec_${randomBytes(24).toString("base64")}`;
		webhooks.set(id, {
			id,
			endpoint: body.endpoint,
			events: body.events,
			secret,
			status: "enabled",
		});
		return Response.json({ object: "webhook", id, signing_secret: secret }, { status: 201 });
	}
	const webhook = /^\/webhooks\/([^/]+)$/.exec(url.pathname)?.[1];
	const found = webhook ? webhooks.get(webhook) : undefined;
	if (!webhook || !found) return Response.json({ name: "not_found" }, { status: 404 });
	if (request.method === "DELETE") webhooks.delete(webhook);
	if (request.method === "PATCH") {
		const body = (await request.json()) as Partial<Webhook>;
		Object.assign(found, body);
	}
	return Response.json({ object: "webhook", ...found, secret: undefined });
}

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

interface Directory {
	domains: {
		id: string;
		sendsWith: string;
		eventsAt: number | null;
		proof: { value: string } | null;
	}[];
	mailboxes: { id: string; name: string }[];
	resendReceiving: { ready: boolean; trouble: string | null } | null;
}

async function directory(slug: string, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers: { ...owner.headers, origin },
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	return {
		status: response.status,
		body: (await response.json()) as Directory & { ok?: boolean; note?: string; error?: string },
	};
}

/** A workspace of its own: a proved domain, a mailbox with help@ on it, and a Resend key. */
async function workspace(key = FULL_KEY) {
	const n = ++counter;
	const slug = `resend-events-${n}`;
	const domain = `events${n}.example.com`;
	const workspaceId = await createWorkspace(
		mail,
		origin,
		{ ...owner.headers, "cf-connecting-ip": `198.51.100.${n}` },
		slug,
	);
	await directory(slug, { action: "add-domain", name: domain });
	const [added] = (await directory(slug)).body.domains;
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
	await directory(slug, { action: "check-domain", id: added.id });
	await directory(slug, { action: "add-mailbox", name: `Support ${n}` });
	const made = (await directory(slug)).body.mailboxes.find((one) => one.name === `Support ${n}`);
	if (!made) throw new Error("expected a mailbox");
	await directory(slug, {
		action: "add-address",
		domainId: added.id,
		mailboxId: made.id,
		localPart: "help",
		expiresInDays: null,
	});
	await setKey(workspaceId, key);
	return { slug, workspaceId, domain, domainId: added.id, mailboxId: made.id };
}

/** Gives the workspace a Resend key, and what its domains can't do with it, if anything. */
async function setKey(workspaceId: string, key: string) {
	const response = await mail.fetch(`${origin}/api/auth/providers/set-key`, {
		method: "POST",
		headers: {
			...owner.headers,
			origin,
			"content-type": "application/json",
			"cf-connecting-ip": `203.0.113.${++counter}`,
		},
		body: JSON.stringify({ organizationId: workspaceId, provider: "resend", key }),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { access: string; note: string | null };
}

type Box = Awaited<ReturnType<typeof workspace>>;

/** Makes the workspace's webhook look unused for that long, as the daily run would find it. */
async function unusedFor(box: Box, ms: number) {
	await mail.db
		.prepare("UPDATE resend_inbound SET unused_since = ? WHERE organization_id = ?")
		.bind(Date.now() - ms, box.workspaceId)
		.run();
}

async function unusedSince(box: Box) {
	const row = await mail.db
		.prepare("SELECT unused_since AS since FROM resend_inbound WHERE organization_id = ?")
		.bind(box.workspaceId)
		.first<{ since: number | null }>();
	return row?.since;
}

/** Each workspace's webhook, noted when it is made. */
const webhookOf = new Map<string, string>();

/** Sets the box's domain to send with Resend, noting the webhook that makes. */
async function sendingWithResend(box: Box) {
	const before = new Set(webhooks.keys());
	const answer = await directory(box.slug, {
		action: "set-domain-sending",
		id: box.domainId,
		sendsWith: "resend",
	});
	expect(answer.status).toBe(200);
	const made = [...webhooks.values()].find((one) => !before.has(one.id));
	if (made) webhookOf.set(box.slug, made.id);
	return answer.body;
}

function hookOf(box: Box): Webhook {
	const found = webhooks.get(webhookOf.get(box.slug) ?? "");
	if (!found) throw new Error("expected a webhook");
	return found;
}

/** Sends from the box's help@, and gives Resend's id for the message. */
async function send(box: Box, to: string[], cc: string[] = []) {
	const subject = `Hello ${++counter}`;
	const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
		method: "POST",
		headers: { ...owner.headers, origin, "content-type": "application/json" },
		body: JSON.stringify({
			action: "send",
			draft: crypto.randomUUID(),
			to,
			cc,
			subject,
			text: "Hi.",
		}),
	});
	expect(response.status).toBe(200);
	const sent = (await response.json()) as { id: string; threadId: string; state: string };
	expect(sent.state).toBe("sent");
	const handed = emails.find((email) => email.subject === subject);
	if (!handed) throw new Error("expected the message at Resend");
	return { ...sent, emailId: handed.id, from: `Support <help@${box.domain}>` };
}

type Sent = Awaited<ReturnType<typeof send>>;

async function deliveries(box: Box, sent: Sent) {
	const response = await mail.fetch(
		`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${sent.threadId}`,
		{ headers: owner.headers },
	);
	expect(response.status).toBe(200);
	const page = (await response.json()) as {
		messages: {
			id: string;
			sent: { deliveries: { recipient: string; state: string; detail: string | null }[] };
		}[];
	};
	return page.messages
		.find((message) => message.id === sent.id)
		?.sent.deliveries.map(({ recipient, state, detail }) => ({ recipient, state, detail }))
		.sort((a, b) => a.recipient.localeCompare(b.recipient));
}

async function suppressions(box: Box) {
	const response = await mail.fetch(`${origin}/api/suppressions/${box.slug}`, {
		headers: owner.headers,
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		suppressions: {
			address: string;
			reason: string;
			provider: string;
			lastAt: number;
			expiresAt: number | null;
		}[];
	};
	return body.suppressions.sort((a, b) => a.address.localeCompare(b.address));
}

/** Resend's event about one recipient of a message it sent. */
function event(
	type: string,
	sent: { emailId: string; from: string },
	recipient: string,
	data: Record<string, unknown> = {},
	at = Date.now(),
) {
	return JSON.stringify({
		type,
		created_at: new Date(at).toISOString(),
		data: {
			created_at: new Date(at).toISOString(),
			email_id: sent.emailId,
			message_id: "<x@resend.example>",
			from: sent.from,
			to: [recipient],
			subject: "Hello",
			...data,
		},
	});
}

function signed(secret: string, body: string) {
	const id = `msg_${crypto.randomUUID()}`;
	const at = Math.floor(Date.now() / 1000);
	const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
	const signature = createHmac("sha256", key).update(`${id}.${at}.${body}`).digest("base64");
	return { "svix-id": id, "svix-timestamp": String(at), "svix-signature": `v1,${signature}` };
}

async function deliver(webhook: Webhook, body: string, headers = signed(webhook.secret, body)) {
	const response = await mail.fetch(webhook.endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
	return response.status;
}

const bounce = (reply: string, type = "Permanent", subType = "General") => ({
	bounce: {
		type,
		subType,
		message: "The recipient's email provider sent a bounce.",
		diagnosticCode: [`smtp; ${reply}`],
	},
});

beforeAll(async () => {
	mail = await startMail(origin, {
		hosts: { "cloudflare-dns.com": dns, "api.resend.com": resend },
		settings: { SECRETS_KEY: Buffer.alloc(32, 7).toString("base64") },
	});
	owner = await signUp(mail, origin, "Owner");
});

afterAll(async () => {
	await mail?.dispose();
});

describe("Resend's delivery events", () => {
	it("are asked for by the workspace's webhook, made when a domain sends with Resend", async () => {
		const box = await workspace();
		expect(await sendingWithResend(box)).toEqual({ ok: true });
		const webhook = hookOf(box);
		expect(webhook.endpoint).toMatch(/^https:\/\/mail\.test\/api\/inbound\/resend\/[a-f0-9]{32}$/);
		expect(webhook.events.sort()).toEqual(
			[
				"email.bounced",
				"email.complained",
				"email.delivered",
				"email.delivery_delayed",
				"email.failed",
				"email.received",
				"email.suppressed",
			].sort(),
		);
		expect((await directory(box.slug)).body.resendReceiving?.ready).toBe(true);
	});

	it("record what became of each recipient, and stop mail to those that bounced or complained", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		const webhook = hookOf(box);
		const sent = await send(box, ["ada@example.org", "bob@example.org"], ["cy@example.org"]);
		const early = Date.now() - 2_000;
		expect(await deliver(webhook, event("email.delivered", sent, "ada@example.org"))).toBe(204);
		expect(
			await deliver(
				webhook,
				event("email.bounced", sent, "bob@example.org", bounce("550 5.1.1 User unknown")),
			),
		).toBe(204);
		// Resend tells of a complaint, then that the message was delivered.
		expect(
			await deliver(webhook, event("email.complained", sent, "cy@example.org", {}, early)),
		).toBe(204);
		expect(await deliver(webhook, event("email.delivered", sent, "cy@example.org"))).toBe(204);
		expect(await deliveries(box, sent)).toEqual([
			{ recipient: "ada@example.org", state: "delivered", detail: null },
			{ recipient: "bob@example.org", state: "bounced", detail: "550 5.1.1 User unknown" },
			{ recipient: "cy@example.org", state: "complained", detail: null },
		]);
		const listed = await suppressions(box);
		expect(
			listed.map(({ address, reason, provider, expiresAt }) => [
				address,
				reason,
				provider,
				expiresAt,
			]),
		).toEqual([
			["bob@example.org", "bounced", "resend", null],
			["cy@example.org", "complained", "resend", null],
		]);
		const domain = (await directory(box.slug)).body.domains[0];
		expect(domain?.eventsAt).toBeGreaterThan(Date.now() - MINUTE);

		// And the next message to one of them is refused before it reaches Resend.
		const before = emails.length;
		const refused = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
			method: "POST",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify({
				action: "send",
				draft: crypto.randomUUID(),
				to: ["bob@example.org"],
				subject: "Again",
				text: "Hi.",
			}),
		});
		expect(refused.status).toBe(409);
		expect(emails.length).toBe(before);
	});

	it("list an address Resend kept back as on the provider's list, and a bounce that may pass for a week", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		const webhook = hookOf(box);
		const sent = await send(box, [
			"kept@example.org",
			"full@example.org",
			"soft@example.org",
			"listed@example.org",
		]);
		const at = Date.now() - 1_000;
		const said = {
			suppressed: {
				type: "Suppressed",
				reason: "previous_bounce",
				message: "The recipient's email address is on the suppression list.",
			},
		};
		expect(
			await deliver(webhook, event("email.suppressed", sent, "kept@example.org", said, at)),
		).toBe(204);
		expect(
			await deliver(
				webhook,
				event("email.bounced", sent, "full@example.org", bounce("552 5.2.2 Mailbox full"), at),
			),
		).toBe(204);
		expect(
			await deliver(
				webhook,
				event(
					"email.bounced",
					sent,
					"soft@example.org",
					bounce("421 4.7.0 Try later", "Transient"),
					at,
				),
			),
		).toBe(204);
		expect(
			await deliver(
				webhook,
				event(
					"email.bounced",
					sent,
					"listed@example.org",
					bounce("550 5.1.1 Suppressed", "Permanent", "Suppressed"),
					at,
				),
			),
		).toBe(204);
		expect(
			(await deliveries(box, sent))?.map(({ recipient, state }) => [recipient, state]),
		).toEqual([
			["full@example.org", "bounced"],
			["kept@example.org", "rejected"],
			["listed@example.org", "bounced"],
			["soft@example.org", "bounced"],
		]);
		const listed = await suppressions(box);
		expect(listed.map(({ address, reason, expiresAt }) => [address, reason, expiresAt])).toEqual([
			["full@example.org", "bounced", at + 7 * DAY],
			["kept@example.org", "rejected", at + 7 * DAY],
			["listed@example.org", "rejected", at + 7 * DAY],
		]);
	});

	it("change nothing for another workspace's mail, a type Mail didn't ask for, or an unsigned one", async () => {
		const box = await workspace();
		const other = await workspace();
		await sendingWithResend(box);
		await sendingWithResend(other);
		const theirs = await send(other, ["ada@example.org"]);
		// The same Resend account could send for both; this webhook is only the first's.
		expect(await deliver(hookOf(box), event("email.complained", theirs, "ada@example.org"))).toBe(
			204,
		);
		expect(await deliveries(other, theirs)).toEqual([]);
		expect(await suppressions(other)).toEqual([]);
		expect(await suppressions(box)).toEqual([]);

		const mine = await send(box, ["ada@example.org"]);
		// One Mail can't read would only come again the same.
		const odd = event("email.delivered", { ...mine, emailId: "not an id" }, "ada@example.org");
		expect(await deliver(hookOf(box), odd)).toBe(204);
		expect(await deliver(hookOf(box), event("email.sent", mine, "ada@example.org"))).toBe(204);
		expect(await deliver(hookOf(box), event("email.opened", mine, "ada@example.org"))).toBe(204);
		const forged = event("email.complained", mine, "ada@example.org");
		expect(await deliver(hookOf(box), forged, signed(hookOf(other).secret, forged))).toBe(401);
		expect(await deliveries(box, mine)).toEqual([]);
		expect(await suppressions(box)).toEqual([]);
	});

	it("come again for a message not found yet, until it is too late to be found", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		const webhook = hookOf(box);
		const unknown = { emailId: crypto.randomUUID(), from: `help@${box.domain}` };
		const complaint = (at: number) => event("email.complained", unknown, "ada@example.org", {}, at);
		expect(await deliver(webhook, complaint(Date.now()))).toBe(503);
		expect(await deliver(webhook, complaint(Date.now() - 11 * MINUTE))).toBe(204);
		// A complaint about a message the mailbox doesn't have stops nothing.
		expect(await suppressions(box)).toEqual([]);
	});
});

describe("sending through Resend with a key that can only send", () => {
	it("sends, saying Mail won't learn what becomes of the mail", async () => {
		const box = await workspace(SENDING_KEY);
		const before = webhooks.size;
		const answer = await sendingWithResend(box);
		expect(answer.ok).toBe(true);
		expect(answer.note).toContain("can't learn what became of mail sent through Resend");
		expect(webhooks.size).toBe(before);
		const listed = (await directory(box.slug)).body;
		expect(listed.domains[0]?.sendsWith).toBe("resend");
		expect(listed.resendReceiving).toBeNull();
		await send(box, ["ada@example.org"]);
	});
});

describe("the workspace's webhook", () => {
	it("gains the events when an older one is checked", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		const webhook = hookOf(box);
		// As one made before Mail recorded deliveries.
		webhook.events = ["email.received"];
		expect((await directory(box.slug, { action: "check-receiving" })).status).toBe(200);
		expect(webhook.events).toContain("email.bounced");
		expect(webhook.events).toContain("email.received");
	});

	it("stays two weeks once no domain uses Resend, for what it still tells of mail sent before", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		const webhook = hookOf(box);
		const sent = await send(box, ["ada@example.org", "bob@example.org"]);
		expect(await deliver(webhook, event("email.delivered", sent, "ada@example.org"))).toBe(204);
		const first = (await directory(box.slug)).body.domains[0]?.eventsAt;
		expect(first).toBeGreaterThan(Date.now() - MINUTE);
		// Choosing the same way again keeps the time.
		await sendingWithResend(box);
		expect((await directory(box.slug)).body.domains[0]?.eventsAt).toBe(first);

		const back = await directory(box.slug, {
			action: "set-domain-sending",
			id: box.domainId,
			sendsWith: "cloudflare",
		});
		expect(back.status).toBe(200);
		expect(webhooks.has(webhook.id)).toBe(true);
		expect(await unusedSince(box)).toBeGreaterThan(Date.now() - MINUTE);
		// Resend's events were the domain's, so they are forgotten once it sends another way.
		expect((await directory(box.slug)).body.domains[0]?.eventsAt).toBeNull();

		// A complaint that comes later still stops mail to whoever made it, and says nothing of
		// Email Service's events.
		expect(await deliver(webhook, event("email.complained", sent, "bob@example.org"))).toBe(204);
		expect((await suppressions(box)).map(({ address, reason }) => [address, reason])).toEqual([
			["bob@example.org", "complained"],
		]);
		expect((await directory(box.slug)).body.domains[0]?.eventsAt).toBeNull();

		await mail.runScheduled();
		expect(webhooks.has(webhook.id)).toBe(true);
		await unusedFor(box, 15 * DAY);
		await mail.runScheduled();
		expect(webhooks.has(webhook.id)).toBe(false);
		expect((await directory(box.slug)).body.resendReceiving).toBeNull();
		expect(await deliver(webhook, event("email.complained", sent, "ada@example.org"))).toBe(404);
	});

	it("is kept while a domain uses Resend, whatever the row says", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		const webhook = hookOf(box);
		await directory(box.slug, {
			action: "set-domain-sending",
			id: box.domainId,
			sendsWith: "cloudflare",
		});
		await unusedFor(box, 13 * DAY);
		// Back to Resend within the two weeks: the same webhook, used again.
		await sendingWithResend(box);
		expect(hookOf(box).id).toBe(webhook.id);
		expect(await unusedSince(box)).toBeNull();
		await unusedFor(box, 30 * DAY);
		await mail.runScheduled();
		expect(webhooks.has(webhook.id)).toBe(true);
	});

	it("counts sending as use when receiving goes back to Cloudflare", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		const receiving = (receivesWith: string) =>
			directory(box.slug, { action: "set-domain-receiving", id: box.domainId, receivesWith });
		expect((await receiving("resend")).status).toBe(200);
		expect((await receiving("cloudflare")).status).toBe(200);
		expect(await unusedSince(box)).toBeNull();
	});

	it("costs no call to Resend for mail it received while no domain here receives with it", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		asked.length = 0;
		const received = JSON.stringify({
			type: "email.received",
			created_at: new Date().toISOString(),
			data: { email_id: crypto.randomUUID(), to: [`help@${box.domain}`] },
		});
		expect(await deliver(hookOf(box), received)).toBe(200);
		expect(asked).toEqual([]);
		expect((await directory(box.slug)).body.resendReceiving?.trouble).toBeNull();
	});
});

describe("a new Resend key", () => {
	it("gets the webhook made in its account when the old one isn't there", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		const old = hookOf(box);
		// As a key from another Resend account finds it.
		webhooks.delete(old.id);
		const before = new Set(webhooks.keys());
		expect((await setKey(box.workspaceId, FULL_KEY)).note).toBeNull();
		const made = [...webhooks.values()].filter((one) => !before.has(one.id));
		expect(made.map(({ endpoint }) => endpoint)).toEqual([old.endpoint]);
		const [webhook] = made;
		if (!webhook) throw new Error("expected a webhook");

		const sent = await send(box, ["ada@example.org"]);
		expect(await deliver(webhook, event("email.delivered", sent, "ada@example.org"))).toBe(204);
		expect(await deliveries(box, sent)).toEqual([
			{ recipient: "ada@example.org", state: "delivered", detail: null },
		]);
		// The old webhook's secret went with it.
		expect(await deliver(old, event("email.complained", sent, "ada@example.org"))).toBe(401);
	});

	it("that can only send leaves a webhook that is made alone, saying it can't check it", async () => {
		const box = await workspace();
		await sendingWithResend(box);
		const webhook = hookOf(box);
		const set = await setKey(box.workspaceId, SENDING_KEY);
		expect(set.access).toBe("sending");
		expect(set.note).toContain("can't check Resend's webhook");
		expect(webhooks.get(webhook.id)?.status).toBe("enabled");
		const check = await directory(box.slug, { action: "check-receiving" });
		expect(check.body.error).toContain("can't check Resend's webhook");
		const switched = await sendingWithResend(box);
		expect(switched.note).toContain("can't check Resend's webhook");

		// And its events still count.
		const sent = await send(box, ["ada@example.org"]);
		expect(await deliver(webhook, event("email.delivered", sent, "ada@example.org"))).toBe(204);
		expect((await deliveries(box, sent))?.[0]?.state).toBe("delivered");
	});
});
