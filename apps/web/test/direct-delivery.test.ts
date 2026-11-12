import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type SentEmail, startMail } from "./mail-worker";

// Mail a mailbox sends to addresses this deployment hosts, which goes straight to their mailboxes
// rather than out through Email Service and back in through Email Routing (`mailbox/direct.ts`).

const origin = "https://mail.test";

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

type Mail = Awaited<ReturnType<typeof startMail>>;
type Asker = { headers: Record<string, string> };

let mail: Mail;
let off: Mail;
let owner: Asker;
let ownerOff: Asker;
let counter = 0;

interface Status {
	state: string;
	code: string | null;
	nextAt: number | null;
}

interface Sent extends Status {
	ok: true;
	id: string;
	threadId: string;
}

interface Delivery {
	recipient: string;
	state: string;
	detail: string | null;
}

interface ThreadPage {
	messages: {
		id: string;
		subject: string | null;
		sent: { status: Status | null; deliveries: Delivery[] } | null;
	}[];
}

interface MessageView {
	from: { address: string } | null;
	to: { address: string }[];
	subject: string | null;
	text: string;
	verifiedDomain: string | null;
	dmarc: string | null;
	sent: unknown;
}

async function directory(
	app: Mail,
	slug: string,
	headers: Record<string, string>,
	action?: unknown,
) {
	const response = await app.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers,
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as {
		proved?: boolean;
		domains: { id: string; proof: { value: string } | null }[];
		mailboxes: { id: string; name: string; addresses: { id: string; address: string }[] }[];
	};
}

/** A workspace of its own, with a proved domain and a mailbox with one address. */
async function mailboxWithAddress(app = mail, person = owner) {
	const n = ++counter;
	const slug = `direct-${n}`;
	const domain = `direct${n}.example.com`;
	const workspaceId = await createWorkspace(
		app,
		origin,
		{ ...person.headers, "cf-connecting-ip": `198.51.100.${n}` },
		slug,
	);
	await directory(app, slug, person.headers, { action: "add-domain", name: domain });
	const [added] = (await directory(app, slug, person.headers)).domains;
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
	mailHosts.set(domain, ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net"]);
	expect(
		(await directory(app, slug, person.headers, { action: "check-domain", id: added.id })).proved,
	).toBe(true);
	const name = `Desk ${n}`;
	await directory(app, slug, person.headers, { action: "add-mailbox", name });
	const made = (await directory(app, slug, person.headers)).mailboxes.find(
		(box) => box.name === name,
	);
	if (!made) throw new Error("expected a mailbox");
	await directory(app, slug, person.headers, {
		action: "add-address",
		domainId: added.id,
		mailboxId: made.id,
		localPart: "help",
		expiresInDays: null,
	});
	const address = (await directory(app, slug, person.headers)).mailboxes
		.find((box) => box.id === made.id)
		?.addresses.find((one) => one.address === `help@${domain}`);
	if (!address) throw new Error("expected the address");
	return {
		app,
		person,
		slug,
		workspaceId,
		domain,
		mailboxId: made.id,
		address: `help@${domain}`,
		addressId: address.id,
	};
}

type Box = Awaited<ReturnType<typeof mailboxWithAddress>>;

function outbox(box: Box, headers: Record<string, string>, body: Record<string, unknown>) {
	return box.app.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Sends a message as the box's owner and says what became of it. */
async function send(box: Box, draft: Record<string, unknown>) {
	const response = await outbox(
		box,
		{ ...box.person.headers, origin },
		{
			action: "send",
			draft: crypto.randomUUID(),
			subject: `Hello ${++counter}`,
			text: "Hello from next door.",
			...draft,
		},
	);
	expect(response.status).toBe(200);
	return (await response.json()) as Sent;
}

async function thread(box: Box, threadId: string): Promise<ThreadPage> {
	const response = await box.app.fetch(
		`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${threadId}`,
		{ headers: box.person.headers },
	);
	expect(response.status).toBe(200);
	return (await response.json()) as ThreadPage;
}

/** The mailbox's messages, newest first. */
async function messages(box: Box) {
	const response = await box.app.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}`, {
		headers: box.person.headers,
	});
	expect(response.status).toBe(200);
	return (
		(await response.json()) as {
			messages: { id: string; threadId: string; subject: string | null; sentBy?: unknown }[];
		}
	).messages;
}

async function message(box: Box, id: string): Promise<MessageView> {
	const response = await box.app.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}`, {
		headers: box.person.headers,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as MessageView;
}

/** What the stand-in for Email Service sent to this address. */
async function sentTo(app: Mail, address: string): Promise<SentEmail[]> {
	return (await app.emails()).filter((email) =>
		[email.to, email.cc ?? []].flat().includes(address),
	);
}

/** Fills a mailbox with one message from outside, which it gives back. */
async function fill(box: Box) {
	const big = [
		"From: Ada Lovelace <ada@example.org>",
		`To: ${box.address}`,
		"Subject: Big",
		"Date: Sun, 08 Nov 2026 09:00:00 +0000",
		`Message-ID: <big-${++counter}@example.org>`,
		"",
		// In lines of mail's usual length, as a longer one is refused.
		...Array.from({ length: Math.floor((MAILBOX_BYTES - 200) / 78) }, () => "x".repeat(76)),
		"",
	].join("\r\n");
	expect(await box.app.deliver("ada@example.org", box.address, big)).toMatchObject({ status: 200 });
	const [kept] = await messages(box);
	if (!kept) throw new Error("expected the big message");
	return kept;
}

async function deleteMessage(box: Box, id: string) {
	const removed = await box.app.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}`, {
		method: "DELETE",
		headers: { ...box.person.headers, origin },
	});
	expect(removed.status).toBe(200);
}

async function removeAddress(box: Box) {
	const removed = await directory(box.app, box.slug, box.person.headers, {
		action: "remove-address",
		id: box.addressId,
	});
	expect(removed).toMatchObject({ ok: true });
}

async function deliveries(box: Box, sent: Sent) {
	const copy = (await thread(box, sent.threadId)).messages.find((one) => one.id === sent.id);
	return Object.fromEntries(
		(copy?.sent?.deliveries ?? []).map((one) => [one.recipient, [one.state, one.detail]]),
	);
}

/** Polls the sent message's record until it is in this state, for what the alarm does. */
async function untilState(box: Box, sent: Sent, state: string) {
	let now = sent.state;
	for (let waited = 0; now !== state && waited < 45_000; waited += 1_000) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const copy = (await thread(box, sent.threadId)).messages.find((one) => one.id === sent.id);
		now = copy?.sent?.status?.state ?? "";
	}
	return now;
}

beforeAll(async () => {
	[mail, off] = await Promise.all([
		startMail(origin, {
			hosts: { "cloudflare-dns.com": dns },
			settings: { MAILBOX_BYTES: String(MAILBOX_BYTES) },
		}),
		startMail(origin, {
			hosts: { "cloudflare-dns.com": dns },
			settings: { DIRECT_DELIVERY: "off" },
		}),
	]);
	[owner, ownerOff] = await Promise.all([
		signUp(mail, origin, "Owner"),
		signUp(off, origin, "Owner"),
	]);
});

afterAll(async () => {
	await Promise.all([mail?.dispose(), off?.dispose()]);
});

describe("mail to an address here", () => {
	it("goes straight to its mailbox, proved by the sender's domain, without Email Service", async () => {
		const from = await mailboxWithAddress();
		const to = await mailboxWithAddress();
		const sent = await send(from, { to: [to.address] });
		expect(sent).toMatchObject({ state: "sent", code: null });
		expect(await sentTo(mail, to.address)).toHaveLength(0);

		const [arrived] = await messages(to);
		if (!arrived) throw new Error("expected the message to arrive");
		const view = await message(to, arrived.id);
		expect(view).toMatchObject({
			from: { address: from.address },
			to: [{ address: to.address }],
			verifiedDomain: from.domain,
			dmarc: null,
			sent: null,
		});
		expect(view.text).toContain("Hello from next door.");

		const [copy] = (await thread(from, sent.threadId)).messages;
		expect(copy?.sent?.deliveries).toEqual([
			expect.objectContaining({ recipient: to.address, state: "delivered" }),
		]);
	});

	it("reaches every mailbox it is for, To and Cc, once each", async () => {
		const from = await mailboxWithAddress();
		const one = await mailboxWithAddress();
		const two = await mailboxWithAddress();
		const sent = await send(from, { to: [one.address], cc: [two.address] });
		expect(sent.state).toBe("sent");
		expect(await messages(one)).toHaveLength(1);
		expect(await messages(two)).toHaveLength(1);
		const states = (await thread(from, sent.threadId)).messages[0]?.sent?.deliveries.map(
			(delivery) => [delivery.recipient, delivery.state],
		);
		expect(states).toEqual(
			expect.arrayContaining([
				[one.address, "delivered"],
				[two.address, "delivered"],
			]),
		);
	});

	it("arrives with its files, byte for byte", async () => {
		const from = await mailboxWithAddress();
		const to = await mailboxWithAddress();
		// Larger than one read of the copy, so it arrives in several.
		const bytes = new Uint8Array(200_000).map((_, at) => (at * 7) % 256);
		const sent = await send(from, {
			to: [to.address],
			attachments: [
				{
					filename: "report.bin",
					contentType: "application/octet-stream",
					content: Buffer.from(bytes).toString("base64"),
				},
			],
		});
		expect(sent.state).toBe("sent");
		const [arrived] = await messages(to);
		if (!arrived) throw new Error("expected the message to arrive");
		const view = (await message(to, arrived.id)) as MessageView & {
			attachments: { name: string; size: number }[];
		};
		expect(view.attachments).toEqual([expect.objectContaining({ name: "report.bin" })]);
		const file = await mail.fetch(
			`${origin}/api/mail/${to.slug}/${to.mailboxId}/${arrived.id}/attachments/0`,
			{ headers: owner.headers },
		);
		expect(file.status).toBe(200);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
	});

	it("is kept by its own mailbox as mail it got, in the same thread", async () => {
		const box = await mailboxWithAddress();
		const sent = await send(box, { to: [box.address] });
		expect(sent.state).toBe("sent");
		const page = await thread(box, sent.threadId);
		expect(page.messages).toHaveLength(2);
		const got = page.messages.find((one) => one.sent === null);
		if (!got) throw new Error("expected the mail it got");
		expect(await message(box, got.id)).toMatchObject({ verifiedDomain: box.domain, dmarc: null });
	});

	it("goes through Email Service to everyone when anyone it is for isn't here", async () => {
		const from = await mailboxWithAddress();
		const to = await mailboxWithAddress();
		const sent = await send(from, { to: [to.address, "ada@example.org"] });
		expect(sent.state).toBe("sent");
		const [email] = await sentTo(mail, "ada@example.org");
		// The headers keep everyone, so the one here gets it as the others do: through MX.
		expect([email?.to].flat()).toEqual([to.address, "ada@example.org"]);
		expect(await messages(to)).toHaveLength(0);
	});

	it("waits while a mailbox here is full, and arrives once it has room", {
		timeout: 60_000,
	}, async () => {
		const from = await mailboxWithAddress();
		const to = await mailboxWithAddress();
		const kept = await fill(to);

		const sent = await send(from, { to: [to.address], subject: "Room now" });
		expect(sent).toMatchObject({ state: "waiting", code: "mail:direct_full" });
		expect(await sentTo(mail, to.address)).toHaveLength(0);

		await deleteMessage(to, kept.id);
		expect(await untilState(from, sent, "sent")).toBe("sent");
		const arrived = await messages(to);
		expect(arrived.map((one) => one.subject)).toEqual(["Room now"]);
		expect(await sentTo(mail, to.address)).toHaveLength(0);
	});

	it("gives those who have it no second copy when it is tried again for the others", {
		timeout: 60_000,
	}, async () => {
		const from = await mailboxWithAddress();
		const roomy = await mailboxWithAddress();
		const full = await mailboxWithAddress();
		const kept = await fill(full);

		const sent = await send(from, { to: [roomy.address, full.address], subject: "Half way" });
		expect(sent).toMatchObject({ state: "waiting", code: "mail:direct_full" });
		expect(await messages(roomy)).toHaveLength(1);
		expect(await deliveries(from, sent)).toEqual({ [roomy.address]: ["delivered", null] });

		// Someone has it, so it isn't unsent any more.
		const discarded = await outbox(
			from,
			{ ...owner.headers, origin },
			{ action: "discard", message: sent.id },
		);
		expect(discarded.status).toBe(409);
		expect(await discarded.json()).toMatchObject({
			error: "Only a message that hasn't reached anyone can be discarded.",
		});

		await deleteMessage(full, kept.id);
		expect(await untilState(from, sent, "sent")).toBe("sent");
		expect((await messages(roomy)).map((one) => one.subject)).toEqual(["Half way"]);
		expect((await messages(full)).map((one) => one.subject)).toEqual(["Half way"]);
		expect(await deliveries(from, sent)).toEqual({
			[roomy.address]: ["delivered", null],
			[full.address]: ["delivered", null],
		});
	});

	it("goes no further once its sender deletes it, though some have it", {
		timeout: 60_000,
	}, async () => {
		const from = await mailboxWithAddress();
		const roomy = await mailboxWithAddress();
		const full = await mailboxWithAddress();
		const kept = await fill(full);
		const sent = await send(from, { to: [roomy.address, full.address], subject: "Stopped" });
		expect(sent.state).toBe("waiting");

		await deleteMessage(from, sent.id);
		await deleteMessage(full, kept.id);
		// Past the first wait, when a try would have come.
		await new Promise((resolve) => setTimeout(resolve, 20_000));
		expect(await messages(full)).toHaveLength(0);
		expect((await messages(roomy)).map((one) => one.subject)).toEqual(["Stopped"]);
	});

	it("is refused when its sender's address is gone by the next try", {
		timeout: 60_000,
	}, async () => {
		const from = await mailboxWithAddress();
		const to = await mailboxWithAddress();
		const kept = await fill(to);
		const sent = await send(from, { to: [to.address] });
		expect(sent.state).toBe("waiting");

		await removeAddress(from);
		await deleteMessage(to, kept.id);
		expect(await untilState(from, sent, "refused")).toBe("refused");
		const copy = (await thread(from, sent.threadId)).messages.find((one) => one.id === sent.id);
		expect(copy?.sent?.status?.code).toBe("mail:direct_sender");
		expect(await messages(to)).toHaveLength(0);
		expect(await sentTo(mail, to.address)).toHaveLength(0);
	});

	it("bounces for an address that is gone by the next try, and is sent to the rest", {
		timeout: 60_000,
	}, async () => {
		const from = await mailboxWithAddress();
		const roomy = await mailboxWithAddress();
		const full = await mailboxWithAddress();
		await fill(full);
		const sent = await send(from, { to: [roomy.address, full.address] });
		expect(sent.state).toBe("waiting");

		await removeAddress(full);
		expect(await untilState(from, sent, "sent")).toBe("sent");
		expect(await deliveries(from, sent)).toEqual({
			[roomy.address]: ["delivered", null],
			[full.address]: ["bounced", "No such address"],
		});
	});
});

describe("mail to an address here, when DNS doesn't agree today", () => {
	/** Sends from one new mailbox to another after `change`, and says how it went. */
	async function sendAfter(change: (from: Box, to: Box) => void) {
		const from = await mailboxWithAddress();
		const to = await mailboxWithAddress();
		change(from, to);
		const sent = await send(from, { to: [to.address] });
		expect(sent.state).toBe("sent");
		return { through: await sentTo(mail, to.address), arrived: await messages(to) };
	}

	it("goes through Email Service when the recipient's domain no longer shows its record", async () => {
		const { through, arrived } = await sendAfter((_, to) =>
			proofs.delete(`_gateweave-mail.${to.domain}`),
		);
		expect(through).toHaveLength(1);
		expect(arrived).toHaveLength(0);
	});

	it("goes through Email Service when the recipient's mail goes elsewhere", async () => {
		const { through, arrived } = await sendAfter((_, to) =>
			mailHosts.set(to.domain, ["aspmx.l.google.com"]),
		);
		expect(through).toHaveLength(1);
		expect(arrived).toHaveLength(0);
	});

	it("goes through Email Service when the sender's domain no longer shows its record", async () => {
		const { through, arrived } = await sendAfter((from) =>
			proofs.delete(`_gateweave-mail.${from.domain}`),
		);
		expect(through).toHaveLength(1);
		expect(arrived).toHaveLength(0);
	});

	it("goes through Email Service when DNS can't say", async () => {
		const { through, arrived } = await sendAfter((_, to) => unanswered.add(to.domain));
		expect(through).toHaveLength(1);
		expect(arrived).toHaveLength(0);
	});
});

describe("an agent's mail to an address here", () => {
	it("still waits for a person to approve it, then goes straight there", async () => {
		const from = await mailboxWithAddress();
		const to = await mailboxWithAddress();
		const made = await mail.fetch(`${origin}/api/auth/agents/create`, {
			method: "POST",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify({ organizationId: from.workspaceId, name: "Courier" }),
		});
		expect(made.status).toBe(200);
		const { agent, key } = (await made.json()) as { agent: { memberId: string }; key: string };
		const access = await mail.fetch(`${origin}/api/directory/${from.slug}`, {
			method: "POST",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify({
				action: "set-mailbox-access",
				mailboxId: from.mailboxId,
				everyone: false,
				memberIds: [agent.memberId],
				senderIds: [agent.memberId],
			}),
		});
		expect(access.status).toBe(200);

		const written = await outbox(
			from,
			{ authorization: `Bearer ${key}` },
			{
				action: "send",
				draft: crypto.randomUUID(),
				to: [to.address],
				subject: "From the courier",
				text: "Your parcel is here.",
			},
		);
		expect(written.status).toBe(200);
		const held = (await written.json()) as Sent;
		expect(held.state).toBe("held");
		expect(await messages(to)).toHaveLength(0);

		const approved = await outbox(
			from,
			{ ...owner.headers, origin },
			{ action: "approve", message: held.id },
		);
		expect(approved.status).toBe(200);
		expect(((await approved.json()) as Status).state).toBe("sent");
		const [arrived] = await messages(to);
		expect(arrived?.subject).toBe("From the courier");
		expect(await sentTo(mail, to.address)).toHaveLength(0);
	});
});

describe("with DIRECT_DELIVERY off", () => {
	it("mail to an address here goes through Email Service, as to anyone", async () => {
		const from = await mailboxWithAddress(off, ownerOff);
		const to = await mailboxWithAddress(off, ownerOff);
		const sent = await send(from, { to: [to.address] });
		expect(sent.state).toBe("sent");
		expect(await sentTo(off, to.address)).toHaveLength(1);
		expect(await messages(to)).toHaveLength(0);
	});
});
