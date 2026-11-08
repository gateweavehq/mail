/**
 * What threads a message: the ids it names in `In-Reply-To` and `References`, its own
 * `Message-ID`, and its subject without the prefixes replies and forwards add.
 */
import { decodeWords } from "postal-mime";
import { firstHeader, type Header } from "./headers";

/** The most ids a message's references keep: the newest, as `References` lists the oldest first. */
export const MAX_REFERENCES = 50;

/** The longest id kept. A line of mail is at most 998 characters. */
const MAX_ID = 998;

/**
 * The ids in a header value, without their angle brackets, in order and each once. Anything
 * outside `<…>` is a comment or noise, as some senders write `<id> (added by …)`.
 */
export function messageIds(value: string | null): string[] {
	if (!value) return [];
	const found = new Set<string>();
	for (const match of value.matchAll(/<([^<>\s]+)>/g)) {
		const id = match[1];
		if (id && id.length <= MAX_ID) found.add(id);
	}
	return [...found];
}

/** A message's own id, or null when its `Message-ID` holds none. */
export function ownId(headers: Header[]): string | null {
	return messageIds(firstHeader(headers, "message-id"))[0] ?? null;
}

/**
 * The ids a message replies to or follows: its `References`, then its `In-Reply-To`, each once.
 * Only the newest `MAX_REFERENCES` are kept, which is plenty to find a thread.
 */
export function referencedIds(headers: Header[]): string[] {
	// `References` lists the oldest first, and a long thread's runs past what a listing keeps of a
	// header, so it is read from its end.
	const references = headers.find((header) => header.name === "references")?.value ?? null;
	const ids = new Set(messageIds(references?.slice(-MAX_REFERENCES * (MAX_ID + 3)) ?? null));
	for (const id of messageIds(firstHeader(headers, "in-reply-to"))) ids.add(id);
	return [...ids].slice(-MAX_REFERENCES);
}

// "Re:", "Fwd:" and their kin in other languages, maybe numbered as in "Re[2]:". Full-width colons
// come from Chinese and Japanese mail programs.
const REPLY =
	/^\s*(?:re|fwd?|fw|aw|wg|sv|vs|antw|doorst|tr|rif|r|res|enc|odp|pd|ynt|ilt|yan[ıi]t|回复|回覆|转发|轉寄|答复|返信|転送)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/iu;

// Those, and list tags such as "[team]".
const PREFIX = new RegExp(String.raw`${REPLY.source}|^\s*\[[^\]]{1,40}\]\s*`, "iu");

/** Takes `pattern` off the start of `text` as often as it is there, up to a point. */
function strip(text: string, pattern: RegExp): string {
	let rest = text;
	for (let i = 0; i < 20; i++) {
		const shorter = rest.replace(pattern, "");
		if (shorter === rest) break;
		rest = shorter;
	}
	return rest;
}

/**
 * A decoded subject's words, in the case they were written in: forms that only look like letters
 * or brackets made plain, as with full-width ones, spaces collapsed, and the prefixes replies,
 * forwards and lists add taken off. A thread's line shows these, and threads compare them in one
 * case, so the line has the same words for every message of the thread, and whoever wrote its
 * newest can't put words of their own there, in a list tag or otherwise.
 */
export function threadSubject(subject: string): string {
	return strip(subject.normalize("NFKC").replace(/\s+/g, " ").trim(), PREFIX);
}

/**
 * A subject as threads compare it: `threadSubject` of it decoded, in one case.
 * "Re: [team] AW: Invoice 42" and "Invoice  42" are the same.
 */
export function subjectKey(subject: string | null): string {
	if (!subject) return "";
	let text: string;
	try {
		text = decodeWords(subject);
	} catch {
		text = subject;
	}
	return threadSubject(text).toLowerCase();
}
