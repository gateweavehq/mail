import type { OutboxAction } from "#/server/mailbox/send";

/** What became of a message the mailbox sends, as far as Mail knows. */
export type SendState = "sending" | "waiting" | "sent" | "refused" | "uncertain" | "discarded";

// A type, not an interface, so that SQLite's rows can be read as it.
export type SendStatus = {
	state: SendState;
	/** Email Service's code for why it isn't sent, such as `E_RECIPIENT_SUPPRESSED`. */
	code: string | null;
	/** When it is tried again, while it waits. */
	nextAt: number | null;
};

/** The most people one message goes to, To and Cc together. Email Service takes up to 50. */
export const MAX_RECIPIENTS = 20;

/** The longest subject Email Service takes, in characters. */
export const MAX_SUBJECT = 998;

/** The most text one message may have, in characters. */
export const MAX_TEXT = 100_000;

/**
 * An address someone types: a local part of RFC 5322's dot-atoms, so no dot at its ends or two in a
 * row, and a domain with a dot. Each label of the domain may hold letters, digits and hyphens, as
 * internationalised ones (`xn--…`) need. Nothing that would end an address or a header gets in: no
 * spaces, line breaks, angle brackets, double quotes or commas.
 */
const ADDRESS =
	/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/** Whether this is an address a message can go to. */
export const isAddress = (address: string) => address.length <= 254 && ADDRESS.test(address);

/** Whether a person may try this message again, or discard it. */
export const canSendAgain = (status: SendStatus | null) =>
	status?.state === "refused" || status?.state === "uncertain";

/** Why a message isn't sent, in words, from Email Service's code. */
export function refusalReason(code: string | null): string {
	switch (code) {
		case "E_RECIPIENT_SUPPRESSED":
			return "An address it goes to bounced before or asked not to get mail, so Email Service won't send to it.";
		case "E_SENDER_DOMAIN_NOT_AVAILABLE":
		case "E_SENDER_NOT_VERIFIED":
			return "This mailbox's domain isn't set up to send mail yet. An admin can turn on Email Sending for it.";
		case "E_DELIVERY_FAILED":
			return "The receiving mail server refused it.";
		case "E_ACCOUNT_SUSPENDED":
			return "Sending is paused for this account.";
		case "E_RATE_LIMIT_EXCEEDED":
		case "E_DAILY_LIMIT_EXCEEDED":
			return "Email Service stayed busy, so it wasn't sent.";
		case "E_CONTENT_TOO_LARGE":
			return "It's too large to send.";
		case null:
			return "It isn't sent.";
		default:
			return `Email Service refused it (${code}).`;
	}
}

/** What a message the mailbox sends is, once Mail has it: where its copy is, and how it went. */
export type Sent = { id: string; threadId: string } & SendStatus;

/**
 * What the server answered. `lost` when no answer came, so a message may have gone or not; sending
 * the same draft again is safe, as the server knows it.
 */
export type OutboxAnswer<T = object> =
	| ({ ok: true } & T)
	| { ok: false; error: string; lost?: boolean };

/** Where a mailbox sends from, tries again and discards. */
export const outboxUrl = (workspace: string, mailbox: string) =>
	`/api/mail/${encodeURIComponent(workspace)}/${encodeURIComponent(mailbox)}/outbox`;

/** Sends, tries again or discards. What goes wrong comes back in words to show. */
export async function changeOutbox<T = object>(
	workspace: string,
	mailbox: string,
	action: OutboxAction,
): Promise<OutboxAnswer<T>> {
	try {
		const response = await fetch(outboxUrl(workspace, mailbox), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(action),
		});
		return (await response.json()) as OutboxAnswer<T>;
	} catch {
		// The request failed, or what came back isn't the server's answer.
		return { ok: false, error: "That didn't reach the server. Try again.", lost: true };
	}
}

/**
 * The addresses someone typed in one box, split at commas, semicolons and spaces. A name in front
 * of an address isn't taken: the box holds addresses only.
 */
export const typedAddresses = (typed: string) =>
	typed
		.split(/[\s,;]+/)
		.map((address) => address.trim())
		.filter(Boolean);

/** A reply's text: room to write, then the message it answers, quoted. */
export function quoted(text: string, said: string): string {
	const lines = text.replace(/\r\n?/g, "\n").trimEnd().split("\n");
	const quote = lines.map((line) => (line ? `> ${line}` : ">")).join("\n");
	// Leave room for what the reply says above it.
	return `\n\n${said}\n${quote}`.slice(0, MAX_TEXT - 10_000);
}
