import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type QueuedMessage, type SentEmail, startMail } from "./mail-worker";

// Email Service's delivery events, which Cloudflare hands to the Worker's `queue()` from the
// deployment's queue, recorded in the mailbox that sent the message and shown in its thread. The
// stand-in for Email Service gives each message an id, as `send()` does.

const origin = "https://mail.test";
const QUEUE = "gateweave-mail-events";

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

interface Delivery {
	recipient: string;
	state: string;
	at: number;
	detail: string | null;
}

interface ThreadPage {
	messages: {
		id: string;
		sent: { status: { state: string } | null; deliveries: Delivery[]; recipients: number };
	}[];
}

interface Directory {
	domains: {
		id: string;
		name: string;
		verifiedAt: number | null;
		proof: { value: string } | null;
		eventsAt: number | null;
	}[];
	mailboxes: { id: string; name: string }[];
}

async function directory(slug: string, headers: Record<string, string>, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers: { ...headers, origin, "content-type": "application/json" },
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as Directory;
}

/** A workspace of its own, with a proved domain and a mailbox with one address. */
async function mailboxWithAddress() {
	const n = ++counter;
	const slug = `events-${n}`;
	const domain = `events${n}.example.com`;
	const workspaceId = await createWorkspace(
		mail,
		origin,
		{ ...owner.headers, "cf-connecting-ip": `198.51.100.${n}` },
		slug,
	);
	await directory(slug, owner.headers, { action: "add-domain", name: domain });
	const [added] = (await directory(slug, owner.headers)).domains;
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
	await directory(slug, owner.headers, { action: "check-domain", id: added.id });
	await directory(slug, owner.headers, { action: "add-mailbox", name: `Support ${n}` });
	const made = (await directory(slug, owner.headers)).mailboxes.find(
		(box) => box.name === `Support ${n}`,
	);
	if (!made) throw new Error("expected a mailbox");
	await directory(slug, owner.headers, {
		action: "add-address",
		domainId: added.id,
		mailboxId: made.id,
		localPart: "help",
		expiresInDays: null,
	});
	return { slug, workspaceId, domain, mailboxId: made.id, address: `help@${domain}` };
}

type Box = Awaited<ReturnType<typeof mailboxWithAddress>>;

/** Sends a message from the mailbox, and gives what Email Service was handed, with its id. */
async function send(box: Box, to: string[]) {
	const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
		method: "POST",
		headers: { ...owner.headers, origin, "content-type": "application/json" },
		body: JSON.stringify({
			action: "send",
			draft: crypto.randomUUID(),
			to,
			subject: `Hello ${++counter}`,
			text: "Hello there.",
		}),
	});
	expect(response.status).toBe(200);
	const sent = (await response.json()) as { id: string; threadId: string; state: string };
	expect(sent.state).toBe("sent");
	const handed = (await mail.emails()).find(
		(email: SentEmail) => email.subject === `Hello ${counter}`,
	);
	if (!handed) throw new Error("expected the message at Email Service");
	return { ...sent, messageId: handed.messageId };
}

async function deliveries(box: Box, sent: { id: string; threadId: string }) {
	const response = await mail.fetch(
		`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${sent.threadId}`,
		{ headers: owner.headers },
	);
	expect(response.status).toBe(200);
	const page = (await response.json()) as ThreadPage;
	return page.messages.find((message) => message.id === sent.id)?.sent.deliveries;
}

async function recipients(box: Box, sent: { id: string; threadId: string }) {
	const response = await mail.fetch(
		`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${sent.threadId}`,
		{ headers: owner.headers },
	);
	const page = (await response.json()) as ThreadPage;
	return page.messages.find((message) => message.id === sent.id)?.sent.recipients;
}

let queued = 0;

/** An Email Sending event on the queue, as the staging measurement saw them. */
function event(
	type: string,
	{
		messageId,
		sender,
		recipient,
		domain = sender.slice(sender.indexOf("@") + 1),
		at = Date.now(),
		payload = {},
	}: {
		messageId: string;
		sender: string;
		recipient: string;
		domain?: string;
		at?: number;
		payload?: Record<string, unknown>;
	},
): QueuedMessage {
	return {
		id: `queued-${++queued}`,
		timestamp: new Date(),
		attempts: 1,
		body: {
			type: `cf.email.sending.message.${type}`,
			source: { zoneId: "zone", domain, type: "email.sending" },
			metadata: {
				accountId: "account",
				eventSubscriptionId: "subscription",
				eventSchemaVersion: 1,
				eventTimestamp: new Date(at).toISOString(),
			},
			payload: {
				eventId: crypto.randomUUID(),
				messageId,
				sender,
				recipient,
				subject: "Hello",
				terminal: type !== "deferred",
				delivery: { status: type, provider: "external_smtp" },
				...payload,
			},
		},
	};
}

beforeAll(async () => {
	mail = await startMail(origin, {
		hosts: { "dns.test": dns },
		settings: { DNS_RESOLVER_URL: "https://dns.test/dns-query" },
	});
	owner = await signUp(mail, origin, "Owner");
});

afterAll(() => mail.dispose());

describe("delivery events", () => {
	it("records each recipient's events in the mailbox that sent it, and its thread shows them", async () => {
		const box = await mailboxWithAddress();
		const sent = await send(box, ["ada@example.org", "grace@example.org"]);
		expect(await deliveries(box, sent)).toEqual([]);
		expect(await recipients(box, sent)).toBe(2);
		const base = { messageId: sent.messageId, sender: box.address };
		const batch = [
			event("deferred", {
				...base,
				recipient: "ada@example.org",
				at: Date.now() - 2000,
				payload: { delivery: { status: "deferred", smtpResponse: "451 4.2.0 Try later" } },
			}),
			// Addresses and the domain as an event may write them.
			event("delivered", {
				...base,
				sender: box.address.toUpperCase(),
				domain: box.domain.toUpperCase(),
				recipient: "Ada@Example.org",
				at: Date.now() - 1000,
			}),
			event("bounced", {
				...base,
				recipient: "grace@example.org",
				payload: { bounce: { type: "hard", reason: "550 5.1.1 User unknown" } },
			}),
		];
		const outcome = await mail.runQueue(QUEUE, batch);
		expect(outcome.retryMessages).toEqual([]);
		expect(outcome.explicitAcks.sort()).toEqual(batch.map(({ id }) => id).sort());
		expect(await deliveries(box, sent)).toEqual([
			{ recipient: "ada@example.org", state: "delivered", at: expect.any(Number), detail: null },
			{
				recipient: "grace@example.org",
				state: "bounced",
				at: expect.any(Number),
				detail: "550 5.1.1 User unknown",
			},
		]);

		// Again, and the delay late: nothing changes.
		await mail.runQueue(QUEUE, [...batch].reverse());
		expect((await deliveries(box, sent))?.map(({ state }) => state)).toEqual([
			"delivered",
			"bounced",
		]);
		await mail.runQueue(QUEUE, [
			event("complained", { ...base, recipient: "ada@example.org", at: Date.now() + 5000 }),
		]);
		expect((await deliveries(box, sent))?.map(({ state }) => state)).toEqual([
			"complained",
			"bounced",
		]);
	});

	it("notes on the Domains page, for admins, when events last came", async () => {
		const box = await mailboxWithAddress();
		const domainOf = async (headers: Record<string, string>) =>
			(await directory(box.slug, headers)).domains.find(({ name }) => name === box.domain);
		expect((await domainOf(owner.headers))?.eventsAt).toBeNull();
		// Any event from the domain's subscription counts, whoever sent the mail.
		const before = Date.now();
		await mail.runQueue(QUEUE, [
			event("delivered", {
				messageId: "<other-app@example.com>",
				sender: `notifications@${box.domain}`,
				recipient: "ada@example.org",
			}),
		]);
		expect((await domainOf(owner.headers))?.eventsAt).toBeGreaterThanOrEqual(before);
	});

	it("tells only the workspace that proved the domain when its events come", async () => {
		const box = await mailboxWithAddress();
		// Another workspace adds the same domain without proving it.
		const other = `events-other-${++counter}`;
		await createWorkspace(
			mail,
			origin,
			{ ...owner.headers, "cf-connecting-ip": `198.51.100.${counter}` },
			other,
		);
		await directory(other, owner.headers, { action: "add-domain", name: box.domain });
		await mail.runQueue(QUEUE, [
			event("delivered", {
				messageId: "<other-app@example.com>",
				sender: `notifications@${box.domain}`,
				recipient: "ada@example.org",
			}),
		]);
		const eventsAt = async (slug: string) =>
			(await directory(slug, owner.headers)).domains.find(({ name }) => name === box.domain)
				?.eventsAt;
		expect(await eventsAt(box.slug)).toEqual(expect.any(Number));
		expect(await eventsAt(other)).toBeNull();
	});

	it("stops recording for a mailbox once another workspace proves its domain and takes the address", async () => {
		const box = await mailboxWithAddress();
		const sent = await send(box, ["ada@example.org"]);
		const other = `events-other-${++counter}`;
		await createWorkspace(
			mail,
			origin,
			{ ...owner.headers, "cf-connecting-ip": `198.51.100.${counter}` },
			other,
		);
		await directory(other, owner.headers, { action: "add-domain", name: box.domain });
		const [added] = (await directory(other, owner.headers)).domains;
		if (!added?.proof) throw new Error("expected a proof");
		proofs.set(`_gateweave-mail.${box.domain}`, added.proof.value);
		await directory(other, owner.headers, { action: "check-domain", id: added.id });
		const moved = (await directory(box.slug, owner.headers)).domains.find(
			({ name }) => name === box.domain,
		);
		expect(moved?.verifiedAt).toBeNull();
		// The other workspace gives the same address to a mailbox of its own, which never sent the
		// message: the event reaches that mailbox, which doesn't find it.
		await directory(other, owner.headers, { action: "add-mailbox", name: "Theirs" });
		const theirs = (await directory(other, owner.headers)).mailboxes.find(
			({ name }) => name === "Theirs",
		);
		if (!theirs) throw new Error("expected a mailbox");
		await directory(other, owner.headers, {
			action: "add-address",
			domainId: added.id,
			mailboxId: theirs.id,
			localPart: "help",
			expiresInDays: null,
		});

		const late = event("bounced", {
			messageId: sent.messageId,
			sender: box.address,
			recipient: "ada@example.org",
			at: Date.now() - 60 * 60 * 1000,
		});
		const outcome = await mail.runQueue(QUEUE, [late]);
		expect(outcome.retryMessages).toEqual([]);
		expect(outcome.explicitAcks).toEqual([late.id]);
		const lines = mail.logs.filter(({ message }) => message.startsWith("delivery events:"));
		expect(lines.at(-1)?.message).toContain('"notFound":1');
		expect(await deliveries(box, sent)).toEqual([]);
	});

	it("drops events for mail Mail didn't send, and for addresses of no proved domain", async () => {
		const box = await mailboxWithAddress();
		const sent = await send(box, ["ada@example.org"]);
		const batch = [
			// Another app's mail from the same domain.
			event("delivered", {
				messageId: "<other-app@example.com>",
				sender: `notifications@${box.domain}`,
				recipient: "ada@example.org",
			}),
			// The mailbox's id, but a sender on a domain no workspace proved.
			event("delivered", {
				messageId: sent.messageId,
				sender: "help@unproved.example.net",
				recipient: "ada@example.org",
			}),
			// The mailbox's address and id, from another domain's subscription.
			event("delivered", {
				messageId: sent.messageId,
				sender: box.address,
				domain: "elsewhere.example.net",
				recipient: "ada@example.org",
			}),
			{ id: `queued-${++queued}`, timestamp: new Date(), attempts: 1, body: { type: "nope" } },
			{ id: `queued-${++queued}`, timestamp: new Date(), attempts: 1, body: "not json" },
		];
		const outcome = await mail.runQueue(QUEUE, batch);
		expect(outcome.retryMessages).toEqual([]);
		expect(outcome.explicitAcks.sort()).toEqual(batch.map(({ id }) => id).sort());
		expect(await deliveries(box, sent)).toEqual([]);
	});

	it("looks again for a message it doesn't find yet, but not for long", async () => {
		const box = await mailboxWithAddress();
		const young = event("delivered", {
			messageId: "<not-recorded-yet@outbox.test>",
			sender: box.address,
			recipient: "ada@example.org",
		});
		const old = event("delivered", {
			messageId: "<long-gone@outbox.test>",
			sender: box.address,
			recipient: "ada@example.org",
			at: Date.now() - 60 * 60 * 1000,
		});
		const outcome = await mail.runQueue(QUEUE, [young, old]);
		expect(outcome.retryMessages).toEqual([{ msgId: young.id, delaySeconds: 60 }]);
		expect(outcome.explicitAcks).toEqual([old.id]);
	});

	it("finds no message once it is deleted", async () => {
		const box = await mailboxWithAddress();
		const sent = await send(box, ["ada@example.org"]);
		const response = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/${sent.id}`,
			{ method: "DELETE", headers: { ...owner.headers, origin } },
		);
		expect(response.status).toBe(200);
		const late = event("bounced", {
			messageId: sent.messageId,
			sender: box.address,
			recipient: "ada@example.org",
			at: Date.now() - 60 * 60 * 1000,
		});
		const outcome = await mail.runQueue(QUEUE, [late]);
		expect(outcome.explicitAcks).toEqual([late.id]);
	});

	it("logs counts, never addresses", async () => {
		const box = await mailboxWithAddress();
		const sent = await send(box, ["private.person@example.org"]);
		await mail.runQueue(QUEUE, [
			event("delivered", {
				messageId: sent.messageId,
				sender: box.address,
				recipient: "private.person@example.org",
			}),
		]);
		const lines = mail.logs.filter(({ message }) => message.startsWith("delivery events:"));
		expect(lines.at(-1)?.message).toContain('"recorded":1');
		expect(mail.logs.map(({ message }) => message).join("\n")).not.toContain("private.person");
	});
});
