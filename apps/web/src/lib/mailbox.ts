import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SendStatus } from "./outbox";

/** Someone named in a message's headers. The name is decoded; either part may be empty. */
export interface Person {
	name: string;
	address: string;
}

export interface ListedMessage {
	id: string;
	/** The thread it is in. */
	threadId: string;
	arrivedAt: number;
	from: Person | null;
	subject: string;
	/**
	 * The domain of the From's address, when Cloudflare's DMARC check proved that domain sent it.
	 * The name in front of the address proves nothing, so this is what to show beside the proof.
	 */
	verifiedDomain: string | null;
	size: number;
	/** For a message this mailbox sent, rather than one it got. */
	sent: SentInfo | null;
}

/** Who sent a message from the mailbox, and what became of it. */
export interface SentInfo {
	/** Their name, while they are in the workspace. */
	by: string | null;
	/** Whether whoever reads it wrote it. */
	mine: boolean;
	status: SendStatus | null;
	/** For one that waited for approval, who approved it, named while they are in the workspace. */
	approval: { by: string | null } | null;
}

/** A message an agent wrote that waits for a person to approve it. */
export interface AwaitingMessage {
	id: string;
	threadId: string;
	subject: string;
	/** The agent's name, while it is in the workspace. */
	by: string | null;
	arrivedAt: number;
}

/** Where a listing goes on from. */
export interface MessageCursor {
	arrivedAt: number;
	id: string;
}

export interface MailboxPage {
	name: string;
	messages: ListedMessage[];
	/** Where the next, older page starts, or null when there is none. */
	next: MessageCursor | null;
}

export interface ListedThread {
	id: string;
	/** When its newest message arrived. */
	latestAt: number;
	/** How many messages it has. */
	count: number;
	/**
	 * Its newest message's subject, like the proved domain beside it, without "Re:", list tags and
	 * their kin. Those are what may differ between a thread's messages, so the words are the same
	 * whoever wrote which of them.
	 */
	subject: string;
	/** Who wrote in it, each once, in the order they first wrote. The first few only. */
	senders: Person[];
	/** As `verifiedDomain` in a listing, for its newest message. */
	latestVerifiedDomain: string | null;
}

/** Where a listing of threads goes on from. */
export interface ThreadCursor {
	latestAt: number;
	id: string;
}

export interface ThreadsPage {
	name: string;
	/** The addresses the mailbox may send from, lower case: its own, on a proved domain. */
	from: string[];
	/**
	 * The messages waiting for approval, the oldest first, and how many there are. Only on the
	 * first page, when not searching.
	 */
	awaiting: { count: number; messages: AwaitingMessage[] } | null;
	threads: ListedThread[];
	/** Where the next page, of threads with older news, starts, or null when there is none. */
	next: ThreadCursor | null;
}

export interface ThreadPage {
	/** The mailbox's name. */
	mailbox: string;
	/** As in `ThreadsPage`. */
	from: string[];
	/** As in `ListedThread`. */
	subject: string;
	/** How many messages the whole thread has. */
	count: number;
	/** A page of them, oldest first. The first page has the newest. */
	messages: ListedMessage[];
	/** Where the page before this one, of older messages, starts, or null when there is none. */
	older: MessageCursor | null;
	/** The newest message on this page, opened. */
	latest: OpenedMessage | null;
}

export interface OpenedMessage {
	id: string;
	/** The thread it is in. */
	threadId: string;
	arrivedAt: number;
	size: number;
	from: Person | null;
	to: Person[];
	cc: Person[];
	subject: string;
	/** The Date header as sent, or null when there is none. */
	date: string | null;
	/** As in a listing. */
	verifiedDomain: string | null;
	/** Cloudflare's DMARC verdict as it gave it, such as "fail" or "none", or null. */
	dmarc: string | null;
	/** The text, made from the HTML when the message has no text of its own. */
	text: string;
	/** True when the text was cut short to keep the page small. */
	textCut: boolean;
	/** The message has an HTML version, shown in a sandboxed frame from `htmlUrl`. */
	hasHtml: boolean;
	/** Its HTML seems to load images from elsewhere, which show only when asked for. */
	remoteImages: boolean;
	/** Its HTML is too long to show in full, so the frame shows the start of it. */
	htmlCut: boolean;
	attachments: { name: string | null; type: string; size: number }[];
	/** As in a listing. */
	sent: SentInfo | null;
	/**
	 * What a reply starts with: who it goes to, its subject, and which of the mailbox's addresses it
	 * goes from, which is null when the mailbox has none it may send from.
	 */
	reply: { to: string[]; cc: string[]; subject: string; from: string | null };
}

/** The most of a query that is sent. Search itself looks at less. */
export const MAX_QUERY_SENT = 1000;

const Id = z.string().min(1).max(100);
const Slug = z.string().min(1).max(100);

/** A page of a mailbox's messages, newest first, or null when the caller can't see it. */
export const getMailbox = createServerFn({ method: "GET" })
	.validator(
		z.object({
			workspace: Slug,
			mailbox: Id,
			before: z.object({ arrivedAt: z.number().int().nonnegative(), id: Id }).nullable(),
		}),
	)
	.handler(async ({ data }): Promise<MailboxPage | null> => {
		const { listMessages } = await import("#/server/mailbox/read");
		return listMessages(data.workspace, data.mailbox, data.before);
	});

/**
 * A page of a mailbox's threads, the newest news first, or of those a query finds. Null when the
 * caller can't see the mailbox.
 */
export const getThreads = createServerFn({ method: "GET" })
	.validator(
		z.object({
			workspace: Slug,
			mailbox: Id,
			before: z.object({ latestAt: z.number().int().nonnegative(), id: Id }).nullable(),
			query: z.string().max(MAX_QUERY_SENT).nullable(),
		}),
	)
	.handler(async ({ data }): Promise<ThreadsPage | null> => {
		const { listThreads } = await import("#/server/mailbox/read");
		return listThreads(data.workspace, data.mailbox, data.before, data.query || null);
	});

/** A page of a thread, or null when there is no such thread the caller can see. */
export const getThread = createServerFn({ method: "GET" })
	.validator(
		z.object({
			workspace: Slug,
			mailbox: Id,
			thread: Id,
			before: z.object({ arrivedAt: z.number().int().nonnegative(), id: Id }).nullable(),
		}),
	)
	.handler(async ({ data }): Promise<ThreadPage | null> => {
		const { openThread } = await import("#/server/mailbox/read");
		return openThread(data.workspace, data.mailbox, data.thread, data.before);
	});

/** One message, parsed, or null when there is no such message the caller can see. */
export const getMessage = createServerFn({ method: "GET" })
	.validator(z.object({ workspace: Slug, mailbox: Id, message: Id }))
	.handler(async ({ data }): Promise<OpenedMessage | null> => {
		const { openMessage } = await import("#/server/mailbox/read");
		return openMessage(data.workspace, data.mailbox, data.message);
	});

/** Where a message is, to read or, for an owner or admin, to delete. */
export const messageUrl = (workspace: string, mailbox: string, message: string) =>
	`/api/mail/${encodeURIComponent(workspace)}/${encodeURIComponent(mailbox)}/${encodeURIComponent(message)}`;

/** Where a message's raw mail can be downloaded, for those who can see it. */
export const originalUrl = (workspace: string, mailbox: string, message: string) =>
	`${messageUrl(workspace, mailbox, message)}/original`;

/**
 * Where a message's HTML is, as a page for a sandboxed frame. Remote images load only with
 * `images`, since loading them tells the sender the message was opened.
 */
export const htmlUrl = (workspace: string, mailbox: string, message: string, images = false) =>
	`${messageUrl(workspace, mailbox, message)}/html${images ? "?images=1" : ""}`;

/** Deletes a message, for an owner or admin. Says why when it couldn't. */
export async function deleteMessage(
	workspace: string,
	mailbox: string,
	message: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const response = await fetch(messageUrl(workspace, mailbox, message), { method: "DELETE" });
		if (response.status === 404) return { ok: false, error: "That message is gone already." };
		return (await response.json()) as { ok: true } | { ok: false; error: string };
	} catch {
		return { ok: false, error: "That didn't reach the server. Try again." };
	}
}
