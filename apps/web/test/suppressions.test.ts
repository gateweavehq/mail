import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type QueuedMessage, startMail } from "./mail-worker";

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

let queued = 0;

/** An Email Sending event on the queue, from the mailbox's address unless said otherwise. */
function event(
	box: Box,
	type: string,
	recipient: string,
	payload: Record<string, unknown> = {},
	at = Date.now(),
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
				// Not a message the mailbox has, as for a send Email Service refused.
				messageId: `<not-sent-${queued}@outbox.test>`,
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
const listRefusal = {
	rejection: { reason: "suppressed", party: "recipient", detail: "Recipient is suppressed" },
};

async function list(slug: string, query = "", headers: Record<string, string> = owner.headers) {
	const response = await mail.fetch(
		`${origin}/api/suppressions/${slug}${query ? `?q=${encodeURIComponent(query)}` : ""}`,
		{ headers },
	);
	return { status: response.status, body: (await response.json()) as { suppressions?: Entry[] } };
}

async function entries(slug: string) {
	const { status, body } = await list(slug);
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

beforeAll(async () => {
	mail = await startMail(origin, {
		hosts: { "dns.test": dns },
		settings: { DNS_RESOLVER_URL: "https://dns.test/dns-query" },
	});
	owner = await signUp(mail, origin, "Owner");
});

afterAll(() => mail.dispose());

describe("a workspace's suppression list", () => {
	it("takes a complaint, a hard bounce and the provider's refusal, and nothing milder", async () => {
		const box = await mailboxWithAddress();
		const at = Date.now() - 1000;
		const outcome = await mail.runQueue(QUEUE, [
			event(box, "bounced", "Ada@Example.org", hardBounce(), at),
			event(box, "bounced", "bob@example.org", hardBounce("554 5.7.1 Policy"), at),
			event(box, "complained", "grace@example.org", complaint, at),
			event(box, "rejected", "lin@example.org", listRefusal, at),
			event(box, "bounced", "zoe@example.org", { bounce: { type: "soft", reason: "452" } }, at),
			event(box, "deferred", "zoe@example.org", {}, at),
			event(box, "failed", "zoe@example.org", { failure: { reason: "delivery_failed" } }, at),
			event(box, "rejected", "zoe@example.org", { rejection: { reason: "validation" } }, at),
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
		expect((await list(box.slug, "GRACE")).body.suppressions?.map((e) => e.address)).toEqual([
			"grace@example.org",
		]);
		expect((await list(box.slug, "%")).body.suppressions).toEqual([]);
	});

	it("keeps the stronger reason and the later end, whatever order events come in", async () => {
		const box = await mailboxWithAddress();
		const at = Date.now() - 10_000;
		await mail.runQueue(QUEUE, [event(box, "rejected", "ada@example.org", listRefusal, at)]);
		await mail.runQueue(QUEUE, [event(box, "complained", "ada@example.org", complaint, at + 1000)]);
		// Late and weaker: the complaint stays, for good.
		await mail.runQueue(QUEUE, [
			event(box, "bounced", "ada@example.org", hardBounce("554 5.7.1 Policy"), at + 500),
		]);
		expect(await entries(box.slug)).toEqual([
			expect.objectContaining({
				address: "ada@example.org",
				reason: "complained",
				firstAt: at,
				lastAt: at + 1000,
				expiresAt: null,
			}),
		]);
	});

	it("forgets an entry once it has ended", async () => {
		const box = await mailboxWithAddress();
		const long = Date.now() - 8 * DAY;
		await mail.runQueue(QUEUE, [
			event(box, "bounced", "ada@example.org", hardBounce("554 5.7.1 Policy"), long),
		]);
		expect(await entries(box.slug)).toEqual([]);
		expect((await outbox(box, writing(["ada@example.org"]))).status).toBe(200);
	});

	it("refuses to send to an address on it, naming it, until an admin removes it", async () => {
		const box = await mailboxWithAddress();
		await mail.runQueue(QUEUE, [event(box, "bounced", "ada@example.org", hardBounce())]);
		const before = (await mail.emails()).length;
		const draft = crypto.randomUUID();
		const refused = await outbox(box, writing(["Ada@Example.org", "grace@example.org"], draft));
		expect(refused.status).toBe(409);
		const said = (await refused.json()) as { ok: boolean; error: string; suppressed: string[] };
		expect(said.suppressed).toEqual(["ada@example.org"]);
		expect(said.error).toContain("ada@example.org (bounced)");
		expect(said.error).toContain("Settings, under Suppressions");
		expect(await mail.emails()).toHaveLength(before);

		const [entry] = await entries(box.slug);
		if (!entry) throw new Error("expected an entry");
		expect((await remove(box.slug, entry.id)).status).toBe(200);
		expect(await entries(box.slug)).toEqual([]);
		expect((await remove(box.slug, entry.id)).status).toBe(404);
		// The same draft goes now: nothing of it was kept.
		const sent = await outbox(box, writing(["ada@example.org", "grace@example.org"], draft));
		expect(sent.status).toBe(200);
		expect(((await sent.json()) as { state: string }).state).toBe("sent");
	});

	it("refuses to try again a message whose address came onto it since", async () => {
		const box = await mailboxWithAddress();
		const blocked = "refuse-E_RECIPIENT_SUPPRESSED@example.org";
		const first = await outbox(box, writing([blocked]));
		const sent = (await first.json()) as { id: string; state: string; code: string };
		expect(sent).toMatchObject({ state: "refused", code: "E_RECIPIENT_SUPPRESSED" });
		// Email Service tells of the refusal as an event, which names the address.
		await mail.runQueue(QUEUE, [event(box, "rejected", blocked, listRefusal)]);
		const again = await outbox(box, { action: "send-again", message: sent.id });
		expect(again.status).toBe(409);
		expect(((await again.json()) as { suppressed: string[] }).suppressed).toEqual([
			blocked.toLowerCase(),
		]);
	});

	it("refuses an agent's message to an address on it, and its approval once one comes", async () => {
		const box = await mailboxWithAddress();
		const made = await mail.fetch(`${origin}/api/auth/agents/create`, {
			method: "POST",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify({ organizationId: box.workspaceId, name: "Sorter" }),
		});
		const { agent, key } = (await made.json()) as { agent: { memberId: string }; key: string };
		const reader = await join(box.workspaceId);
		await directory(box.slug, {
			action: "set-mailbox-access",
			mailboxId: box.mailboxId,
			everyone: false,
			memberIds: [agent.memberId, reader.memberId],
			senderIds: [agent.memberId],
		});
		const keyed = { authorization: `Bearer ${key}` };
		await mail.runQueue(QUEUE, [event(box, "complained", "ada@example.org", complaint)]);
		const refused = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
			method: "POST",
			headers: { ...keyed, "content-type": "application/json" },
			body: JSON.stringify(writing(["ada@example.org"])),
		});
		expect(refused.status).toBe(409);
		expect(((await refused.json()) as { error: string }).error).toContain(
			"ada@example.org (marked as spam)",
		);

		// Held for approval, then its address bounces before anyone approves it.
		const held = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
			method: "POST",
			headers: { ...keyed, "content-type": "application/json" },
			body: JSON.stringify(writing(["grace@example.org"])),
		});
		const waiting = (await held.json()) as { id: string; state: string };
		expect(waiting.state).toBe("held");
		await mail.runQueue(QUEUE, [event(box, "bounced", "grace@example.org", hardBounce())]);
		const approve = await outbox(box, { action: "approve", message: waiting.id }, reader.headers);
		expect(approve.status).toBe(409);
		expect(((await approve.json()) as { suppressed: string[] }).suppressed).toEqual([
			"grace@example.org",
		]);
	});

	it("is the workspace's own", async () => {
		const box = await mailboxWithAddress();
		const other = await mailboxWithAddress();
		await mail.runQueue(QUEUE, [event(box, "complained", "ada@example.org", complaint)]);
		expect(await entries(other.slug)).toEqual([]);
		expect((await outbox(other, writing(["ada@example.org"]))).status).toBe(200);
		const [entry] = await entries(box.slug);
		if (!entry) throw new Error("expected an entry");
		// Another workspace's admin can't remove it by its id.
		expect((await remove(other.slug, entry.id)).status).toBe(404);
		expect(await entries(box.slug)).toHaveLength(1);
		// Events for another domain's subscription, or from an address that isn't a mailbox's, add
		// nothing.
		await mail.runQueue(QUEUE, [
			{
				...event(box, "complained", "bob@example.org", complaint),
				body: {
					...(event(box, "complained", "bob@example.org", complaint).body as object),
					source: { type: "email.sending", domain: other.domain },
				},
			},
			event(
				{ ...box, address: `notifications@${box.domain}` },
				"complained",
				"lin@example.org",
				complaint,
			),
		]);
		expect((await entries(box.slug)).map(({ address }) => address)).toEqual(["ada@example.org"]);
		expect(await entries(other.slug)).toEqual([]);
	});

	it("shows only to owners and admins, and changes only from the app", async () => {
		const box = await mailboxWithAddress();
		await mail.runQueue(QUEUE, [event(box, "complained", "ada@example.org", complaint)]);
		const [entry] = await entries(box.slug);
		if (!entry) throw new Error("expected an entry");
		const member = await join(box.workspaceId);
		expect((await list(box.slug, "", member.headers)).status).toBe(403);
		expect((await remove(box.slug, entry.id, member.headers)).status).toBe(403);
		const admin = await join(box.workspaceId, "admin");
		expect((await list(box.slug, "", admin.headers)).status).toBe(200);
		const stranger = await signUp(mail, origin, "Stranger");
		expect((await list(box.slug, "", stranger.headers)).status).toBe(404);
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

	it("logs how many, never who", async () => {
		const box = await mailboxWithAddress();
		await mail.runQueue(QUEUE, [event(box, "complained", "private.person@example.org", complaint)]);
		const lines = mail.logs.filter(({ message }) => message.startsWith("delivery events:"));
		expect(lines.at(-1)?.message).toContain('"suppressed":1');
		expect(mail.logs.map(({ message }) => message).join("\n")).not.toContain("private.person");
	});
});
