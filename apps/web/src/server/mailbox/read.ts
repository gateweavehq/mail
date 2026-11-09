import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import PostalMime from "postal-mime";
import type { Delivery } from "../../lib/delivery";
import type {
	ListedMessage,
	MailboxPage,
	MessageCursor,
	OpenedMessage,
	Person,
	ThreadCursor,
	ThreadPage,
	ThreadsPage,
} from "../../lib/mailbox";
import { MAX_QUERY_SENT } from "../../lib/mailbox";
import type { SendStatus } from "../../lib/outbox";
import { canReadMailbox, isAdminRole } from "../../lib/roles";
import { type Caller, currentCaller, currentMember } from "../access";
import { noteAgent } from "../agent-log";
import { db } from "../auth";
import { schema } from "../db";
import { appOrigin } from "../origin";
import { replySubject } from "./compose";
import type { StoredSummary } from "./durable-object";
import { cleanHtml, framePolicy, MAX_SHOWN_HTML, mayLoadImages } from "./html";
import { mailboxStub } from "./index";
import { decoded, people, sender } from "./people";
import { envelopeAddresses, replySender, senderAddresses } from "./senders";
import { textOfHtml } from "./text";
import { threadSubject } from "./thread";

/** Messages or threads on one page of a mailbox. */
export const PAGE_SIZE = 50;

/** How many of the messages waiting for approval a mailbox's page names. */
export const AWAITING_SHOWN = 10;

/** The most text a message's page shows, in characters. */
export const MAX_SHOWN_TEXT = 200_000;

/**
 * The mailbox with this id in the workspace with this slug, for a member who may read it (see
 * `canReadMailbox`), signed in or an agent with its key. Every route to a mailbox's mail comes
 * through here. Null for anyone else, and for a mailbox of another workspace, so its id gives
 * nothing away. With `people`, only for someone signed in: what a key may not do, such as sending.
 */
export async function openMailbox(slug: string, mailboxId: string, { people = false } = {}) {
	const member = people ? await signedIn(slug) : await currentCaller(slug);
	if (!member) return null;
	const { memberId, workspaceId, role } = member.membership;
	const { mailbox, mailboxAccess } = schema;
	const box = await db
		.select({
			id: mailbox.id,
			name: mailbox.name,
			everyone: mailbox.everyone,
			granted: mailboxAccess.memberId,
			send: mailboxAccess.send,
		})
		.from(mailbox)
		.leftJoin(
			mailboxAccess,
			and(eq(mailboxAccess.mailboxId, mailbox.id), eq(mailboxAccess.memberId, memberId)),
		)
		.where(and(eq(mailbox.id, mailboxId), eq(mailbox.organizationId, workspaceId)))
		.get();
	if (!box || !canReadMailbox(role, { everyone: box.everyone, granted: box.granted !== null })) {
		return null;
	}
	// Only an agent's grant says whether it may send; a person who reads a mailbox may anyway.
	return {
		id: box.id,
		name: box.name,
		member,
		agentMaySend: box.send === true,
		stub: mailboxStub(box.id),
	};
}

/** The member signed in, as a caller. */
async function signedIn(slug: string): Promise<Caller | null> {
	const member = await currentMember(slug);
	return member && { userId: member.user.id, membership: member.membership, keyed: false };
}

/** An open mailbox, as `openMailbox` gives it. */
type OpenMailbox = NonNullable<Awaited<ReturnType<typeof openMailbox>>>;

/**
 * The names of those who sent these messages from the mailbox, or approved them, by membership,
 * while they are in the workspace. Someone who has left is no longer named.
 */
export async function senderNames(
	workspaceId: string,
	rows: { sentBy: string | null; approvedBy?: string | null }[],
): Promise<Map<string, string>> {
	const ids = [
		...new Set(
			rows.flatMap((row) => [row.sentBy, row.approvedBy ?? null]).filter((id) => id !== null),
		),
	];
	if (ids.length === 0) return new Map();
	const { member, user } = schema;
	const found = await db
		.select({ id: member.id, name: user.name })
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(and(eq(member.organizationId, workspaceId), inArray(member.id, ids)))
		.all();
	return new Map(found.map((one) => [one.id, one.name]));
}

/**
 * For a message the mailbox sent, who sent it and what became of it, and whether the caller, `me`,
 * wrote it.
 */
function sentOf(row: StoredSummary, names: Map<string, string>, me: string) {
	if (row.sentBy === null) return null;
	return {
		by: names.get(row.sentBy) ?? null,
		mine: row.sentBy === me,
		status: row.sending === null ? null : (JSON.parse(row.sending) as SendStatus),
		approval: row.approvedBy === null ? null : { by: names.get(row.approvedBy) ?? null },
		// An object still on the code before delivery events, during a deploy, has neither.
		deliveries: row.deliveries ? (JSON.parse(row.deliveries) as Delivery[]) : [],
		recipients: row.recipients ?? 0,
	};
}

export async function listMessages(
	slug: string,
	mailboxId: string,
	before: MessageCursor | null,
): Promise<MailboxPage | null> {
	const box = await openMailbox(slug, mailboxId);
	if (!box) return null;
	// One more than a page says whether there is another.
	const rows = await box.stub.list(before, PAGE_SIZE + 1);
	const shown = rows.slice(0, PAGE_SIZE);
	const last = shown.at(-1);
	const names = await senderNames(box.member.membership.workspaceId, shown);
	return {
		name: box.name,
		messages: shown.map((row) => listed(row, names, box.member.membership.memberId)),
		next: rows.length > PAGE_SIZE && last ? { arrivedAt: last.arrivedAt, id: last.id } : null,
	};
}

export function listed(row: StoredSummary, names: Map<string, string>, me: string): ListedMessage {
	return {
		id: row.id,
		threadId: row.threadId,
		arrivedAt: row.arrivedAt,
		from: sender(row.from),
		subject: decoded(row.subject),
		verifiedDomain: row.verifiedDomain,
		size: row.size,
		cameTo: row.sentBy === null ? envelopeRecipients(row.envelopeTo) : [],
		sent: sentOf(row, names, me),
	};
}

/**
 * The addresses an envelope went to, lower case. An object still on the code before listings had
 * them, during a deploy, gives none.
 */
export const envelopeRecipients = (envelopeTo: string | undefined) =>
	(envelopeTo ?? "")
		.split(",")
		.map((address) => address.trim().toLowerCase())
		.filter(Boolean);

/** Who wrote in a thread, each address once. */
function senders(froms: (string | null)[]): Person[] {
	const found: Person[] = [];
	for (const from of froms) {
		const person = sender(from);
		if (!person) continue;
		const same = found.some((one) =>
			person.address ? one.address === person.address : one.name === person.name,
		);
		if (!same) found.push(person);
	}
	return found;
}

/**
 * A page of a mailbox's threads, the one with the newest message first. With a query, only the
 * threads with a message that has every word of it.
 */
export async function listThreads(
	slug: string,
	mailboxId: string,
	before: ThreadCursor | null,
	query: string | null = null,
): Promise<ThreadsPage | null> {
	const box = await openMailbox(slug, mailboxId);
	if (!box) return null;
	const first = before === null && !query;
	const [rows, from, held] = await Promise.all([
		query ? box.stub.search(query, before, PAGE_SIZE + 1) : box.stub.threads(before, PAGE_SIZE + 1),
		senderAddresses(box.member.membership.workspaceId, box.id),
		first ? box.stub.awaiting(AWAITING_SHOWN) : null,
	]);
	const shown = rows.slice(0, PAGE_SIZE);
	const last = shown.at(-1);
	const names = held ? await senderNames(box.member.membership.workspaceId, held.messages) : null;
	return {
		name: box.name,
		from,
		awaiting:
			held && names
				? {
						count: held.count,
						messages: held.messages.map((row) => ({
							id: row.id,
							threadId: row.threadId,
							subject: threadSubject(decoded(row.subject)),
							by: row.sentBy === null ? null : (names.get(row.sentBy) ?? null),
							arrivedAt: row.arrivedAt,
						})),
					}
				: null,
		threads: shown.map((row) => ({
			id: row.id,
			latestAt: row.latestAt,
			count: row.count,
			subject: threadSubject(decoded(row.subject)),
			senders: senders(row.senders),
			latestVerifiedDomain: row.latestVerifiedDomain,
		})),
		next: rows.length > PAGE_SIZE && last ? { latestAt: last.latestAt, id: last.id } : null,
	};
}

/**
 * A page of a thread's messages, the newest page first, with its newest opened, as the thread's
 * page shows them.
 */
export async function openThread(
	slug: string,
	mailboxId: string,
	threadId: string,
	before: MessageCursor | null,
): Promise<ThreadPage | null> {
	const box = await openMailbox(slug, mailboxId);
	if (!box) return null;
	const thread = await box.stub.thread(threadId, before, PAGE_SIZE + 1);
	if (!thread) return null;
	const shown = thread.messages.slice(0, PAGE_SIZE);
	const [newest] = shown;
	const oldest = shown.at(-1);
	const { workspaceId } = box.member.membership;
	const [names, from] = await Promise.all([
		senderNames(workspaceId, shown),
		senderAddresses(workspaceId, box.id),
	]);
	return {
		mailbox: box.name,
		from,
		subject: threadSubject(decoded(thread.subject)),
		count: thread.count,
		messages: shown.map((row) => listed(row, names, box.member.membership.memberId)).reverse(),
		older:
			thread.messages.length > PAGE_SIZE && oldest
				? { arrivedAt: oldest.arrivedAt, id: oldest.id }
				: null,
		latest: newest ? await readMessage(box, newest.id, from) : null,
	};
}

/**
 * One message, parsed here and not when it arrived, since `email()` has too little CPU for it.
 * Its HTML is only said to be there: it has a page of its own, for a sandboxed frame.
 */
export async function openMessage(
	slug: string,
	mailboxId: string,
	messageId: string,
	reading: MessageReading | null = "message.read",
): Promise<OpenedMessage | null> {
	const box = await openMailbox(slug, mailboxId);
	return box ? readMessage(box, messageId, undefined, reading) : null;
}

/**
 * What an agent opens a message for, as its log says: all of it, or only a code in it. Where null
 * is taken instead, the agent isn't given it, as when Mail opens it to address a reply.
 */
export type MessageReading = "message.read" | "code.read";

/** Notes in the agent's log that it read a message, when the caller is an agent with its key. */
async function noteRead(
	box: OpenMailbox,
	row: { id: string; threadId: string; subject: string | null },
	reading: MessageReading | null,
) {
	if (!box.member.keyed || reading === null) return;
	const { workspaceId, memberId } = box.member.membership;
	await noteAgent(db, {
		workspaceId,
		agentMemberId: memberId,
		by: "agent",
		action: reading,
		mailboxId: box.id,
		targetId: row.id,
		threadId: row.threadId,
		subject: decoded(row.subject),
	});
}

/**
 * Reads and parses a message of a mailbox the caller may read. `from` is what the mailbox may send
 * from, when the caller has it already.
 */
async function readMessage(
	box: OpenMailbox,
	messageId: string,
	from?: string[],
	reading: MessageReading | null = "message.read",
): Promise<OpenedMessage | null> {
	const row = await box.stub.get(messageId);
	if (!row) return null;
	const object = await env.RAW_MAIL.get(row.object);
	if (!object) return null;
	await noteRead(box, row, reading);
	const email = await PostalMime.parse(object.body);
	const fromHtml = email.text === undefined && email.html ? await textOfHtml(email.html) : null;
	const text = fromHtml?.text ?? email.text ?? "";
	const { workspaceId, memberId } = box.member.membership;
	const sent = sentOf(row, await senderNames(workspaceId, [row]), memberId);
	const to = people(email.to);
	const cc = people(email.cc);
	// A reply goes where the message asks, or to whoever wrote it. One to a message the mailbox
	// sent goes to those it went to, as another word to them.
	const answerTo = sent
		? to
		: people(email.replyTo).length > 0
			? people(email.replyTo)
			: people(email.from ? [email.from] : []);
	return {
		id: row.id,
		threadId: row.threadId,
		arrivedAt: row.arrivedAt,
		size: row.size,
		// The headers the listing kept are the first of each, which is what the page shows too.
		from: sender(row.from),
		to,
		cc,
		subject: decoded(row.subject),
		date: row.date,
		verifiedDomain: row.verifiedDomain,
		dmarc: row.dmarc,
		text: text.slice(0, MAX_SHOWN_TEXT),
		textCut: text.length > MAX_SHOWN_TEXT || Boolean(fromHtml?.cut),
		hasHtml: Boolean(email.html),
		remoteImages: email.html ? mayLoadImages(email.html) : false,
		htmlCut: (email.html?.length ?? 0) > MAX_SHOWN_HTML,
		attachments: email.attachments.map((attachment) => ({
			name: attachment.filename,
			type: attachment.mimeType,
			size:
				typeof attachment.content === "string"
					? attachment.content.length
					: attachment.content.byteLength,
		})),
		sent,
		reply: {
			to: answerTo.map((person) => person.address).filter(Boolean),
			cc: sent ? cc.map((person) => person.address).filter(Boolean) : [],
			subject: replySubject(decoded(row.subject)),
			from: replySender(
				envelopeAddresses(row),
				from ?? (await senderAddresses(box.member.membership.workspaceId, box.id)),
			),
		},
	};
}

const notFound = () =>
	new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });

/** A message's raw mail, or null for anyone who can't see it. */
async function storedMail(slug: string, mailboxId: string, messageId: string) {
	const box = await openMailbox(slug, mailboxId);
	if (!box) return null;
	const row = await box.stub.get(messageId);
	if (!row) return null;
	const object = await env.RAW_MAIL.get(row.object);
	if (object) await noteRead(box, row, "message.read");
	return object;
}

/** The raw mail, as a download, or a 404 for anyone who can't see it. */
export async function originalMessage(
	slug: string,
	mailboxId: string,
	messageId: string,
): Promise<Response> {
	const object = await storedMail(slug, mailboxId, messageId);
	if (!object) return notFound();
	return new Response(object.body, {
		headers: {
			"content-type": "message/rfc822",
			"content-length": String(object.size),
			// Never shown in the browser: a message can hold anything.
			"content-disposition": 'attachment; filename="message.eml"',
			"cache-control": "private, no-store",
		},
	});
}

/**
 * A message's HTML, cleaned, as a page for the sandboxed frame in its page, or a 404 for anyone who
 * can't see it and for a message without HTML. Remote images load only with `images=1`.
 */
export async function messageHtml(
	slug: string,
	mailboxId: string,
	messageId: string,
	url: URL,
): Promise<Response> {
	const object = await storedMail(slug, mailboxId, messageId);
	if (!object) return notFound();
	// Attachments stay bytes: only the inline images the HTML names are made text, as needed.
	const email = await PostalMime.parse(object.body);
	if (!email.html) return notFound();
	const images = url.searchParams.get("images") === "1";
	return new Response(await cleanHtml(email.html, email.attachments, { images }), {
		headers: {
			"content-type": "text/html; charset=utf-8",
			// Its own policy, so the app's, which allows its scripts, never applies to it.
			"content-security-policy": framePolicy({ images }),
			"cache-control": "private, no-store",
			// The frame's address names the workspace, mailbox and message.
			"referrer-policy": "no-referrer",
			"cross-origin-resource-policy": "same-origin",
			// Looking up a link's host would tell the sender's name server the message was opened.
			"x-dns-prefetch-control": "off",
		},
	});
}

function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** The same whether the mailbox doesn't exist or the caller can't see it. */
const notFoundJson = () => answer({ ok: false, error: "Not found" }, 404);

/** Where a page starts, from `beforeAt` and `beforeId` in a URL, or null for the first. */
function messageCursor(url: URL): MessageCursor | null {
	const at = Number(url.searchParams.get("beforeAt"));
	const id = url.searchParams.get("beforeId");
	return id && Number.isSafeInteger(at) && at >= 0 && id.length <= 100
		? { arrivedAt: at, id }
		: null;
}

/** A page of a mailbox, for `GET /api/mail/<workspace>/<mailbox>`. */
export async function mailboxAnswer(slug: string, mailboxId: string, url: URL): Promise<Response> {
	const page = await listMessages(slug, mailboxId, messageCursor(url));
	return page ? answer(page) : notFoundJson();
}

/**
 * A page of a mailbox's threads, for `GET /api/mail/<workspace>/<mailbox>/threads`, or of those
 * that `q` finds.
 */
export async function threadsAnswer(slug: string, mailboxId: string, url: URL): Promise<Response> {
	const at = Number(url.searchParams.get("beforeAt"));
	const id = url.searchParams.get("beforeId");
	const before =
		id && Number.isSafeInteger(at) && at >= 0 && id.length <= 100 ? { latestAt: at, id } : null;
	const query = url.searchParams.get("q")?.slice(0, MAX_QUERY_SENT) || null;
	const page = await listThreads(slug, mailboxId, before, query);
	return page ? answer(page) : notFoundJson();
}

/** A page of a thread, for `GET /api/mail/<workspace>/<mailbox>/threads/<thread>`. */
export async function threadAnswer(
	slug: string,
	mailboxId: string,
	threadId: string,
	url: URL,
): Promise<Response> {
	const thread = await openThread(slug, mailboxId, threadId, messageCursor(url));
	return thread ? answer(thread) : notFoundJson();
}

/** One message, for `GET /api/mail/<workspace>/<mailbox>/<message>`. */
export async function messageAnswer(
	slug: string,
	mailboxId: string,
	messageId: string,
): Promise<Response> {
	const message = await openMessage(slug, mailboxId, messageId);
	return message ? answer(message) : notFoundJson();
}

/**
 * Deletes a message, for `DELETE /api/mail/<workspace>/<mailbox>/<message>`. Only an owner or
 * admin may, as it can't be undone; it frees the message's space in the mailbox.
 */
export async function deleteMessageAnswer(
	request: Request,
	slug: string,
	mailboxId: string,
	messageId: string,
): Promise<Response> {
	// A session cookie comes along wherever a request is from, so ask where that is.
	if (request.headers.get("origin") !== appOrigin()) {
		return answer({ ok: false, error: "Not allowed from there" }, 403);
	}
	const box = await openMailbox(slug, mailboxId);
	if (!box) return notFoundJson();
	if (!isAdminRole(box.member.membership.role)) {
		return answer({ ok: false, error: "Only an owner or admin can delete mail." }, 403);
	}
	return (await box.stub.remove(messageId, box.member.membership.memberId))
		? answer({ ok: true })
		: notFoundJson();
}
