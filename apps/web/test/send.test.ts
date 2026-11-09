import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isOwnId } from "../src/server/mailbox/own-id";
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
		sent: {
			by: string | null;
			status: Status | null;
			approval: { by: string | null } | null;
		} | null;
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
		mailboxes: { id: string; name: string; access?: { senderIds: string[] } | null }[];
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

/** An agent of the workspace, with its key, as its owner makes it in settings. */
async function makeAgent(box: Box, name = "Sorter") {
	const response = await auth("/agents/create", { organizationId: box.workspaceId, name });
	expect(response.status).toBe(200);
	const { agent, key } = (await response.json()) as {
		agent: { id: string; memberId: string };
		key: string;
	};
	return { ...agent, name, headers: { authorization: `Bearer ${key}` } };
}

type Agent = Awaited<ReturnType<typeof makeAgent>>;

/** Asks Better Auth's agents plugin, as the owner unless someone else asks. */
function auth(path: string, body: unknown, person: Asker = owner) {
	return mail.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: { ...person.headers, origin, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Gives the mailbox to these, and lets these agents among them send from it. */
async function letSend(box: Box, memberIds: string[], senderIds: string[]) {
	return mail.fetch(`${origin}/api/directory/${box.slug}`, {
		method: "POST",
		headers: { ...owner.headers, origin, "content-type": "application/json" },
		body: JSON.stringify({
			action: "set-mailbox-access",
			mailboxId: box.mailboxId,
			everyone: false,
			memberIds,
			senderIds,
		}),
	});
}

/** An agent's message, as it sends it with its key: the same route, from no page. */
async function agentSends(box: Box, agent: Agent, to: string[], cc: string[] = []) {
	const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
		method: "POST",
		headers: { ...agent.headers, "content-type": "application/json" },
		body: JSON.stringify({
			action: "send",
			draft: crypto.randomUUID(),
			to,
			cc,
			subject: `Update ${++counter}`,
			text: "Your order shipped.",
		}),
	});
	return response;
}

/** What waits for approval in the mailbox, as its page lists it. */
async function awaiting(box: Box, person: Asker = owner) {
	const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads`, {
		headers: person.headers,
	});
	expect(response.status).toBe(200);
	return (
		(await response.json()) as {
			awaiting: {
				count: number;
				messages: { id: string; threadId: string; subject: string; by: string | null }[];
			} | null;
		}
	).awaiting;
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
			new RegExp(
				`^<zero@example\\.org> <first@example\\.org> <[0-9a-f-]{36}[.][A-Za-z0-9_-]{22}@${box.domain}>$`,
			),
		);

		const after = await thread(box, first.threadId);
		expect(after.count).toBe(2);
		expect(after.messages.at(-1)).toMatchObject({
			id: sent.id,
			from: { name: box.name, address: accounts },
			sent: { by: "Owner", status: { state: "sent", code: null, nextAt: null, detail: null } },
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

	it("still threads a reply to a message whose sealed mail doesn't open, by the id in its row", async () => {
		const box = await mailboxWithAddress();
		const first = await arrive(box, [
			"Subject: Locked",
			"Message-ID: <locked@example.org>",
			"References: <zero@example.org>",
		]);
		// Its mail no longer opens, as after the server's SECRETS_KEY changed.
		await mail.bucket.put(`${box.workspaceId}/${box.mailboxId}/${first.id}.eml`, "not it");
		const sent = await send(box, {
			to: ["locked@example.net"],
			subject: "Re: Locked",
			text: "Got it.",
			replyTo: first.id,
		});
		expect(sent).toMatchObject({ ok: true, threadId: first.threadId, state: "sent" });
		const [email] = await sentTo("locked@example.net");
		expect(email?.headers?.["In-Reply-To"]).toBe("<locked@example.org>");
		// Without the ids before it, which only its mail holds.
		expect(email?.headers?.References).toMatch(
			new RegExp(`^<locked@example\\.org> <[0-9a-f-]{36}[.][A-Za-z0-9_-]{22}@${box.domain}>$`),
		);
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
			new RegExp(`^<ok@example\\.org> <[0-9a-f-]{36}[.][A-Za-z0-9_-]{22}@${box.domain}>$`),
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
		expect(plain?.headers?.References).toMatch(
			new RegExp(`^<[0-9a-f-]{36}[.][A-Za-z0-9_-]{22}@${box.domain}>$`),
		);
	});

	it("to a message the mailbox wrote finds its thread, whatever Email Service called it", async () => {
		const box = await mailboxWithAddress();
		const sent = await send(box, { to: ["ada@example.org"], subject: "Your order" });
		const [email] = await sentTo("ada@example.org");
		const ours = email?.headers?.References;
		expect(ours).toMatch(new RegExp(`^<[0-9a-f-]{36}[.][A-Za-z0-9_-]{22}@${box.domain}>$`));
		// Signed for the mailbox that sent it, under the deployment's secret.
		expect(await isOwnId(mail.secret, box.mailboxId, ours ?? "")).toBe(true);
		expect(await isOwnId(mail.secret, crypto.randomUUID(), ours ?? "")).toBe(false);
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
		expect(shown).toEqual({
			state: "refused",
			code: "E_RECIPIENT_SUPPRESSED",
			nextAt: null,
			detail: null,
		});

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
		// Nor with the key of an agent not given the mailbox, or given it only to read.
		const agent = await makeAgent(box);
		expect((await outbox(box, agent, draft)).status).toBe(404);
		await directory(box.slug, owner.headers, {
			action: "set-mailbox-access",
			mailboxId: box.mailboxId,
			everyone: false,
			memberIds: [reader.memberId, agent.memberId],
		});
		expect((await outbox(box, agent, draft)).status).toBe(403);
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

/** Bytes in Base64, as a file comes in a request to send. */
const base64Of = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const pdf = base64Of(Array.from({ length: 2000 }, (_, i) => (i * 7) % 256));
const logo = base64Of([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
const filesHtml = '<p>The <b>report</b> is attached.</p><img src="cid:logo" alt="">';
const files = [
	{ filename: "report.pdf", content: pdf },
	{ filename: "logo.png", content: logo, contentId: "logo" },
];

/** A message of the mailbox, as its page opens it. */
async function opened(box: Box, id: string) {
	const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}`, {
		headers: owner.headers,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as {
		text: string;
		hasHtml: boolean;
		attachments: { name: string | null; type: string; size: number }[];
	};
}

/** What Email Service was handed for this address, files first, as the copy has them. */
const handedFiles = [
	{
		filename: "logo.png",
		type: "image/png",
		disposition: "inline",
		contentId: "logo",
		content: logo,
	},
	{ filename: "report.pdf", type: "application/pdf", disposition: "attachment", content: pdf },
];

describe("HTML and files", () => {
	it("go to Email Service whole, from the copy the mailbox keeps of them", async () => {
		const box = await mailboxWithAddress();
		const to = `files.${box.slug}@example.org`;
		const sent = await send(box, {
			to: [to],
			subject: "The report",
			text: "The report is attached.",
			html: filesHtml,
			attachments: files,
		});
		expect(sent.state).toBe("sent");
		const [email, ...more] = await sentTo(to);
		expect(more).toEqual([]);
		expect(email).toMatchObject({
			subject: "The report",
			text: "The report is attached.",
			html: filesHtml,
			attachments: handedFiles,
		});
		// Its page reads it as it reads mail that arrived.
		const page = await opened(box, sent.id);
		expect(page.text.trim()).toBe("The report is attached.");
		expect(page.attachments).toEqual([
			{ name: "logo.png", type: "image/png", size: 11 },
			{ name: "report.pdf", type: "application/pdf", size: 2000 },
		]);
	});

	it("make the text from the HTML when none is written", async () => {
		const box = await mailboxWithAddress();
		const to = `html.${box.slug}@example.org`;
		await send(box, { to: [to], text: "", html: "<h1>Hello Ada</h1><p>Your order shipped.</p>" });
		const [email] = await sentTo(to);
		expect(email?.text).toMatch(/Hello Ada[\s\S]*Your order shipped\./);
		expect(email?.html).toBe("<h1>Hello Ada</h1><p>Your order shipped.</p>");
		expect(email).not.toHaveProperty("attachments");
	});

	it("are refused before anything goes or counts, when they can't go", async () => {
		const box = await mailboxWithAddress();
		const to = `refused.${box.slug}@example.org`;
		// Base64 of 3.5 MiB, three of which a request may carry but a message may not.
		const part = "A".repeat(4_893_016);
		const refused: [Record<string, unknown>, number, RegExp][] = [
			[{ attachments: [{ filename: "setup.exe", content: pdf }] }, 400, /\.exe files/],
			[{ attachments: [{ filename: "../report.pdf", content: pdf }] }, 400, /slash/],
			[{ attachments: [{ filename: "report.pdf", content: "%%%%" }] }, 400, /Base64/],
			[{ text: " ", html: "<img src=x>" }, 400, /nothing to send/],
			[
				{ attachments: [{ filename: "=?utf-8?B?ZXZpbC5leGU=?=", content: pdf }] },
				400,
				/encoded text/,
			],
			[
				{
					html: "<p>Hi</p>",
					attachments: [{ filename: "notes.txt", content: pdf, contentId: "notes" }],
				},
				400,
				/goes inline/,
			],
			[
				{
					attachments: ["a", "b", "c"].map((name) => ({
						filename: `${name}.bin`,
						content: part,
					})),
				},
				400,
				/10 MB together/,
			],
			[
				{ attachments: [{ filename: "big.bin", content: "A".repeat(16_000_004) }] },
				413,
				/too large/,
			],
		];
		for (const [draft, status, error] of refused) {
			const response = await outbox(box, owner, {
				action: "send",
				to: [to],
				subject: "Hi",
				text: "Hi.",
				...draft,
			});
			expect(response.status).toBe(status);
			expect(((await response.json()) as { error: string }).error).toMatch(error);
		}
		expect(await sentTo(to)).toEqual([]);
		// None of them counted against the day.
		for (let i = 0; i < SEND_PER_DAY; i++) {
			expect((await send(box, { to: [`counted${i}.${box.slug}@example.org`] })).state).toBe("sent");
		}
	});

	it("wait with an agent's message for a person, who sees them before they go", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box);
		await letSend(box, [agent.memberId], [agent.memberId]);
		const to = `held.${box.slug}@example.org`;
		const written = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
			method: "POST",
			headers: { ...agent.headers, "content-type": "application/json" },
			body: JSON.stringify({
				action: "send",
				draft: crypto.randomUUID(),
				to: [to],
				subject: "Your report",
				html: filesHtml,
				attachments: files,
			}),
		});
		expect(written.status).toBe(200);
		const held = (await written.json()) as Sent;
		expect(held.state).toBe("held");
		expect((await opened(box, held.id)).attachments.map((file) => file.name)).toEqual([
			"logo.png",
			"report.pdf",
		]);
		expect(await sentTo(to)).toEqual([]);
		const approved = await outbox(box, owner, { action: "approve", message: held.id });
		expect(await approved.json()).toMatchObject({ ok: true, state: "sent" });
		const [email] = await sentTo(to);
		expect(email).toMatchObject({ html: filesHtml, attachments: handedFiles });
		expect(email?.text).toMatch(/report[\s\S]*attached/);
	});

	it("go as the page shows them: what it leaves out of the HTML doesn't go either", async () => {
		const box = await mailboxWithAddress();
		const to = `cleaned.${box.slug}@example.org`;
		const sent = await send(box, {
			to: [to],
			text: "",
			html: '<p>The report.</p><script>steal()</script><svg><text y="20">Wire 9,800 EUR today</text></svg><img src="cid:logo" alt=""><img src="https://example.net/a.png">',
			attachments: [{ filename: "logo.png", content: logo, contentId: "logo" }],
		});
		expect(sent.state).toBe("sent");
		const [email] = await sentTo(to);
		expect(email?.html).toBe(
			'<p>The report.</p><img src="cid:logo" alt=""><img src="https://example.net/a.png">',
		);
		expect(email?.text).toMatch(/The report\./);
		expect(email?.text).not.toMatch(/Wire|steal/);
	});

	it("carry a calendar byte for byte, as it was given", async () => {
		const box = await mailboxWithAddress();
		const to = `invite.${box.slug}@example.org`;
		const encode = (text: string) => [...new TextEncoder().encode(text)];
		// CRLF, as RFC 5545 has it, and a Latin-1 byte, which reading it as text would change.
		const invite = base64Of([
			...encode("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nSUMMARY:Caf"),
			0xe9,
			...encode("\r\nEND:VCALENDAR\r\n"),
		]);
		await send(box, {
			to: [to],
			text: "The invite.",
			attachments: [{ filename: "invite.ics", content: invite }],
		});
		const [email] = await sentTo(to);
		expect(email?.attachments).toEqual([
			{ filename: "invite.ics", type: "text/calendar", disposition: "attachment", content: invite },
		]);
	});

	it("go on every try, as after Email Service was busy", { timeout: 60_000 }, async () => {
		const box = await mailboxWithAddress();
		const to = `busy-1@${box.slug}.example.org`;
		const busy = await send(box, {
			to: [to],
			text: "The report is attached.",
			html: filesHtml,
			attachments: files,
		});
		expect(busy).toMatchObject({ state: "waiting", code: "E_RATE_LIMIT_EXCEEDED" });
		let state = busy.state;
		for (let waited = 0; state !== "sent" && waited < 45_000; waited += 1_000) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			state = (await thread(box, busy.threadId)).messages[0]?.sent?.status?.state ?? "";
		}
		expect(state).toBe("sent");
		const [email, ...more] = await sentTo(to);
		expect(more).toEqual([]);
		expect(email).toMatchObject({ html: filesHtml, attachments: handedFiles });
	});

	it("don't go when the copy no longer holds them, and say why", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box);
		await letSend(box, [agent.memberId], [agent.memberId]);
		const to = `changed.${box.slug}@example.org`;
		const written = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
			method: "POST",
			headers: { ...agent.headers, "content-type": "application/json" },
			body: JSON.stringify({
				action: "send",
				draft: crypto.randomUUID(),
				to: [to],
				subject: "Your report",
				html: filesHtml,
				attachments: files,
			}),
		});
		const held = (await written.json()) as Sent;
		expect(held.state).toBe("held");
		const { objects } = await mail.bucket.list({ prefix: `${box.workspaceId}/${box.mailboxId}/` });
		const copy = objects.find((object) => object.key.endsWith(`/${held.id}.eml`));
		expect(copy).toBeDefined();
		// Its files gone from the copy, as a copy put back from elsewhere might have them.
		await mail.bucket.put(
			copy?.key ?? "",
			"From: x@example.org\r\nSubject: Your report\r\n\r\nNo files here.\r\n",
		);
		const approved = await outbox(box, owner, { action: "approve", message: held.id });
		expect(await approved.json()).toMatchObject({
			ok: true,
			state: "refused",
			code: "mail:copy_unread",
		});
		expect(await sentTo(to)).toEqual([]);
	});

	it("are an agent's HTML or its text, never both, so what is approved is what goes", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box);
		await letSend(box, [agent.memberId], [agent.memberId]);
		const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/outbox`, {
			method: "POST",
			headers: { ...agent.headers, "content-type": "application/json" },
			body: JSON.stringify({
				action: "send",
				draft: crypto.randomUUID(),
				to: [`both.${box.slug}@example.org`],
				subject: "Your report",
				text: "Wire the money to the account below.",
				html: "<p>Your report is attached.</p>",
			}),
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/not both/);
	});
});

describe("an agent", () => {
	it("sends only from a mailbox that lets it, and only agents are let", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box);
		const person = await join(box.workspaceId);
		const recipient = `ada.${box.slug}@example.org`;
		// Only someone given the mailbox can be let send from it.
		expect((await letSend(box, [], [agent.memberId])).status).toBe(400);
		expect((await letSend(box, [agent.memberId], [])).status).toBe(200);
		expect((await agentSends(box, agent, [recipient])).status).toBe(403);

		// A person who reads a mailbox sends anyway, so only the agent's grant says it may.
		expect(
			(await letSend(box, [agent.memberId, person.memberId], [agent.memberId, person.memberId]))
				.status,
		).toBe(200);
		const [seen] = (await directory(box.slug, owner.headers)).mailboxes;
		expect(seen?.access?.senderIds).toEqual([agent.memberId]);
		expect((await agentSends(box, agent, [recipient])).status).toBe(200);
		// Taking the mailbox away takes sending with it.
		expect((await letSend(box, [], [])).status).toBe(200);
		expect((await agentSends(box, agent, [recipient])).status).toBe(404);
	});

	it("waits for a person to approve what it writes, unless its policy lets it go", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box);
		const reader = await join(box.workspaceId);
		await letSend(box, [agent.memberId, reader.memberId], [agent.memberId]);
		const recipient = `ada.${box.slug}@example.org`;

		const written = await agentSends(box, agent, [recipient]);
		expect(written.status).toBe(200);
		const held = (await written.json()) as Sent;
		expect(held).toMatchObject({ state: "held", code: null, nextAt: null });
		expect(await sentTo(recipient)).toEqual([]);
		const [message] = (await thread(box, held.threadId)).messages;
		expect(message?.sent).toEqual({
			by: agent.name,
			mine: false,
			status: { state: "held", code: null, nextAt: null, detail: null },
			approval: null,
			deliveries: [],
			recipients: 1,
		});
		expect(await awaiting(box, reader)).toEqual({
			count: 1,
			messages: [expect.objectContaining({ id: held.id, threadId: held.threadId, by: agent.name })],
		});

		// The agent can't approve its own mail, nor do anything else to it.
		for (const action of ["approve", "discard", "send-again"]) {
			expect((await outbox(box, agent, { action, message: held.id })).status).toBe(403);
		}

		// Anyone who reads the mailbox can, and it is sent then, once.
		const approved = await outbox(box, reader, { action: "approve", message: held.id });
		expect(approved.status).toBe(200);
		expect(await approved.json()).toMatchObject({ ok: true, state: "sent" });
		expect(await sentTo(recipient)).toHaveLength(1);
		expect((await outbox(box, reader, { action: "approve", message: held.id })).status).toBe(409);
		expect(await sentTo(recipient)).toHaveLength(1);
		const [after] = (await thread(box, held.threadId)).messages;
		expect(after?.sent?.status?.state).toBe("sent");
		expect(after?.sent?.approval).toEqual({ by: reader.name });
		expect(await awaiting(box)).toEqual({ count: 0, messages: [] });

		// To whom its policy allows, it goes on its own, unless anyone else is on it too.
		const set = await auth("/agents/set-policy", {
			agentId: agent.id,
			sendPerDay: 20,
			allowed: [`@allowed-${box.slug}.example.org`, "Ops@Example.org"],
		});
		expect(set.status).toBe(200);
		const allowed = `someone@allowed-${box.slug}.example.org`;
		const alone = (await (
			await agentSends(box, agent, [allowed], ["ops@example.org"])
		).json()) as Sent;
		expect(alone.state).toBe("sent");
		expect((await thread(box, alone.threadId)).messages[0]?.sent?.approval).toBeNull();
		const mixed = (await (await agentSends(box, agent, [allowed], [recipient])).json()) as Sent;
		expect(mixed.state).toBe("held");
		const sub = (await (
			await agentSends(box, agent, [`a@mail.allowed-${box.slug}.example.org`])
		).json()) as Sent;
		expect(sub.state).toBe("held");
	});

	it("has what waits rejected by anyone who reads the mailbox, and nothing else of theirs", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box);
		const reader = await join(box.workspaceId);
		await letSend(box, [agent.memberId, reader.memberId], [agent.memberId]);
		// The stand-in refuses it, by its local part, and so never sends it.
		const recipient = "refuse-E_RECIPIENT_SUPPRESSED@example.org";
		const held = (await (await agentSends(box, agent, [recipient])).json()) as Sent;

		expect((await outbox(box, reader, { action: "discard", message: held.id })).status).toBe(200);
		expect((await outbox(box, reader, { action: "approve", message: held.id })).status).toBe(409);
		expect(await sentTo(recipient)).toEqual([]);

		// One that was approved and refused is no longer theirs to discard, as it isn't waiting.
		const again = (await (await agentSends(box, agent, [recipient])).json()) as Sent;
		const tried = await outbox(box, owner, { action: "approve", message: again.id });
		expect(await tried.json()).toMatchObject({ state: "refused" });
		expect((await outbox(box, reader, { action: "discard", message: again.id })).status).toBe(403);
		expect((await outbox(box, owner, { action: "discard", message: again.id })).status).toBe(200);
	});

	it("writes at most its policy's day, and the workspace's day counts what goes", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box);
		await letSend(box, [agent.memberId], [agent.memberId]);
		const more = SEND_PER_DAY + 1;
		expect(
			(await auth("/agents/set-policy", { agentId: agent.id, sendPerDay: more, allowed: [] }))
				.status,
		).toBe(200);
		// Waiting mail doesn't use the workspace's day, so the agent can write more than it sends.
		const held: Sent[] = [];
		for (let i = 0; i < more; i++) {
			const written = await agentSends(box, agent, [`day${i}.${box.slug}@example.org`]);
			expect(written.status).toBe(200);
			held.push((await written.json()) as Sent);
		}
		const over = await agentSends(box, agent, [`over.${box.slug}@example.org`]);
		expect(over.status).toBe(429);
		expect(((await over.json()) as { error: string }).error).toMatch(/^This agent has written/);

		// Approving counts against the workspace, as it goes, and only what waits.
		const unknown = crypto.randomUUID();
		for (let i = 0; i < 3; i++) {
			expect((await outbox(box, owner, { action: "approve", message: unknown })).status).toBe(409);
		}
		for (const message of held.slice(0, SEND_PER_DAY)) {
			const approved = await outbox(box, owner, { action: "approve", message: message.id });
			expect(approved.status).toBe(200);
		}
		const last = held.at(-1);
		const tooMany = await outbox(box, owner, { action: "approve", message: last?.id });
		expect(tooMany.status).toBe(429);
		expect(await awaiting(box)).toMatchObject({ count: 1 });

		// With none a day, it can't send at all.
		await auth("/agents/set-policy", { agentId: agent.id, sendPerDay: 0, allowed: [] });
		expect((await agentSends(box, agent, [`none.${box.slug}@example.org`])).status).toBe(403);
	});

	it("doesn't start its day again when its policy changes", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box);
		await letSend(box, [agent.memberId], [agent.memberId]);
		const policy = (sendPerDay: number) =>
			auth("/agents/set-policy", { agentId: agent.id, sendPerDay, allowed: [] });
		expect((await policy(3)).status).toBe(200);
		expect((await agentSends(box, agent, [`first.${box.slug}@example.org`])).status).toBe(200);
		// What it wrote at 3 a day is a third of its day, which is all of 1 a day.
		expect((await policy(1)).status).toBe(200);
		expect((await agentSends(box, agent, [`second.${box.slug}@example.org`])).status).toBe(429);
	});

	it("is only a key: a person given the agent's role by hand sends as people do", async () => {
		const box = await mailboxWithAddress();
		const person = await join(box.workspaceId, "agent");
		expect((await letSend(box, [person.memberId], [person.memberId])).status).toBe(200);
		const sent = await send(box, { to: [`ada.${box.slug}@example.org`] }, person);
		expect(sent.state).toBe("sent");
	});

	it("has its policy set only by an owner or admin, and only as it can be read", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box);
		const member = await join(box.workspaceId);
		const policy = { agentId: agent.id, sendPerDay: 5, allowed: ["@acme.test"] };
		expect((await auth("/agents/set-policy", policy, member)).status).not.toBe(200);
		expect((await auth("/agents/set-policy", policy, agent)).status).not.toBe(200);
		for (const wrong of [
			{ sendPerDay: -1 },
			{ sendPerDay: 1001 },
			{ allowed: ["acme.test"] },
			{ allowed: ["@*.acme.test"] },
			{ allowed: Array.from({ length: 101 }, (_, i) => `a${i}@acme.test`) },
		]) {
			expect((await auth("/agents/set-policy", { ...policy, ...wrong })).status).toBe(400);
		}
		const saved = await auth("/agents/set-policy", {
			...policy,
			allowed: ["@Acme.test", "b@acme.test", "@acme.test"],
		});
		expect(await saved.json()).toEqual({
			id: agent.id,
			policy: { sendPerDay: 5, allowed: ["@acme.test", "b@acme.test"] },
		});
		const listed = await mail.fetch(
			`${origin}/api/auth/agents/list?organizationId=${box.workspaceId}`,
			{ headers: owner.headers },
		);
		expect(await listed.json()).toEqual([
			expect.objectContaining({
				id: agent.id,
				policy: { sendPerDay: 5, allowed: ["@acme.test", "b@acme.test"] },
			}),
		]);
	});
});
