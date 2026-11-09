import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startMail } from "./mail-worker";

// Sending through Resend with a workspace's own key, through the built Worker in workerd, with a
// stand-in for Resend's API at api.resend.com.

const origin = "https://mail.test";

/** Keys the stand-in takes: one that may do anything, and one that may only send. */
const FULL_KEY = "re_FullAccess_1234567890abcd";
const SENDING_KEY = "re_SendingOnly_0987654321wxyz";
/** A sending-only key the stand-in takes until a test revokes it, as someone may in Resend. */
const REVOCABLE_KEY = "re_Revocable_5555555555rvkd";
const revocable = { active: true };

/** One request the stand-in got for `POST /emails`. */
interface ResendRequest {
	authorization: string | null;
	idempotencyKey: string | null;
	userAgent: string | null;
	body: {
		from: string;
		to: string[];
		cc?: string[];
		subject: string;
		text: string;
		html?: string;
		headers?: Record<string, string>;
		attachments?: {
			filename: string;
			content: string;
			content_type: string;
			content_id?: string;
		}[];
	};
}

const requests: ResendRequest[] = [];
/** What the stand-in sent, by idempotency key: each key sends once, as Resend's does. */
const sent = new Map<string, { body: string; id: string }>();
const tries = new Map<string, number>();

/**
 * Stands in for Resend. A recipient's address can ask for an answer, as the Email Service stand-in's
 * do: "unverified-N@" is refused N times as from a domain Resend hasn't verified, "busy-N@" is rate
 * limited N times, and "went-N@" is sent but answered with Resend's failure N times.
 */
async function resend(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	const sendingOnly = key === SENDING_KEY || (key === REVOCABLE_KEY && revocable.active);
	if (url.pathname === "/domains") {
		if (key === FULL_KEY) return Response.json({ data: [] });
		if (sendingOnly) {
			return Response.json(
				{ name: "restricted_api_key", message: "This API key is restricted to only send emails" },
				{ status: 401 },
			);
		}
		return Response.json(
			{ name: "validation_error", message: "API key is invalid" },
			{ status: 400 },
		);
	}
	if (url.pathname !== "/emails" || request.method !== "POST") {
		return Response.json({ name: "not_found" }, { status: 404 });
	}
	const raw = await request.text();
	const body = JSON.parse(raw) as ResendRequest["body"];
	const idempotencyKey = request.headers.get("idempotency-key");
	requests.push({
		authorization: request.headers.get("authorization"),
		idempotencyKey,
		userAgent: request.headers.get("user-agent"),
		body,
	});
	// A key is checked before Resend looks for what was sent with the idempotency key.
	if (key !== FULL_KEY && !sendingOnly) {
		return Response.json(
			{ name: "validation_error", message: "API key is invalid" },
			{ status: 401 },
		);
	}
	const earlier = idempotencyKey ? sent.get(idempotencyKey) : undefined;
	if (earlier) {
		if (earlier.body !== raw) {
			return Response.json({ name: "invalid_idempotent_request" }, { status: 409 });
		}
		return Response.json({ id: earlier.id });
	}
	const [to = ""] = body.to;
	const asked = /^(unverified|busy|went)-(\d+)@/.exec(to);
	const count = (tries.get(to) ?? 0) + 1;
	tries.set(to, count);
	const id = crypto.randomUUID();
	if (asked && count <= Number(asked[2])) {
		if (asked[1] === "unverified") {
			return Response.json(
				{ name: "validation_error", message: "The domain is not verified." },
				{ status: 403 },
			);
		}
		if (asked[1] === "busy") {
			return Response.json({ name: "rate_limit_exceeded" }, { status: 429 });
		}
		// Sent, but the answer says Resend failed.
		if (idempotencyKey) sent.set(idempotencyKey, { body: raw, id });
		return Response.json({ name: "application_error" }, { status: 500 });
	}
	if (idempotencyKey) sent.set(idempotencyKey, { body: raw, id });
	return Response.json({ id });
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

type Asker = { headers: Record<string, string> };

interface Status {
	state: string;
	code: string | null;
	nextAt: number | null;
	detail: string | null;
}

type Sent = { ok: true; id: string; threadId: string } & Status;

async function directory(slug: string, headers: Record<string, string>, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers: { ...headers, origin },
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	return {
		status: response.status,
		body: (await response.json()) as {
			ok?: boolean;
			error?: string;
			proved?: boolean;
			domains: { id: string; sendsWith: string; proof: { value: string } | null }[];
			mailboxes: { id: string; name: string }[];
		},
	};
}

/** A workspace of its own, with a proved domain and a mailbox with one address. */
async function mailboxWithAddress() {
	const n = ++counter;
	const slug = `resend-${n}`;
	const domain = `resend${n}.example.com`;
	const workspaceId = await createWorkspace(
		mail,
		origin,
		{ ...owner.headers, "cf-connecting-ip": `198.51.100.${n}` },
		slug,
	);
	await directory(slug, owner.headers, { action: "add-domain", name: domain });
	const [added] = (await directory(slug, owner.headers)).body.domains;
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
	await directory(slug, owner.headers, { action: "check-domain", id: added.id });
	const name = `Support ${n}`;
	await directory(slug, owner.headers, { action: "add-mailbox", name });
	const made = (await directory(slug, owner.headers)).body.mailboxes.find(
		(box) => box.name === name,
	);
	if (!made) throw new Error("expected a mailbox");
	await directory(slug, owner.headers, {
		action: "add-address",
		domainId: added.id,
		mailboxId: made.id,
		localPart: "help",
		expiresInDays: null,
	});
	return { slug, workspaceId, domain, domainId: added.id, mailboxId: made.id, name };
}

type Box = Awaited<ReturnType<typeof mailboxWithAddress>>;

/** Asks the provider keys plugin, as the owner unless someone else asks. */
function auth(path: string, body: unknown, person: Asker = owner) {
	return mail.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: { ...person.headers, origin, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const setKey = (box: Box, key: string, person: Asker = owner) =>
	auth("/providers/set-key", { organizationId: box.workspaceId, provider: "resend", key }, person);

const sendWith = (box: Box, sendsWith: string) =>
	directory(box.slug, owner.headers, {
		action: "set-domain-sending",
		id: box.domainId,
		sendsWith,
	});

/** A mailbox whose domain sends through Resend with a key that can only send. */
async function resendBox() {
	const box = await mailboxWithAddress();
	expect((await setKey(box, SENDING_KEY)).status).toBe(200);
	expect((await sendWith(box, "resend")).status).toBe(200);
	return box;
}

function outbox(box: Box, body: Record<string, unknown>) {
	const asked = body.action === "send" ? { draft: crypto.randomUUID(), ...body } : body;
	return mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
		method: "POST",
		headers: { ...owner.headers, origin, "content-type": "application/json" },
		body: JSON.stringify(asked),
	});
}

async function send(box: Box, to: string): Promise<Sent> {
	const response = await outbox(box, { action: "send", to: [to], subject: "Hello", text: "Hi." });
	expect(response.status).toBe(200);
	return (await response.json()) as Sent;
}

/** How the message stands, as its thread shows it. */
async function statusOf(box: Box, message: Sent): Promise<Status | null> {
	const response = await mail.fetch(
		`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${message.threadId}`,
		{ headers: owner.headers },
	);
	const page = (await response.json()) as {
		messages: { id: string; sent: { status: Status | null } | null }[];
	};
	return page.messages.find((one) => one.id === message.id)?.sent?.status ?? null;
}

/** Waits, as the object's alarm takes its time, until the message is in this state. */
async function until(box: Box, message: Sent, state: string): Promise<Status | null> {
	let status = await statusOf(box, message);
	for (let waited = 0; status?.state !== state && waited < 45_000; waited += 1_000) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		status = await statusOf(box, message);
	}
	return status;
}

const requestsTo = (address: string) => requests.filter((one) => one.body.to.includes(address));

beforeAll(async () => {
	mail = await startMail(origin, {
		hosts: { "cloudflare-dns.com": dns, "api.resend.com": resend },
		settings: { SECRETS_KEY: Buffer.alloc(32, 9).toString("base64") },
	});
	owner = await signUp(mail, origin, "Owner");
});

afterAll(async () => {
	await mail?.dispose();
});

describe("a workspace's Resend key", () => {
	it("is checked with Resend, kept sealed, and only ever shown by its last four", async () => {
		const box = await mailboxWithAddress();
		const added = await setKey(box, SENDING_KEY);
		const text = await added.text();
		expect(added.status).toBe(200);
		expect(text).not.toContain(SENDING_KEY);
		expect(JSON.parse(text)).toMatchObject({
			access: "sending",
			key: { provider: "resend", hint: "wxyz", addedBy: "Owner" },
		});

		const read = await mail.fetch(
			`${origin}/api/auth/providers/key?organizationId=${box.workspaceId}&provider=resend`,
			{ headers: owner.headers },
		);
		const page = await read.text();
		expect(page).not.toContain(SENDING_KEY);
		expect(JSON.parse(page)).toMatchObject({ unavailable: null, key: { hint: "wxyz" } });

		const row = await mail.db
			.prepare("SELECT sealed, hint FROM provider_key WHERE organization_id = ?")
			.bind(box.workspaceId)
			.first<{ sealed: string; hint: string }>();
		expect(row?.hint).toBe("wxyz");
		expect(row?.sealed).toMatch(/^v1\./);
		expect(row?.sealed).not.toContain("SendingOnly");

		const checked = await auth("/providers/check-key", {
			organizationId: box.workspaceId,
			provider: "resend",
		});
		expect(await checked.json()).toEqual({ access: "sending" });

		// Replaced by one with full access.
		const replaced = await setKey(box, FULL_KEY);
		expect(await replaced.json()).toMatchObject({ access: "full", key: { hint: "abcd" } });
	});

	it("isn't kept when Resend doesn't take it, or it isn't a Resend key", async () => {
		const box = await mailboxWithAddress();
		const unknown = await setKey(box, "re_NotAKeyResendKnows_1234");
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as { message: string }).message).toMatch(/doesn't take/);
		expect((await setKey(box, "sk-something-else-entirely")).status).toBe(400);
		const kept = await mail.db
			.prepare("SELECT count(*) AS n FROM provider_key WHERE organization_id = ?")
			.bind(box.workspaceId)
			.first<{ n: number }>();
		expect(kept?.n).toBe(0);
	});

	it("is for owners and admins, and putting one in takes a recent sign-in", async () => {
		const box = await mailboxWithAddress();
		const member = await signUp(mail, origin, `Member${++counter}`);
		await mail.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
			)
			.bind(crypto.randomUUID(), box.workspaceId, member.userId, Date.now())
			.run();
		expect((await setKey(box, SENDING_KEY, member)).status).toBe(403);
		const read = await mail.fetch(
			`${origin}/api/auth/providers/key?organizationId=${box.workspaceId}&provider=resend`,
			{ headers: member.headers },
		);
		expect(read.status).toBe(403);
		expect(
			(
				await auth(
					"/providers/remove-key",
					{ organizationId: box.workspaceId, provider: "resend" },
					member,
				)
			).status,
		).toBe(403);

		const admin = await signUp(mail, origin, `Admin${++counter}`);
		await mail.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
			)
			.bind(crypto.randomUUID(), box.workspaceId, admin.userId, Date.now())
			.run();
		await mail.db
			.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
			.bind(Date.now() - 2 * 24 * 60 * 60 * 1000, admin.userId)
			.run();
		const stale = await setKey(box, SENDING_KEY, admin);
		expect(stale.status).toBe(403);
		expect(await stale.json()).toMatchObject({ code: "SESSION_NOT_FRESH" });
		// Taking it away needs no fresh sign-in: it stops mail rather than sending it anywhere.
		expect(
			(
				await auth(
					"/providers/remove-key",
					{ organizationId: box.workspaceId, provider: "resend" },
					admin,
				)
			).status,
		).toBe(200);
	});
});

describe("a domain that sends through Resend", () => {
	it("can only be set so once the workspace has a key, and the directory says how each sends", async () => {
		const box = await mailboxWithAddress();
		const early = await sendWith(box, "resend");
		expect(early.status).toBe(409);
		expect((await directory(box.slug, owner.headers)).body.domains[0]?.sendsWith).toBe(
			"cloudflare",
		);
		expect((await setKey(box, SENDING_KEY)).status).toBe(200);
		expect((await sendWith(box, "resend")).status).toBe(200);
		expect((await directory(box.slug, owner.headers)).body.domains[0]?.sendsWith).toBe("resend");
		expect((await sendWith(box, "elsewhere")).status).toBe(400);
	});

	it("sends with the key, its id as the idempotency key and a user agent, and never through Email Service", async () => {
		const box = await resendBox();
		const to = `ada.${box.slug}@example.org`;
		const message = await send(box, to);
		expect(message).toMatchObject({ state: "sent", code: null, detail: null });
		const [request, ...more] = requestsTo(to);
		expect(more).toEqual([]);
		expect(request).toMatchObject({
			authorization: `Bearer ${SENDING_KEY}`,
			idempotencyKey: message.id,
			userAgent: expect.stringMatching(/\S/),
			body: {
				from: `${box.name} <help@${box.domain}>`,
				to: [to],
				subject: "Hello",
				text: "Hi.",
				headers: { References: expect.stringMatching(/^<[^>]+@/) },
			},
		});
		expect((await mail.emails()).filter((email) => [email.to].flat().includes(to))).toEqual([]);
	});

	it("hands Resend the HTML and the files from the mailbox's copy", async () => {
		const box = await resendBox();
		const to = `files.${box.slug}@example.org`;
		const logo = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3));
		const pdf = btoa("%PDF-1.4 a report");
		const html = '<p>Attached.</p><img src="cid:logo">';
		const response = await outbox(box, {
			action: "send",
			to: [to],
			subject: "Files",
			text: "Attached.",
			html,
			attachments: [
				{ filename: "Rapor — Ekim.pdf", content: pdf },
				{ filename: "logo.png", content: logo, contentId: "logo" },
			],
		});
		expect(await response.json()).toMatchObject({ ok: true, state: "sent" });
		const [request] = requestsTo(to);
		expect(request?.body).toMatchObject({
			text: "Attached.",
			html,
			attachments: [
				{ filename: "logo.png", content: logo, content_type: "image/png", content_id: "logo" },
				{ filename: "Rapor — Ekim.pdf", content: pdf, content_type: "application/pdf" },
			],
		});
		expect(request?.body.attachments?.[1]).not.toHaveProperty("content_id");
	});

	it("hands Resend the same files on the try after one that may have gone", {
		timeout: 60_000,
	}, async () => {
		const box = await resendBox();
		const to = `went-1@files.${box.slug}.example.org`;
		const pdf = btoa("%PDF-1.4 a report");
		const response = await outbox(box, {
			action: "send",
			to: [to],
			subject: "Files",
			text: "Attached.",
			attachments: [{ filename: "report.pdf", content: pdf }],
		});
		const message = (await response.json()) as Sent;
		expect(message).toMatchObject({ state: "waiting", code: "resend:application_error" });
		expect((await until(box, message, "sent"))?.state).toBe("sent");
		const [first, second, ...more] = requestsTo(to);
		expect(more).toEqual([]);
		expect(first?.body.attachments).toEqual([
			{ filename: "report.pdf", content: pdf, content_type: "application/pdf" },
		]);
		// Resend refuses a changed request under the same key.
		expect(second?.body).toEqual(first?.body);
	});

	it("is uncertain when its copy can't give its files after a try that may have gone", {
		timeout: 60_000,
	}, async () => {
		const box = await resendBox();
		const to = `went-1@unread.${box.slug}.example.org`;
		const response = await outbox(box, {
			action: "send",
			to: [to],
			subject: "Files",
			text: "Attached.",
			attachments: [{ filename: "report.pdf", content: btoa("%PDF-1.4 a report") }],
		});
		const message = (await response.json()) as Sent;
		expect(message).toMatchObject({ state: "waiting", code: "resend:application_error" });
		const { objects } = await mail.bucket.list({ prefix: `${box.workspaceId}/${box.mailboxId}/` });
		const copy = objects.find((object) => object.key.endsWith(`/${message.id}.eml`));
		expect(copy).toBeDefined();
		await mail.bucket.put(copy?.key ?? "", "From: x@example.org\r\n\r\nNo files here.\r\n");
		const stopped = await until(box, message, "uncertain");
		expect(stopped).toMatchObject({ state: "uncertain", code: "mail:copy_unread" });
		expect(requestsTo(to)).toHaveLength(1);
	});

	it("is refused when it is written without a key, before anything counts", async () => {
		const box = await resendBox();
		expect(
			(await auth("/providers/remove-key", { organizationId: box.workspaceId, provider: "resend" }))
				.status,
		).toBe(200);
		const to = `nokey.${box.slug}@example.org`;
		const refused = await outbox(box, { action: "send", to: [to], subject: "Hi", text: "Hi." });
		expect(refused.status).toBe(409);
		expect(((await refused.json()) as { error: string }).error).toMatch(/no Resend key/);
		expect(requestsTo(to)).toEqual([]);
	});

	it("says what Resend said when it refuses, and a new try gets a new key", async () => {
		const box = await resendBox();
		const to = `unverified-1@${box.slug}.example.org`;
		const refused = await send(box, to);
		expect(refused).toMatchObject({
			state: "refused",
			code: "resend:validation_error",
			detail: "The domain is not verified.",
		});
		expect(await statusOf(box, refused)).toMatchObject({ detail: "The domain is not verified." });

		const again = await outbox(box, { action: "send-again", message: refused.id });
		expect(await again.json()).toMatchObject({ state: "sent", code: null, detail: null });
		const [first, second] = requestsTo(to);
		expect(first?.idempotencyKey).toBe(refused.id);
		// Resend turned the first down, so it would only answer the same to that key.
		expect(second?.idempotencyKey).toEqual(expect.any(String));
		expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
	});

	it("is tried again with the same key when Resend may have sent it, and goes once", {
		timeout: 60_000,
	}, async () => {
		const box = await resendBox();
		const to = `went-1@${box.slug}.example.org`;
		const message = await send(box, to);
		expect(message).toMatchObject({ state: "waiting", code: "resend:application_error" });
		const settled = await until(box, message, "sent");
		expect(settled?.state).toBe("sent");
		const tried = requestsTo(to);
		expect(tried).toHaveLength(2);
		expect(tried.map((one) => one.idempotencyKey)).toEqual([message.id, message.id]);
		expect([...sent.values()].filter((one) => one.body.includes(to))).toHaveLength(1);
	});

	it("keeps the idempotency key of a try that may have gone, so a refusal after it leaves the message uncertain and sending again can't send it twice", {
		timeout: 60_000,
	}, async () => {
		const box = await mailboxWithAddress();
		expect((await setKey(box, REVOCABLE_KEY)).status).toBe(200);
		expect((await sendWith(box, "resend")).status).toBe(200);
		const to = `went-1@${box.slug}.example.org`;
		const message = await send(box, to);
		expect(message).toMatchObject({ state: "waiting", code: "resend:application_error" });
		// Revoked before the next try, which Resend then refuses without looking for the message.
		revocable.active = false;
		try {
			const stopped = await until(box, message, "uncertain");
			expect(stopped).toMatchObject({ state: "uncertain", code: "resend:validation_error" });
		} finally {
			revocable.active = true;
		}
		const again = await outbox(box, { action: "send-again", message: message.id });
		expect(await again.json()).toMatchObject({ state: "sent" });
		const tried = requestsTo(to);
		expect(tried.map((one) => one.idempotencyKey)).toEqual([message.id, message.id, message.id]);
		expect([...sent.values()].filter((one) => one.body.includes(to))).toHaveLength(1);
	});

	it("stops rather than send through a replaced key what may have gone through the one before", {
		timeout: 60_000,
	}, async () => {
		const box = await resendBox();
		const to = `went-1@${box.slug}.example.org`;
		const message = await send(box, to);
		expect(message).toMatchObject({ state: "waiting", code: "resend:application_error" });
		// Resend knows an idempotency key only in the account that sent it.
		expect((await setKey(box, FULL_KEY)).status).toBe(200);
		const stopped = await until(box, message, "uncertain");
		expect(stopped).toMatchObject({ state: "uncertain", code: "resend:key_changed" });
		expect(requestsTo(to)).toHaveLength(1);
		// Someone who sends it again, having read why it stopped, sends it through the new key.
		const again = await outbox(box, { action: "send-again", message: message.id });
		expect(await again.json()).toMatchObject({ state: "sent" });
		const [, second, ...more] = requestsTo(to);
		expect(more).toEqual([]);
		expect(second).toMatchObject({
			authorization: `Bearer ${FULL_KEY}`,
			idempotencyKey: message.id,
		});
	});

	it("reads the key at each try, so one that no longer opens refuses it", {
		timeout: 60_000,
	}, async () => {
		const box = await resendBox();
		const to = `busy-1@${box.slug}.example.org`;
		const message = await send(box, to);
		expect(message).toMatchObject({ state: "waiting", code: "resend:rate_limit_exceeded" });
		// A sealed value from another workspace, as if moved here: it doesn't open for this one.
		const other = await resendBox();
		await mail.db
			.prepare(
				`UPDATE provider_key SET sealed = (SELECT sealed FROM provider_key WHERE organization_id = ?)
				WHERE organization_id = ?`,
			)
			.bind(other.workspaceId, box.workspaceId)
			.run();
		const settled = await until(box, message, "refused");
		expect(settled).toMatchObject({ state: "refused", code: "resend:key_unreadable" });
		expect(requestsTo(to)).toHaveLength(1);
	});
});
