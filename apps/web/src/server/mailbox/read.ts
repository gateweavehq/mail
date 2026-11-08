import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import PostalMime, { type Address, addressParser, decodeWords } from "postal-mime";
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
import { isAdminRole } from "../../lib/roles";
import { currentMember } from "../access";
import { db } from "../auth";
import { schema } from "../db";
import { appOrigin } from "../origin";
import type { StoredSummary } from "./durable-object";
import { mailboxStub } from "./index";
import { textOfHtml } from "./text";
import { threadSubject } from "./thread";

/** Messages or threads on one page of a mailbox. */
export const PAGE_SIZE = 50;

/** The most text a message's page shows, in characters. */
export const MAX_SHOWN_TEXT = 200_000;

/**
 * The mailbox with this id in the workspace with this slug, for a member of it. Every member of a
 * workspace can read its mailboxes for now. Null for anyone else, and for a mailbox of another
 * workspace, so its id gives nothing away.
 */
async function openMailbox(slug: string, mailboxId: string) {
	const member = await currentMember(slug);
	if (!member) return null;
	const box = await db
		.select({ id: schema.mailbox.id, name: schema.mailbox.name })
		.from(schema.mailbox)
		.where(
			and(
				eq(schema.mailbox.id, mailboxId),
				eq(schema.mailbox.organizationId, member.membership.workspaceId),
			),
		)
		.get();
	return box ? { ...box, member, stub: mailboxStub(box.id) } : null;
}

/** A header as people read it. A word that won't decode is left as sent. */
function decoded(value: string | null): string {
	if (!value) return "";
	try {
		return decodeWords(value);
	} catch {
		return value;
	}
}

function people(addresses: Address[] | undefined): Person[] {
	const found: Person[] = [];
	for (const address of addresses ?? []) {
		if (address.group) found.push(...address.group);
		else found.push({ name: address.name, address: address.address });
	}
	return found;
}

/** The first person a From header names. */
function sender(value: string | null): Person | null {
	if (!value) return null;
	try {
		return people(addressParser(value))[0] ?? null;
	} catch {
		return { name: decoded(value), address: "" };
	}
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
	return {
		name: box.name,
		messages: shown.map(listed),
		next: rows.length > PAGE_SIZE && last ? { arrivedAt: last.arrivedAt, id: last.id } : null,
	};
}

function listed(row: StoredSummary): ListedMessage {
	return {
		id: row.id,
		threadId: row.threadId,
		arrivedAt: row.arrivedAt,
		from: sender(row.from),
		subject: decoded(row.subject),
		verifiedDomain: row.verifiedDomain,
		size: row.size,
	};
}

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
	const rows = query
		? await box.stub.search(query, before, PAGE_SIZE + 1)
		: await box.stub.threads(before, PAGE_SIZE + 1);
	const shown = rows.slice(0, PAGE_SIZE);
	const last = shown.at(-1);
	return {
		name: box.name,
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
	return {
		mailbox: box.name,
		subject: threadSubject(decoded(thread.subject)),
		count: thread.count,
		messages: shown.map(listed).reverse(),
		older:
			thread.messages.length > PAGE_SIZE && oldest
				? { arrivedAt: oldest.arrivedAt, id: oldest.id }
				: null,
		latest: newest ? await readMessage(box.stub, newest.id) : null,
	};
}

/**
 * One message, parsed here and not when it arrived, since `email()` has too little CPU for it.
 * Only its text is shown. HTML waits until it can be shown without running what it holds.
 */
export async function openMessage(
	slug: string,
	mailboxId: string,
	messageId: string,
): Promise<OpenedMessage | null> {
	const box = await openMailbox(slug, mailboxId);
	return box ? readMessage(box.stub, messageId) : null;
}

/** Reads and parses a message of a mailbox the caller may read. */
async function readMessage(
	stub: ReturnType<typeof mailboxStub>,
	messageId: string,
): Promise<OpenedMessage | null> {
	const row = await stub.get(messageId);
	if (!row) return null;
	const object = await env.RAW_MAIL.get(row.object);
	if (!object) return null;
	const email = await PostalMime.parse(object.body);
	const fromHtml = email.text === undefined && email.html ? await textOfHtml(email.html) : null;
	const text = fromHtml?.text ?? email.text ?? "";
	return {
		id: row.id,
		threadId: row.threadId,
		arrivedAt: row.arrivedAt,
		size: row.size,
		// The headers the listing kept are the first of each, which is what the page shows too.
		from: sender(row.from),
		to: people(email.to),
		cc: people(email.cc),
		subject: decoded(row.subject),
		date: row.date,
		verifiedDomain: row.verifiedDomain,
		dmarc: row.dmarc,
		text: text.slice(0, MAX_SHOWN_TEXT),
		textCut: text.length > MAX_SHOWN_TEXT || Boolean(fromHtml?.cut),
		hasHtml: Boolean(email.html),
		attachments: email.attachments.map((attachment) => ({
			name: attachment.filename,
			type: attachment.mimeType,
			size:
				typeof attachment.content === "string"
					? attachment.content.length
					: attachment.content.byteLength,
		})),
	};
}

/** The raw mail, as a download, or a 404 for anyone who can't see it. */
export async function originalMessage(
	slug: string,
	mailboxId: string,
	messageId: string,
): Promise<Response> {
	const notFound = () =>
		new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });
	const box = await openMailbox(slug, mailboxId);
	if (!box) return notFound();
	const row = await box.stub.get(messageId);
	if (!row) return notFound();
	const object = await env.RAW_MAIL.get(row.object);
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
	return (await box.stub.remove(messageId)) ? answer({ ok: true }) : notFoundJson();
}
