import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startMail } from "./mail-worker";

// Receiving through Resend: the built Worker in workerd, a stand-in for Resend's API at
// api.resend.com, and one for the signed addresses its raw mail is downloaded from.

const origin = "https://mail.test";
const MAILBOX_BYTES = 200_000;

const FULL_KEY = "re_FullAccess_1234567890abcd";
const OTHER_ACCOUNT_KEY = "re_OtherAccount_1234567890ef";
const SENDING_KEY = "re_SendingOnly_0987654321wxyz";

interface Webhook {
	id: string;
	account: string;
	endpoint: string;
	events: string[];
	secret: string;
	status: "enabled" | "disabled";
}

/** What one received email holds, as Resend's API gives it. */
interface Received {
	id: string;
	account: string;
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	received_for?: string[];
	dmarc: string | null;
	raw: string;
	/** Resend gave no download for it, as its answer may. */
	withoutRaw?: boolean;
	/** The download comes without a length, as a compressed or streamed one would. */
	unsized?: boolean;
	/** Resend's answer about it is one Mail can't read. */
	garbled?: boolean;
	/** Something in the way answers for Resend, with a page that isn't JSON, this many times. */
	notJson?: number;
}

/** The Resend account each key belongs to. */
const accounts: Record<string, string> = {
	[FULL_KEY]: "gateweave",
	[SENDING_KEY]: "gateweave",
	[OTHER_ACCOUNT_KEY]: "other",
};

const webhooks = new Map<string, Webhook>();
const received = new Map<string, Received>();
/** Raw downloads that fail before one works, by email id: with Resend's error, or no answer. */
const failingDownloads = new Map<string, number>();
const brokenDownloads = new Map<string, number>();
const fetched: string[] = [];
/** How each received email was asked for, by its id. */
const askedAs = new Map<string, string>();

const restricted = () =>
	Response.json(
		{ name: "restricted_api_key", message: "This API key is restricted to only send emails" },
		{ status: 401 },
	);
const notFound = (what: string) =>
	Response.json({ name: "not_found", message: `${what} not found` }, { status: 404 });

async function resend(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	const account = accounts[key];
	if (!account) {
		return Response.json(
			{ name: "validation_error", message: "API key is invalid" },
			{ status: 400 },
		);
	}
	if (key === SENDING_KEY) return restricted();
	if (url.pathname === "/domains") return Response.json({ data: [] });
	if (url.pathname === "/webhooks" && request.method === "POST") {
		const body = (await request.json()) as { endpoint: string; events: string[] };
		const id = crypto.randomUUID();
		const secret = `whsec_${randomBytes(24).toString("base64")}`;
		webhooks.set(id, {
			id,
			account,
			endpoint: body.endpoint,
			events: body.events,
			secret,
			status: "enabled",
		});
		return Response.json({ object: "webhook", id, signing_secret: secret }, { status: 201 });
	}
	const webhook = /^\/webhooks\/([^/]+)$/.exec(url.pathname)?.[1];
	if (webhook) {
		const found = webhooks.get(webhook);
		if (!found || found.account !== account) return notFound("Webhook");
		if (request.method === "DELETE") webhooks.delete(webhook);
		if (request.method === "PATCH") {
			const body = (await request.json()) as {
				status?: "enabled" | "disabled";
				endpoint?: string;
			};
			if (body.status) found.status = body.status;
			if (body.endpoint) found.endpoint = body.endpoint;
		}
		return Response.json({
			object: "webhook",
			id: webhook,
			status: found.status,
			endpoint: found.endpoint,
		});
	}
	const email = /^\/emails\/receiving\/([^/]+)$/.exec(url.pathname)?.[1];
	if (email) {
		fetched.push(email);
		askedAs.set(email, url.search);
		const found = received.get(email);
		if (!found || found.account !== account) return notFound("Email");
		if (found.garbled) return Response.json({ object: "email", to: "not a list" });
		if (found.notJson) {
			found.notJson--;
			return new Response("<html>Gateway</html>", { headers: { "content-type": "text/html" } });
		}
		return Response.json({
			object: "email",
			id: found.id,
			from: found.from,
			to: found.to,
			cc: found.cc ?? [],
			bcc: found.bcc ?? [],
			received_for: found.received_for ?? [],
			authentication:
				found.dmarc === null ? null : { spf: "pass", dkim: "pass", dmarc: found.dmarc },
			raw: found.withoutRaw
				? null
				: {
						download_url: `https://raw.resend.test/${found.id}.eml?signature=x`,
						expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					},
		});
	}
	return notFound("Route");
}

function download(request: Request): Response {
	const id = new URL(request.url).pathname.slice(1).replace(/\.eml$/, "");
	const broken = brokenDownloads.get(id) ?? 0;
	if (broken > 0) {
		brokenDownloads.set(id, broken - 1);
		return Response.error();
	}
	const left = failingDownloads.get(id) ?? 0;
	if (left > 0) {
		failingDownloads.set(id, left - 1);
		return new Response("Service Unavailable", { status: 503 });
	}
	const email = received.get(id);
	if (!email) return new Response("Not Found", { status: 404 });
	const bytes = new TextEncoder().encode(email.raw);
	if (email.unsized) {
		// In pieces, with no length up front.
		let at = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (at >= bytes.byteLength) {
					controller.close();
					return;
				}
				controller.enqueue(bytes.slice(at, at + 1000));
				at += 1000;
			},
		});
		return new Response(body, { headers: { "content-type": "message/rfc822" } });
	}
	return new Response(bytes, {
		headers: { "content-type": "message/rfc822", "content-length": String(bytes.byteLength) },
	});
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

interface Listed {
	ok?: boolean;
	error?: string;
	domains: { id: string; name: string; receivesWith: string; proof: { value: string } | null }[];
	mailboxes: { id: string; name: string }[];
	resendReceiving: {
		ready: boolean;
		receivedAt: number | null;
		trouble: string | null;
		troubleAt: number | null;
	} | null;
}

async function directory(slug: string, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers: { ...owner.headers, origin },
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	return { status: response.status, body: (await response.json()) as Listed };
}

let keysSet = 0;

/** Puts in the workspace's key, from an address of its own: the endpoint allows few tries each. */
async function setKey(workspaceId: string, key: string) {
	const set = await mail.fetch(`${origin}/api/auth/providers/set-key`, {
		method: "POST",
		headers: {
			...owner.headers,
			origin,
			"content-type": "application/json",
			"cf-connecting-ip": `203.0.113.${++keysSet}`,
		},
		body: JSON.stringify({ organizationId: workspaceId, provider: "resend", key }),
	});
	expect(set.status).toBe(200);
}

/** A workspace of its own, with a proved domain and a mailbox with help@ on it. */
async function workspace(key: string | null = FULL_KEY) {
	const n = ++counter;
	const slug = `inbound-${n}`;
	const workspaceId = await createWorkspace(
		mail,
		origin,
		{ ...owner.headers, "cf-connecting-ip": `198.51.100.${n}` },
		slug,
	);
	const box = { slug, workspaceId, domains: [] as { id: string; name: string }[], mailboxId: "" };
	await addDomain(box, `in${n}.example.com`);
	const name = `Support ${n}`;
	await directory(slug, { action: "add-mailbox", name });
	const made = (await directory(slug)).body.mailboxes.find((one) => one.name === name);
	if (!made) throw new Error("expected a mailbox");
	box.mailboxId = made.id;
	await addAddress(box, 0, "help");
	if (key) await setKey(workspaceId, key);
	return box;
}

type Box = Awaited<ReturnType<typeof workspace>>;

/** Another mailbox in the box's workspace, with this address on its first domain. */
async function secondMailbox(box: Box, localPart: string) {
	const name = `Other ${++counter}`;
	await directory(box.slug, { action: "add-mailbox", name });
	const made = (await directory(box.slug)).body.mailboxes.find((one) => one.name === name);
	if (!made) throw new Error("expected a mailbox");
	await addAddress({ ...box, mailboxId: made.id }, 0, localPart);
	return made.id;
}

async function addDomain(
	box: { slug: string; domains: { id: string; name: string }[] },
	name: string,
) {
	await directory(box.slug, { action: "add-domain", name });
	const added = (await directory(box.slug)).body.domains.find((one) => one.name === name);
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${name}`, added.proof.value);
	await directory(box.slug, { action: "check-domain", id: added.id });
	box.domains.push({ id: added.id, name });
}

async function addAddress(
	box: Box | { slug: string; domains: { id: string }[]; mailboxId: string },
	domain: number,
	localPart: string,
) {
	const answer = await directory(box.slug, {
		action: "add-address",
		domainId: box.domains[domain]?.id,
		mailboxId: box.mailboxId,
		localPart,
		expiresInDays: null,
	});
	expect(answer.status).toBe(200);
}

const receiveWith = (box: Box, receivesWith: string, domain = 0) =>
	directory(box.slug, {
		action: "set-domain-receiving",
		id: box.domains[domain]?.id,
		receivesWith,
	});

/** The workspace's webhook in the stand-in, by the channel in its address. */
function webhookOf(box: Box): Webhook {
	const mine = [...webhooks.values()].filter((one) => one.account === "gateweave");
	const found = mine.find((one) => one.endpoint === endpoints.get(box.slug));
	if (!found) throw new Error("expected a webhook");
	return found;
}

/** Each workspace's webhook address, noted when its webhook is made. */
const endpoints = new Map<string, string>();

async function receiving(box: Box) {
	const before = new Set(webhooks.keys());
	const answer = await receiveWith(box, "resend");
	expect(answer.status).toBe(200);
	const made = [...webhooks.values()].find((one) => !before.has(one.id));
	if (made) endpoints.set(box.slug, made.endpoint);
	return webhookOf(box);
}

function signed(
	secret: string,
	body: string,
	at = Math.floor(Date.now() / 1000),
	id = `msg_${crypto.randomUUID()}`,
) {
	const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
	const signature = createHmac("sha256", key).update(`${id}.${at}.${body}`).digest("base64");
	return { "svix-id": id, "svix-timestamp": String(at), "svix-signature": `v1,${signature}` };
}

/** Resend's event for a received email, as its webhook sends it. */
const eventFor = (email: Received, type = "email.received") =>
	JSON.stringify({
		type,
		created_at: new Date().toISOString(),
		data: {
			email_id: email.id,
			created_at: new Date().toISOString(),
			from: email.from,
			to: email.to,
			cc: email.cc ?? [],
			bcc: email.bcc ?? [],
			received_for: email.received_for ?? [],
			message_id: "<x@sender.example>",
			subject: "Hello",
			attachments: [],
		},
	});

function deliver(webhook: Webhook, body: string, headers = signed(webhook.secret, body)) {
	return mail.fetch(webhook.endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
}

function rawMail({
	from = "Ada <ada@sender.example>",
	to = "help@example.com",
	subject = "Hello",
	body = "Hi there.",
	before = [] as string[],
} = {}) {
	return [
		...before,
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: <${crypto.randomUUID()}@sender.example>`,
		"Date: Sun, 08 Nov 2026 12:00:00 +0000",
		"Content-Type: text/plain; charset=utf-8",
		"",
		body,
		"",
	].join("\r\n");
}

/** An email Resend received for the box's help@, with these raw contents. */
function receivedFor(
	box: Box,
	raw: Partial<Parameters<typeof rawMail>[0]> = {},
	more: Partial<Received> = {},
): Received {
	const to = `help@${box.domains[0]?.name}`;
	const email: Received = {
		id: crypto.randomUUID(),
		account: "gateweave",
		from: "ada@sender.example",
		to: [to],
		dmarc: "pass",
		raw: rawMail({ to, ...raw }),
		...more,
	};
	received.set(email.id, email);
	return email;
}

async function messages(box: Box, mailboxId = box.mailboxId) {
	const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${mailboxId}`, {
		headers: owner.headers,
	});
	expect(response.status).toBe(200);
	return (
		(await response.json()) as {
			messages: { id: string; subject: string; verifiedDomain: string | null }[];
		}
	).messages;
}

async function opened(box: Box, id: string) {
	const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}`, {
		headers: owner.headers,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { dmarc: string | null; verifiedDomain: string | null };
}

beforeAll(async () => {
	mail = await startMail(origin, {
		hosts: { "cloudflare-dns.com": dns, "api.resend.com": resend, "raw.resend.test": download },
		settings: {
			SECRETS_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAILBOX_BYTES: String(MAILBOX_BYTES),
		},
	});
	owner = await signUp(mail, origin, "Owner");
});

afterAll(async () => {
	await mail?.dispose();
});

describe("receiving through Resend", () => {
	it("needs a key with full access, and leaves the domain as it was without one", async () => {
		const box = await workspace(SENDING_KEY);
		const before = webhooks.size;
		const answer = await receiveWith(box, "resend");
		expect(answer.status).toBe(409);
		expect(answer.body.error).toMatch(/full access/);
		const listed = (await directory(box.slug)).body;
		expect(listed.domains[0]?.receivesWith).toBe("cloudflare");
		expect(listed.resendReceiving).toBeNull();
		expect(webhooks.size).toBe(before);

		const keyless = await workspace(null);
		const without = await receiveWith(keyless, "resend");
		expect(without.status).toBe(409);
		expect(without.body.error).toMatch(/Resend key first/);
	});

	it("makes one webhook for the workspace and removes it when no domain receives with Resend", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		expect(webhook.events).toEqual(["email.received"]);
		expect(webhook.endpoint).toMatch(/^https:\/\/mail\.test\/api\/inbound\/resend\/[a-f0-9]{32}$/);
		let listed = (await directory(box.slug)).body;
		expect(listed.domains[0]?.receivesWith).toBe("resend");
		expect(listed.resendReceiving).toMatchObject({ ready: true, receivedAt: null, trouble: null });

		await addDomain(box, `second${counter}.example.com`);
		expect((await receiveWith(box, "resend", 1)).status).toBe(200);
		expect([...webhooks.values()].filter((one) => one.endpoint === webhook.endpoint)).toHaveLength(
			1,
		);

		expect((await receiveWith(box, "cloudflare", 0)).status).toBe(200);
		expect(webhooks.has(webhook.id)).toBe(true);
		expect((await receiveWith(box, "cloudflare", 1)).status).toBe(200);
		expect(webhooks.has(webhook.id)).toBe(false);
		listed = (await directory(box.slug)).body;
		expect(listed.resendReceiving).toBeNull();
		// Its address leads nowhere now.
		const email = receivedFor(box);
		expect((await deliver(webhook, eventFor(email))).status).toBe(404);

		// Removing the last domain that receives with Resend removes it too.
		const again = await receiving(box);
		expect(again.endpoint).not.toBe(webhook.endpoint);
		for (const domain of box.domains) {
			expect((await directory(box.slug, { action: "remove-domain", id: domain.id })).status).toBe(
				200,
			);
		}
		expect(webhooks.has(again.id)).toBe(false);
		expect((await directory(box.slug)).body.resendReceiving).toBeNull();
	});

	it("stores a signed delivery, judged only by what Resend's API says of its sender", async () => {
		const box = await workspace();
		const webhook = await receiving(box);

		const proved = receivedFor(box, { subject: "Proved" });
		expect((await deliver(webhook, eventFor(proved))).status).toBe(200);
		// The raw mail starts as Cloudflare's would, with a pass of its own, which counts for nothing.
		const forged = receivedFor(
			box,
			{
				subject: "Forged",
				from: "Bank <alerts@bank.example>",
				before: [
					"Received: from x by cloudflare-email.net (unknown) id abc; Sun, 08 Nov 2026 12:00:00 +0000",
					"Authentication-Results: mx.cloudflare.net; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example; spf=pass",
				],
			},
			{ dmarc: "fail" },
		);
		expect((await deliver(webhook, eventFor(forged))).status).toBe(200);
		// Resend passed a From other than the one the mail shows.
		const swapped = receivedFor(box, { subject: "Swapped" }, { from: "ceo@bank.example" });
		expect((await deliver(webhook, eventFor(swapped))).status).toBe(200);

		const listed = await messages(box);
		const first = listed.find((one) => one.subject === "Proved");
		const second = listed.find((one) => one.subject === "Forged");
		expect(first?.verifiedDomain).toBe("sender.example");
		expect(second?.verifiedDomain).toBeNull();
		expect(await opened(box, second?.id ?? "")).toMatchObject({
			dmarc: "fail",
			verifiedDomain: null,
		});
		expect(await opened(box, first?.id ?? "")).toMatchObject({ dmarc: "pass" });
		expect(listed.find((one) => one.subject === "Swapped")?.verifiedDomain).toBeNull();
		// Inline images are asked for as attachments, which keeps Resend's answer small.
		expect(new URLSearchParams(askedAs.get(proved.id)).get("html_format")).toBe("cid");
		expect((await directory(box.slug)).body.resendReceiving?.receivedAt).toEqual(
			expect.any(Number),
		);
	});

	it("refuses what isn't signed with the workspace's secret, or came too long ago", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		const other = await workspace();
		const theirs = await receiving(other);
		const email = receivedFor(box, { subject: "Unsigned" });
		const body = eventFor(email);
		const asked = fetched.length;

		expect((await deliver(webhook, body, signed(theirs.secret, body))).status).toBe(401);
		const stale = Math.floor(Date.now() / 1000) - 10 * 60;
		expect((await deliver(webhook, body, signed(webhook.secret, body, stale))).status).toBe(401);
		const changed = body.replace(email.id, crypto.randomUUID());
		expect((await deliver(webhook, changed, signed(webhook.secret, body))).status).toBe(401);
		expect((await deliver(webhook, body, {} as ReturnType<typeof signed>)).status).toBe(401);
		const huge = JSON.stringify({ type: "email.received", pad: "x".repeat(300 * 1024) });
		expect((await deliver(webhook, huge)).status).toBe(413);
		const unknown = webhook.endpoint.replace(/[a-f0-9]{32}$/, "0".repeat(32));
		expect(
			(await mail.fetch(unknown, { method: "POST", body, headers: signed(webhook.secret, body) }))
				.status,
		).toBe(404);

		expect(fetched.length).toBe(asked);
		expect(await messages(box)).toHaveLength(0);
	});

	it("stores a retry, or the same mail sent twice, once", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		const email = receivedFor(box, { subject: "Once" });
		expect((await deliver(webhook, eventFor(email))).status).toBe(200);
		expect((await deliver(webhook, eventFor(email))).status).toBe(200);
		// The same message again, in a second email Resend made of it.
		const again = { ...email, id: crypto.randomUUID() };
		received.set(again.id, again);
		expect((await deliver(webhook, eventFor(again))).status).toBe(200);
		expect((await messages(box)).filter((one) => one.subject === "Once")).toHaveLength(1);
	});

	it("stores it only for this workspace's addresses on domains that receive with Resend", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		await addDomain(box, `routed${counter}.example.com`);
		await addAddress(box, 1, "help");
		const other = await workspace();
		await receiving(other);
		const theirs = `help@${other.domains[0]?.name}`;
		const routed = `help@${box.domains[1]?.name}`;

		const email = receivedFor(
			box,
			{ subject: "Elsewhere" },
			{ to: [theirs, routed, "nobody@nowhere.example"], cc: [], bcc: [] },
		);
		expect((await deliver(webhook, eventFor(email))).status).toBe(200);
		expect(await messages(box)).toHaveLength(0);
		expect(await messages(other)).toHaveLength(0);

		// Two of its addresses on one mailbox get one copy, and another mailbox its own.
		await addAddress(box, 0, "sales");
		const second = await secondMailbox(box, "billing");
		const ours = box.domains[0]?.name;
		const both = receivedFor(
			box,
			{ subject: "Both" },
			{ to: [`help@${ours}`, `Sales <SALES@${ours}>`, `billing@${ours}`] },
		);
		expect((await deliver(webhook, eventFor(both))).status).toBe(200);
		expect((await messages(box)).filter((one) => one.subject === "Both")).toHaveLength(1);
		expect((await messages(box, second)).filter((one) => one.subject === "Both")).toHaveLength(1);
	});

	// Resend keeps one email for each envelope recipient and names it in `to`. Its `cc` is the Cc
	// header, and `received_for` comes from Received headers, which the sender writes.
	it("stores it only for the envelope's recipient, never for addresses only in its headers", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		const ours = `help@${box.domains[0]?.name}`;
		const hidden = receivedFor(
			box,
			{ subject: "Headers only", to: ours },
			{ to: ["someone@else.example"], cc: [ours], bcc: [ours], received_for: [ours] },
		);
		expect((await deliver(webhook, eventFor(hidden))).status).toBe(200);
		expect(await messages(box)).toHaveLength(0);
	});

	it("finds the workspace's address among many others, and past odd entries", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		const others = Array.from({ length: 1_500 }, (_, n) => `person${n}@else.example`);
		const crowded = receivedFor(
			box,
			{ subject: "Crowded" },
			{ to: [...others, "x".repeat(5_000), `help@${box.domains[0]?.name}`] },
		);
		expect((await deliver(webhook, eventFor(crowded))).status).toBe(200);
		expect((await messages(box)).map((one) => one.subject)).toEqual(["Crowded"]);
	});

	it("asks Resend to try again when the mail can't be had yet, and says why", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		const email = receivedFor(box, { subject: "Later" });
		failingDownloads.set(email.id, 1);
		expect((await deliver(webhook, eventFor(email))).status).toBe(503);
		let state = (await directory(box.slug)).body.resendReceiving;
		expect(state).toMatchObject({ trouble: "raw_unavailable", troubleAt: expect.any(Number) });
		expect(await messages(box)).toHaveLength(0);

		expect((await deliver(webhook, eventFor(email))).status).toBe(200);
		state = (await directory(box.slug)).body.resendReceiving;
		expect(state).toMatchObject({ trouble: null, receivedAt: expect.any(Number) });
		expect(await messages(box)).toHaveLength(1);

		// A download that gets no answer at all is the same.
		const cut = receivedFor(box, { subject: "Cut off" });
		brokenDownloads.set(cut.id, 1);
		expect((await deliver(webhook, eventFor(cut))).status).toBe(503);
		expect((await directory(box.slug)).body.resendReceiving?.trouble).toBe("raw_unavailable");
		expect((await deliver(webhook, eventFor(cut))).status).toBe(200);
		expect(await messages(box)).toHaveLength(2);

		// And so is an answer with nothing to download yet.
		const bare = receivedFor(box, { subject: "Bare" }, { withoutRaw: true });
		expect((await deliver(webhook, eventFor(bare))).status).toBe(503);
		bare.withoutRaw = false;
		expect((await deliver(webhook, eventFor(bare))).status).toBe(200);
		expect(await messages(box)).toHaveLength(3);
	});

	it("stores mail downloaded without a length", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		const email = receivedFor(
			box,
			{ subject: "Unsized", body: "y".repeat(20_000) },
			{ unsized: true },
		);
		expect((await deliver(webhook, eventFor(email))).status).toBe(200);
		const [stored] = await messages(box);
		expect(stored?.subject).toBe("Unsized");
		const raw = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/${stored?.id ?? ""}/original`,
			{ headers: owner.headers },
		);
		expect(raw.status).toBe(200);
		expect(await raw.text()).toBe(email.raw);
	});

	it("keeps Resend trying while the key can only send, or the mailbox is full", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		await setKey(box.workspaceId, SENDING_KEY);
		const email = receivedFor(box, { subject: "Restricted" });
		expect((await deliver(webhook, eventFor(email))).status).toBe(503);
		expect((await directory(box.slug)).body.resendReceiving?.trouble).toBe(
			"resend:restricted_api_key",
		);

		const full = await workspace();
		const fullHook = await receiving(full);
		const big = "x".repeat(MAILBOX_BYTES * 0.6);
		expect(
			(await deliver(fullHook, eventFor(receivedFor(full, { subject: "Big 1", body: big }))))
				.status,
		).toBe(200);
		expect(
			(await deliver(fullHook, eventFor(receivedFor(full, { subject: "Big 2", body: big }))))
				.status,
		).toBe(503);
		expect((await directory(full.slug)).body.resendReceiving?.trouble).toBe("mailbox_full");
	});

	it("acknowledges other events, and keeps trying for mail the key's account doesn't have", async () => {
		const box = await workspace();
		const webhook = await receiving(box);
		const email = receivedFor(box, { subject: "Sent" });
		expect((await deliver(webhook, eventFor(email, "email.sent"))).status).toBe(204);
		// As when the key is from another account, which an admin can mend, or Resend is behind.
		const elsewhere = receivedFor(box, { subject: "Elsewhere" }, { account: "other" });
		expect((await deliver(webhook, eventFor(elsewhere))).status).toBe(503);
		expect((await directory(box.slug)).body.resendReceiving?.trouble).toBe("resend:not_found");
		expect(await messages(box)).toHaveLength(0);

		// Mail for nobody here says nothing about receiving, so the trouble stays.
		const nobody = receivedFor(box, { subject: "Nobody" }, { to: ["someone@else.example"] });
		expect((await deliver(webhook, eventFor(nobody))).status).toBe(200);
		expect((await directory(box.slug)).body.resendReceiving?.trouble).toBe("resend:not_found");

		// An answer of the wrong shape won't read better later.
		const garbled = receivedFor(box, { subject: "Garbled" }, { garbled: true });
		expect((await deliver(webhook, eventFor(garbled))).status).toBe(200);
		expect((await directory(box.slug)).body.resendReceiving?.trouble).toBe("resend:unreadable");
		expect(await messages(box)).toHaveLength(0);

		// A page that isn't JSON came from something in the way, which passes.
		const blocked = receivedFor(box, { subject: "Blocked" }, { notJson: 1 });
		expect((await deliver(webhook, eventFor(blocked))).status).toBe(503);
		expect((await deliver(webhook, eventFor(blocked))).status).toBe(200);
		expect((await messages(box)).map((one) => one.subject)).toEqual(["Blocked"]);
	});

	it("turns the webhook back on, or makes it again, when the Domains page checks it", async () => {
		const box = await workspace();
		expect((await directory(box.slug, { action: "check-receiving" })).status).toBe(409);
		const webhook = await receiving(box);
		webhook.status = "disabled";
		expect((await directory(box.slug, { action: "check-receiving" })).status).toBe(200);
		expect(webhook.status).toBe("enabled");
		// Choosing Resend again does the same.
		webhook.status = "disabled";
		expect((await receiveWith(box, "resend")).status).toBe(200);
		expect(webhook.status).toBe("enabled");

		// One pointing elsewhere, as after the server's address changed, is pointed back.
		const endpoint = webhook.endpoint;
		webhook.endpoint = "https://old.mail.test/api/inbound/resend/x";
		expect((await directory(box.slug, { action: "check-receiving" })).status).toBe(200);
		expect(webhook.endpoint).toBe(endpoint);

		webhooks.delete(webhook.id);
		expect((await directory(box.slug, { action: "check-receiving" })).status).toBe(200);
		const again = [...webhooks.values()].find((one) => one.endpoint === webhook.endpoint);
		expect(again?.status).toBe("enabled");
		const email = receivedFor(box, { subject: "Mended" });
		expect((await deliver(again as Webhook, eventFor(email))).status).toBe(200);
		expect(await messages(box)).toHaveLength(1);
	});

	it("makes the webhook again when Resend no longer has it, as after a key from another account", async () => {
		const box = await workspace();
		const first = await receiving(box);
		await setKey(box.workspaceId, OTHER_ACCOUNT_KEY);
		expect((await receiveWith(box, "resend")).status).toBe(200);
		const second = [...webhooks.values()].find(
			(one) => one.account === "other" && one.endpoint === first.endpoint,
		);
		expect(second).toBeDefined();
		const email = receivedFor(box, { subject: "Moved" }, { account: "other" });
		expect((await deliver(first, eventFor(email))).status).toBe(401);
		expect((await deliver(second as Webhook, eventFor(email))).status).toBe(200);
		expect(await messages(box)).toHaveLength(1);
	});
});
