import type { OutboxAction } from "#/server/mailbox/send";
import { RESEND_CODE, resendReason } from "./providers";

/**
 * What became of a message the mailbox sends, as far as Mail knows. One an agent wrote is `held`
 * until a person approves it, unless its policy lets it go as it is.
 */
export type SendState =
	| "held"
	| "sending"
	| "waiting"
	| "sent"
	| "refused"
	| "uncertain"
	| "discarded";

// A type, not an interface, so that SQLite's rows can be read as it.
export type SendStatus = {
	state: SendState;
	/**
	 * Why it isn't sent: Email Service's code, such as `E_RECIPIENT_SUPPRESSED`, or Mail's for
	 * Resend's answer, such as `resend:validation_error`, or for its own list (`SUPPRESSED_CODE`).
	 */
	code: string | null;
	/** When it is tried again, while it waits. */
	nextAt: number | null;
	/** Resend's own words for why, when it gave some. */
	detail: string | null;
};

/**
 * Mail's code for a message that waited to be tried again while an address it goes to came onto the
 * workspace's suppression list, so the try was stopped before any provider was asked.
 */
export const SUPPRESSED_CODE = "mail:suppressed";

/**
 * Mail's code for a message whose files couldn't be read from its copy at a try, so no provider was
 * asked to send it.
 */
export const COPY_UNREAD_CODE = "mail:copy_unread";

/** The most people one message goes to, To and Cc together. Email Service takes up to 50. */
export const MAX_RECIPIENTS = 20;

/** The longest subject Email Service takes, in characters. */
export const MAX_SUBJECT = 998;

/** The most text one message may have, in characters. */
export const MAX_TEXT = 100_000;

/** The most HTML one message may have, in characters. */
export const MAX_HTML = 500_000;

/** The most files one message may carry. */
export const MAX_ATTACHMENTS = 20;

/**
 * The most bytes a message's files may hold together. In Base64, beside the text and HTML, they
 * stay well under what one message may be at Email Service (25 MiB) and at Resend (40 MB).
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The most bytes a request to send may be: its files in Base64, a third larger, and the rest. */
export const MAX_SEND_BODY = 16_000_000;

/** The longest name a file may have, in characters. */
export const MAX_FILE_NAME = 200;

/** The longest link a message may say it was written for. */
export const MAX_CONTEXT_URL = 2000;

/** The longest label for that link. */
export const MAX_CONTEXT_LABEL = 100;

/**
 * What a message was written for, as whoever wrote it said: one https link, such as the CI run,
 * issue or pull request behind it, and a few words for it. The workspace sees it beside the
 * message as the writer's own words, never as proof, and it never goes into the mail.
 */
export interface SentContext {
	url: string;
	label: string | null;
}

// Control characters, and the format characters that can turn text around or hide it.
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A writer's link and label, as they are kept and shown, or why they can't be. */
export function sentContext(given: { url: string; label?: string | null }): SentContext | string {
	const written = given.url.trim();
	if (written.length > MAX_CONTEXT_URL) {
		return `The context's url can be ${MAX_CONTEXT_URL} characters at most.`;
	}
	let url: URL;
	try {
		url = new URL(written);
	} catch {
		return "The context's url isn't a link.";
	}
	if (url.protocol !== "https:") return "The context's url must be an https link.";
	if (url.username || url.password) {
		return "The context's url can't carry a user name or password.";
	}
	const label = (given.label ?? "").replace(UNSHOWN, " ").replace(/\s+/g, " ").trim();
	if (label.length > MAX_CONTEXT_LABEL) {
		return `The context's label can be ${MAX_CONTEXT_LABEL} characters at most.`;
	}
	// As the URL parser writes it, so a host in another script shows as the punycode it is.
	return url.href.length > MAX_CONTEXT_URL
		? `The context's url can be ${MAX_CONTEXT_URL} characters at most.`
		: { url: url.href, label: label || null };
}

/** A kept context, read back; null for none, or one that isn't what `sentContext` keeps. */
export function keptContext(json: string | null | undefined): SentContext | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as unknown;
		if (!value || typeof value !== "object" || !("url" in value)) return null;
		const { url, label } = value as { url: unknown; label?: unknown };
		if (typeof url !== "string" || !url.startsWith("https://")) return null;
		return { url, label: typeof label === "string" && label ? label : null };
	} catch {
		return null;
	}
}

/**
 * Kinds of file Mail doesn't send, by extension: those Resend refuses to send. They are refused
 * whichever provider a domain uses, so that it doesn't change what may go, and many receiving
 * servers refuse them too.
 */
const REFUSED_KINDS = new Set(
	"adp app asp bas bat cer chm cmd com cpl crt csh der exe fxp gadget hlp hta inf ins isp its js jse ksh lib lnk mad maf mag mam maq mar mas mat mau mav maw mda mdb mde mdt mdw mdz msc msh msh1 msh2 mshxml msh1xml msh2xml msi msp mst ops pcd pif plg prf prg reg scf scr sct shb shs sys ps1 ps1xml ps2 ps2xml psc1 psc2 tmp url vb vbe vbs vps vsmacros vss vst vsw vxd ws wsc wsf wsh xnk".split(
		" ",
	),
);

/** Why a file of this name can't go, or null when it may. */
export function fileNameRefusal(name: string): string | null {
	if (name.trim().length === 0 || name.length > MAX_FILE_NAME) {
		return `A file's name takes 1 to ${MAX_FILE_NAME} characters.`;
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds.
	if (/[\x00-\x1f\x7f-\x9f/\\]/.test(name)) {
		return "A file's name can't hold a slash, a backslash or a control character.";
	}
	// Marks that turn text around, so that "invoice\u202Efdp.html" reads as "invoicelmth.pdf".
	if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name)) {
		return "A file's name can't hold a mark that turns its text around.";
	}
	// Mail reads "=?…?=" in a name as encoded text, which would give the file another name.
	if (name.includes("=?")) return "A file's name can't hold =?, which mail reads as encoded text.";
	if (/^[. ]+$/.test(name)) return "A file's name needs more than dots.";
	// Windows drops dots and spaces at a name's end, so "a.exe." opens as "a.exe".
	const kind = /\.([^.]*)$/.exec(name.replace(/[. ]+$/, ""))?.[1]?.toLowerCase() ?? "";
	return REFUSED_KINDS.has(kind)
		? `Mail doesn't send .${kind} files, which many mail servers refuse.`
		: null;
}

/** Why these files can't be added to those a message has, or null when they may. */
export function addedFilesRefusal(
	has: { name: string; size: number }[],
	added: { name: string; size: number }[],
): string | null {
	for (const file of added) {
		const refusal = fileNameRefusal(file.name);
		if (refusal) return refusal;
		if (file.size === 0) return `${file.name} is empty.`;
	}
	const all = [...has, ...added];
	if (all.length > MAX_ATTACHMENTS) {
		return `One message can carry at most ${MAX_ATTACHMENTS} files.`;
	}
	if (all.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) {
		return `A message's files can hold ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB together at most.`;
	}
	return null;
}

/**
 * The type a file goes with, from the one its browser gave: none, for the server to tell from its
 * name, or bytes for a message or a multipart, which mail can't carry in Base64 as their own.
 */
export const sendableType = (type: string) =>
	/^(multipart|message)\//i.test(type) ? "application/octet-stream" : type || null;

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

/** Whether a message went, or is to go, through Resend, by its code. */
export const isResendCode = (code: string | null) => code?.startsWith(RESEND_CODE) ?? false;

/** Why a message isn't sent, in words, from Email Service's code or Resend's answer. */
export function refusalReason(code: string | null, detail: string | null = null): string {
	if (code !== null && isResendCode(code)) return resendReason(code, detail);
	switch (code) {
		case SUPPRESSED_CODE:
			return "An address it goes to came onto this workspace's suppression list while it waited, so Mail didn't send it. An owner or admin can see the list in Settings, under Suppressions.";
		case COPY_UNREAD_CODE:
			return "Mail couldn't read its files from its copy, so it didn't send it. Write it again.";
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
	| { ok: false; error: string; lost?: boolean; suppressed?: string[] };

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

/**
 * A reply's text: room to write, then the message it answers, quoted. `said` names who wrote it,
 * as the sender named themselves, and stands above the quote among the person's own lines, where
 * marks are read: so it has no brackets, and a name can't make a link there.
 */
export function quoted(text: string, said: string): string {
	const lines = text.replace(/\r\n?/g, "\n").trimEnd().split("\n");
	const quote = lines.map((line) => (line ? `> ${line}` : ">")).join("\n");
	const plain = said.replace(/[[\]]/g, "");
	// Leave room for what the reply says above it.
	return `\n\n${plain}\n${quote}`.slice(0, MAX_TEXT - 10_000);
}
