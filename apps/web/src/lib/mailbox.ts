import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** Someone named in a message's headers. The name is decoded; either part may be empty. */
export interface Person {
	name: string;
	address: string;
}

export interface ListedMessage {
	id: string;
	arrivedAt: number;
	from: Person | null;
	subject: string;
	/** Cloudflare found that the From header's domain sent it (DMARC pass). */
	verified: boolean;
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

export interface OpenedMessage {
	id: string;
	arrivedAt: number;
	size: number;
	from: Person | null;
	to: Person[];
	cc: Person[];
	subject: string;
	/** The Date header as sent, or null when there is none. */
	date: string | null;
	verified: boolean;
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

/** One message, parsed, or null when there is no such message the caller can see. */
export const getMessage = createServerFn({ method: "GET" })
	.validator(z.object({ workspace: Slug, mailbox: Id, message: Id }))
	.handler(async ({ data }): Promise<OpenedMessage | null> => {
		const { openMessage } = await import("#/server/mailbox/read");
		return openMessage(data.workspace, data.mailbox, data.message);
	});

/** Where a message's raw mail can be downloaded, for those who can see it. */
export const originalUrl = (workspace: string, mailbox: string, message: string) =>
	`/api/mail/${encodeURIComponent(workspace)}/${encodeURIComponent(mailbox)}/${encodeURIComponent(message)}/original`;
