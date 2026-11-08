import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

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
	/** The first message's subject. */
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
	threads: ListedThread[];
	/** Where the next page, of threads with older news, starts, or null when there is none. */
	next: ThreadCursor | null;
}

export interface ThreadPage {
	/** The mailbox's name. */
	mailbox: string;
	/** The first message's subject. */
	subject: string;
	/** Oldest first. A very long thread has only its newest messages here. */
	messages: ListedMessage[];
	/** True when older messages were left out. */
	cut: boolean;
	/** Its newest message, opened. */
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
	/** The message has an HTML version, which Mail doesn't show yet. */
	hasHtml: boolean;
	attachments: { name: string | null; type: string; size: number }[];
}

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

/** A page of a mailbox's threads, the newest news first, or null when the caller can't see it. */
export const getThreads = createServerFn({ method: "GET" })
	.validator(
		z.object({
			workspace: Slug,
			mailbox: Id,
			before: z.object({ latestAt: z.number().int().nonnegative(), id: Id }).nullable(),
		}),
	)
	.handler(async ({ data }): Promise<ThreadsPage | null> => {
		const { listThreads } = await import("#/server/mailbox/read");
		return listThreads(data.workspace, data.mailbox, data.before);
	});

/** A thread, with its newest message opened, or null when there is no such thread the caller can see. */
export const getThread = createServerFn({ method: "GET" })
	.validator(z.object({ workspace: Slug, mailbox: Id, thread: Id }))
	.handler(async ({ data }): Promise<ThreadPage | null> => {
		const { openThread } = await import("#/server/mailbox/read");
		return openThread(data.workspace, data.mailbox, data.thread);
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
