import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { type SentEmail, startMail } from "./mail-worker";

// Sending from a mailbox, reached as a browser reaches it, through the built Worker in workerd. The
// stand-in for Email Service fails for addresses that ask it to (see `OUTBOX` in mail-worker.ts).

const origin = "https://mail.test";

/** How many messages a workspace may send a day in these tests. */
const SEND_PER_DAY = 6;

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
}

interface Sent {
	ok: true;
	id: string;
	threadId: string;
	state: string;
	code: string | null;
	nextAt: number | null;
}

interface ThreadPage {
	count: number;
	from: string[];
	messages: {
		id: string;
		from: { name: string; address: string } | null;
		sent: { by: string | null; status: Status | null } | null;
	}[];
	latest: {
		id: string;
		text: string;
		reply: { to: string[]; cc: string[]; subject: string; from: string | null };
	};
}

async function directory(slug: string, headers: Record<string, string>, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers,
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as {
		ok?: boolean;
		proved?: boolean;
		domains: { id: string; proof: { value: string } | null }[];
		mailboxes: { id: string; name: string }[];
	};
}

/** A workspace of its own, with a proved domain and a mailbox with one address. */
async function mailboxWithAddress() {
	const n = ++counter;
	const slug = `send-${n}`;
	const domain = `send${n}.example.com`;
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
	expect(
		(await directory(slug, owner.headers, { action: "check-domain", id: added.id })).proved,
	).toBe(true);
	const name = `Support ${n}`;
	await directory(slug, owner.headers, { action: "add-mailbox", name });
	const made = (await directory(slug, owner.headers)).mailboxes.find((box) => box.name === name);
	if (!made) throw new Error("expected a mailbox");
	await directory(slug, owner.headers, {
		action: "add-address",
		domainId: added.id,
		mailboxId: made.id,
		localPart: "help",
		expiresInDays: null,
	});
	return {
		slug,
		workspaceId,
		domain,
		domainId: added.id,
		mailboxId: made.id,
		name,
		address: `help@${domain}`,
	};
}

type Box = Awaited<ReturnType<typeof mailboxWithAddress>>;

/** Asks the outbox. A send gets a draft id of its own unless it brings one, as the page's do. */
function outbox(
	box: Box,
	person: Asker,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
) {
	const sent = body.action === "send" ? { draft: crypto.randomUUID(), ...body } : body;
	return mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
		method: "POST",
		headers: { ...person.headers, origin, "content-type": "application/json", ...headers },
		body: JSON.stringify(sent),
	});
}

/** Sends a message and says what became of it. */
async function send(box: Box, draft: Record<string, unknown>, person: Asker = owner) {
	const response = await outbox(box, person, {
		action: "send",
		subject: "Hello",
		text: "Hello there.",
		...draft,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as Sent;
}

async function thread(box: Box, threadId: string): Promise<ThreadPage> {
	const response = await mail.fetch(
		`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${threadId}`,
		{ headers: owner.headers },
	);
	expect(response.status).toBe(200);
	return (await response.json()) as ThreadPage;
}

/** Mail that arrives at the mailbox, as Email Routing hands it to the Worker. */
async function arrive(box: Box, lines: string[], body = "Hello.", to = box.address) {
	const raw = [
		"From: Ada Lovelace <ada@example.org>",
		`To: ${to}`,
		"Date: Sun, 08 Nov 2026 09:00:00 +0000",
		...lines,
		"",
		body,
		"",
	].join("\r\n");
	const answer = await mail.deliver("ada@example.org", to, raw);
	expect(answer.status).toBe(200);
	const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}`, {
		headers: owner.headers,
	});
	const page = (await response.json()) as { messages: { id: string; threadId: string }[] };
	const [newest] = page.messages;
	if (!newest) throw new Error("expected the message");
	return newest;
}

/** What the stand-in for Email Service sent to this address. */
async function sentTo(address: string): Promise<SentEmail[]> {
	return (await mail.emails()).filter((email) =>
		[email.to, email.cc ?? []].flat().includes(address),
	);
}

/** Someone new in the workspace, with this role, and the id of their membership. */
async function join(workspaceId: string, role = "member") {
	const name = `Writer${++counter}`;
	const who = await signUp(mail, origin, name);
	const memberId = crypto.randomUUID();
	await mail.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(memberId, workspaceId, who.userId, role, Date.now())
		.run();
	return { ...who, name, memberId };
}

beforeAll(async () => {
	mail = await startMail(origin, {
		hosts: { "cloudflare-dns.com": dns },
		settings: { SEND_PER_DAY: String(SEND_PER_DAY) },
	});
	owner = await signUp(mail, origin, "Owner");
});

afterAll(async () => {
	await mail?.dispose();
});

describe("a reply", () => {
	it("goes from the address the message came to, where it asked, in its thread", async () => {
		const box = await mailboxWithAddress();
		// A second address, which the mail comes to: the mailbox's first isn't the one to answer from.
		await directory(box.slug, owner.headers, {
			action: "add-address",
			domainId: box.domainId,
			mailboxId: box.mailboxId,
			localPart: "accounts",
			expiresInDays: null,
		});
		const accounts = `accounts@${box.domain}`;
		const first = await arrive(
			box,
			[
				"Subject: Invoice 42",
				"Message-ID: <first@example.org>",
				"References: <zero@example.org>",
				"Reply-To: Billing <billing@example.org>",
			],
			"Hello.",
			accounts,
		);
		const before = await thread(box, first.threadId);
		expect(before.from).toEqual([box.address, accounts]);
		expect(before.latest.reply).toEqual({
			to: ["billing@example.org"],
			cc: [],
			subject: "Re: Invoice 42",
			from: accounts,
		});

		const sent = await send(box, {
			to: ["billing@example.org"],
			subject: "Re: Invoice 42",
			text: "It's paid.\n\nThanks!",
			replyTo: first.id,
		});
		expect(sent).toMatchObject({ ok: true, threadId: first.threadId, state: "sent", code: null });

		const [email] = await sentTo("billing@example.org");
		expect(email).toMatchObject({
			from: { name: box.name, email: accounts },
			to: ["billing@example.org"],
			subject: "Re: Invoice 42",
			text: "It's paid.\n\nThanks!",
		});
		expect(email?.headers?.["In-Reply-To"]).toBe("<first@example.org>");
		expect(email?.headers?.References).toMatch(
			new RegExp(`^<zero@example\\.org> <first@example\\.org> <[0-9a-f-]{36}@${box.domain}>$`),
		);

		const after = await thread(box, first.threadId);
		expect(after.count).toBe(2);
		expect(after.messages.at(-1)).toMatchObject({
			id: sent.id,
			from: { name: box.name, address: accounts },
			sent: { by: "Owner", status: { state: "sent", code: null, nextAt: null } },
		});
		expect(after.messages[0]?.sent).toBeNull();
		expect(after.latest.text.replace(/\r\n/g, "\n")).toBe("It's paid.\n\nThanks!");
		// A reply to what the mailbox sent goes to those it went to, from the address it went from.
		expect(after.latest.reply).toEqual({
			to: ["billing@example.org"],
			cc: [],
			subject: "Re: Invoice 42",
			from: accounts,
		});
	});

	it("leaves out of its headers an id Email Service would refuse, and stays in its thread", async () => {
		const box = await mailboxWithAddress();
		const first = await arrive(box, [
			"Subject: Café",
			"Message-ID: <caf\u00e9@example.org>",
			"References: <ok@example.org> <b\u00e4d@example.org>",
		]);
		const sent = await send(box, {
			to: [`ada.${box.slug}@example.org`],
			subject: "Re: Café",
			replyTo: first.id,
		});
		expect(sent).toMatchObject({ state: "sent", threadId: first.threadId });
		const [email] = await sentTo(`ada.${box.slug}@example.org`);
		expect(email?.headers?.["In-Reply-To"]).toBeUndefined();
		expect(email?.headers?.References).toMatch(
			new RegExp(`^<ok@example\\.org> <[0-9a-f-]{36}@${box.domain}>$`),
		);

		// With nothing to thread it by in what is sent, its copy still is, by the ids it answers.
		const alone = await arrive(box, ["Subject: Tea", "Message-ID: <th\u00e9@example.org>"]);
		const answer = await send(box, {
			to: [`grace.${box.slug}@example.org`],
			subject: "Re: Tea",
			replyTo: alone.id,
		});
		expect(answer.threadId).toBe(alone.threadId);
		const [plain] = await sentTo(`grace.${box.slug}@example.org`);
		expect(plain?.headers?.References).toMatch(new RegExp(`^<[0-9a-f-]{36}@${box.domain}>$`));
	});

	it("to a message the mailbox wrote finds its thread, whatever Email Service called it", async () => {
		const box = await mailboxWithAddress();
		const sent = await send(box, { to: ["ada@example.org"], subject: "Your order" });
		const [email] = await sentTo("ada@example.org");
		const ours = email?.headers?.References;
		expect(ours).toMatch(new RegExp(`^<[0-9a-f-]{36}@${box.domain}>$`));
		// Email Service's own Message-ID is one Mail never saw; Mail's id comes back in References.
		const answer = await arrive(box, [
			"Subject: Re: Your order",
			"Message-ID: <answer@example.org>",
			"In-Reply-To: <made-by-email-service@example.net>",
			`References: ${ours} <made-by-email-service@example.net>`,
		]);
		expect(answer.threadId).toBe(sent.threadId);
		expect((await thread(box, sent.threadId)).count).toBe(2);
	});
});

describe("a message that isn't sent", () => {
	it("says why, and can be sent again or discarded", async () => {
		const box = await mailboxWithAddress();
		const refused = await send(box, { to: ["refuse-E_RECIPIENT_SUPPRESSED@example.org"] });
		expect(refused).toMatchObject({ state: "refused", code: "E_RECIPIENT_SUPPRESSED" });
		expect(await sentTo("refuse-E_RECIPIENT_SUPPRESSED@example.org")).toEqual([]);
		const shown = (await thread(box, refused.threadId)).messages[0]?.sent?.status;
		expect(shown).toEqual({ state: "refused", code: "E_RECIPIENT_SUPPRESSED", nextAt: null });

		const again = await outbox(box, owner, { action: "send-again", message: refused.id });
		expect(await again.json()).toMatchObject({ ok: true, state: "refused" });
		expect((await outbox(box, owner, { action: "discard", message: refused.id })).status).toBe(200);
		const gone = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${refused.threadId}`,
			{ headers: owner.headers },
		);
		expect(gone.status).toBe(404);
		expect(
			(await mail.bucket.list({ prefix: `${box.workspaceId}/${box.mailboxId}/` })).objects,
		).toEqual([]);
	});

	it("is never sent again by itself when it may have gone, only when a person asks", async () => {
		const box = await mailboxWithAddress();
		const lost = await send(box, { to: ["lost-1@example.org"] });
		expect(lost).toMatchObject({ state: "uncertain", code: null });
		// Long enough for an alarm that would try again, were there one.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		expect((await thread(box, lost.threadId)).messages[0]?.sent?.status?.state).toBe("uncertain");
		expect(await sentTo("lost-1@example.org")).toEqual([]);

		const again = await outbox(box, owner, { action: "send-again", message: lost.id });
		expect(await again.json()).toMatchObject({ ok: true, state: "sent" });
		expect(await sentTo("lost-1@example.org")).toHaveLength(1);
		// Once sent, it is neither sent again nor discarded.
		expect((await outbox(box, owner, { action: "send-again", message: lost.id })).status).toBe(409);
		expect((await outbox(box, owner, { action: "discard", message: lost.id })).status).toBe(409);
	});

	it("is tried again by itself while Email Service is busy", { timeout: 60_000 }, async () => {
		const box = await mailboxWithAddress();
		const busy = await send(box, { to: ["busy-1@example.org"] });
		expect(busy).toMatchObject({ state: "waiting", code: "E_RATE_LIMIT_EXCEEDED" });
		expect(busy.nextAt).toBeGreaterThan(Date.now() + 10_000);
		let state = busy.state;
		for (let waited = 0; state !== "sent" && waited < 45_000; waited += 1_000) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			state = (await thread(box, busy.threadId)).messages[0]?.sent?.status?.state ?? "";
		}
		expect(state).toBe("sent");
		expect(await sentTo("busy-1@example.org")).toHaveLength(1);
	});

	it("is the same message when its draft comes again, as after a lost answer", async () => {
		const box = await mailboxWithAddress();
		const draft = crypto.randomUUID();
		const first = await send(box, { to: [`ada.${box.slug}@example.org`], draft });
		const again = await send(box, { to: [`ada.${box.slug}@example.org`], draft });
		expect(again).toEqual(first);
		expect(await sentTo(`ada.${box.slug}@example.org`)).toHaveLength(1);
		expect((await thread(box, first.threadId)).count).toBe(1);

		// One that may have gone stays as it is, rather than going again.
		const lostTo = `lost-1@${box.slug}.example.org`;
		const lostDraft = crypto.randomUUID();
		const maybe = await send(box, { to: [lostTo], draft: lostDraft });
		expect(maybe.state).toBe("uncertain");
		expect(await send(box, { to: [lostTo], draft: lostDraft })).toEqual(maybe);
		expect(await sentTo(lostTo)).toEqual([]);
	});

	it("takes Email Service's own failure as maybe sent", async () => {
		const box = await mailboxWithAddress();
		const failed = await send(box, { to: ["refuse-E_INTERNAL_SERVER_ERROR@example.org"] });
		expect(failed).toMatchObject({ state: "uncertain", code: "E_INTERNAL_SERVER_ERROR" });
	});

	it("is discarded only by who wrote it, or an owner or admin", async () => {
		const box = await mailboxWithAddress();
		const writer = await join(box.workspaceId);
		const other = await join(box.workspaceId);
		await directory(box.slug, owner.headers, {
			action: "set-mailbox-access",
			mailboxId: box.mailboxId,
			everyone: true,
			memberIds: [],
		});
		const refused = await send(box, { to: ["refuse-E_DELIVERY_FAILED@example.org"] }, writer);
		expect(refused.state).toBe("refused");
		const discard = { action: "discard", message: refused.id };
		expect((await outbox(box, other, discard)).status).toBe(403);
		// Anyone who reads the mailbox may send it again, as it is the mailbox's mail.
		expect((await outbox(box, other, { action: "send-again", message: refused.id })).status).toBe(
			200,
		);
		expect((await outbox(box, writer, discard)).status).toBe(200);

		const another = await send(box, { to: ["refuse-E_DELIVERY_FAILED@example.org"] }, writer);
		expect((await outbox(box, owner, { action: "discard", message: another.id })).status).toBe(200);
	});

	it("waits hours when the account's daily quota is spent", async () => {
		const box = await mailboxWithAddress();
		const daily = await send(box, { to: ["daily-1@example.org"] });
		expect(daily).toMatchObject({ state: "waiting", code: "E_DAILY_LIMIT_EXCEEDED" });
		expect(daily.nextAt).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
		expect((await outbox(box, owner, { action: "discard", message: daily.id })).status).toBe(200);
	});
});

describe("who may send", () => {
	it("is a person who can read the mailbox, signed in, from this app", async () => {
		const box = await mailboxWithAddress();
		const recipient = `ada.${box.slug}@example.org`;
		const draft = { action: "send", to: [recipient], subject: "Hi", text: "Hi." };
		const member = await join(box.workspaceId);
		expect((await outbox(box, member, draft)).status).toBe(404);

		const reader = await join(box.workspaceId);
		await directory(box.slug, owner.headers, {
			action: "set-mailbox-access",
			mailboxId: box.mailboxId,
			everyone: false,
			memberIds: [reader.memberId],
		});
		const theirs = (await (await outbox(box, reader, draft)).json()) as Sent;
		expect(theirs.state).toBe("sent");
		expect((await thread(box, theirs.threadId)).messages[0]?.sent?.by).toBe(reader.name);

		// Not from another site, which a cookie would come along from.
		expect((await outbox(box, owner, draft, { origin: "https://elsewhere.test" })).status).toBe(
			403,
		);
		// Nor with an agent's key, given the mailbox or not: keys read and never send.
		const made = await mail.fetch(`${origin}/api/auth/agents/create`, {
			method: "POST",
			headers: { ...owner.headers, origin, "content-type": "application/json" },
			body: JSON.stringify({ organizationId: box.workspaceId, name: "Sorter" }),
		});
		const { agent, key } = (await made.json()) as { agent: { memberId: string }; key: string };
		await directory(box.slug, owner.headers, {
			action: "set-mailbox-access",
			mailboxId: box.mailboxId,
			everyone: false,
			memberIds: [reader.memberId, agent.memberId],
		});
		const agentAsks = await outbox(box, { headers: { authorization: `Bearer ${key}` } }, draft);
		expect(agentAsks.status).toBe(404);
		expect(await sentTo(recipient)).toHaveLength(1);
	});

	it("sends only from the mailbox's own addresses on a proved domain", async () => {
		const box = await mailboxWithAddress();
		const recipient = `ada.${box.slug}@example.org`;
		const elsewhere = await outbox(box, owner, {
			action: "send",
			to: [recipient],
			subject: "Hi",
			text: "Hi.",
			from: `ceo@${box.domain}`,
		});
		expect(elsewhere.status).toBe(400);
		await directory(box.slug, owner.headers, { action: "add-mailbox", name: "No address" });
		const bare = (await directory(box.slug, owner.headers)).mailboxes.find(
			(one) => one.name === "No address",
		);
		const fromBare = await outbox({ ...box, mailboxId: bare?.id ?? "" }, owner, {
			action: "send",
			to: [recipient],
			subject: "Hi",
			text: "Hi.",
		});
		expect(fromBare.status).toBe(409);
		// Once another workspace proves the domain, this one no longer sends from it.
		await mail.db
			.prepare("UPDATE mail_domain SET verified_at = NULL WHERE id = ?")
			.bind(box.domainId)
			.run();
		const unproved = await outbox(box, owner, {
			action: "send",
			to: [recipient],
			subject: "Hi",
			text: "Hi.",
		});
		expect(unproved.status).toBe(409);
		expect(await sentTo(recipient)).toEqual([]);
	});

	it("doesn't send from an address that has run out", async () => {
		const box = await mailboxWithAddress();
		await mail.db
			.prepare("UPDATE mail_address SET expires_at = ? WHERE mailbox_id = ?")
			.bind(Date.now() - 1000, box.mailboxId)
			.run();
		const response = await outbox(box, owner, {
			action: "send",
			to: [`ada.${box.slug}@example.org`],
			subject: "Hi",
			text: "Hi.",
		});
		expect(response.status).toBe(409);
	});
});

describe("what is written", () => {
	it("is checked before anything is sent", async () => {
		const box = await mailboxWithAddress();
		const many = Array.from({ length: 21 }, (_, i) => `person${i}@example.org`);
		const wrong = [
			{ to: [] },
			{ to: many },
			{ to: many.slice(0, 15), cc: many.slice(15) },
			{ to: ["ada@example.org"], cc: ["ADA@example.org"] },
			{ to: ["ada@example.org\r\nBcc: eve@example.org"] },
			{ to: ["not an address"] },
			{ to: ["ada@example.org"], subject: "Hi\r\nBcc: eve@example.org" },
			{ to: ["ada@example.org"], subject: " " },
			{ to: ["ada@example.org"], text: "  \n " },
			{ to: ["ada@example.org"], text: "x".repeat(100_001) },
			{ to: ["ada@example.org"], draft: "not-a-uuid" },
			{ to: ["ada@example.org"], draft: undefined },
			{ to: ["ada@<example.org>"] },
			{ to: ['"ada"@example.org'] },
			{ to: ["ada..lovelace@example.org"] },
			{ to: [".ada@example.org"] },
		];
		for (const draft of wrong) {
			const response = await outbox(box, owner, {
				action: "send",
				subject: "Hi",
				text: "Hi.",
				...draft,
			});
			expect(response.status).toBe(400);
		}
		expect(await mail.emails()).not.toContainEqual(
			expect.objectContaining({ from: expect.objectContaining({ email: box.address }) }),
		);
	});

	it("goes to an internationalised domain", async () => {
		const box = await mailboxWithAddress();
		const sent = await send(box, { to: ["someone@example.xn--p1ai"] });
		expect(sent.state).toBe("sent");
	});

	it("is sent at most so many times a day from one workspace", async () => {
		const box = await mailboxWithAddress();
		const draft = crypto.randomUUID();
		const first = await send(box, { to: ["daily0@example.org"], draft });
		for (let i = 1; i < SEND_PER_DAY; i++) {
			expect((await send(box, { to: [`daily${i}@example.org`] })).state).toBe("sent");
		}
		const over = await outbox(box, owner, {
			action: "send",
			to: ["one-more@example.org"],
			subject: "Hi",
			text: "Hi.",
		});
		expect(over.status).toBe(429);
		expect(((await over.json()) as { error: string }).error).toMatch(/Try again in about/);
		// A draft sent before, whose answer was lost, isn't another message: it says what became of it.
		expect(await send(box, { to: ["daily0@example.org"], draft })).toEqual(first);
		// Another workspace has its own.
		const other = await mailboxWithAddress();
		expect((await send(other, { to: ["one-more@example.org"] })).state).toBe("sent");
	});
});
