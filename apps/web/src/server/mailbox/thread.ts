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
	const found: string[] = [];
	for (const match of value.matchAll(/<([^<>\s]+)>/g)) {
		const id = match[1];
		if (id && id.length <= MAX_ID && !found.includes(id)) found.push(id);
	}
	return found;
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
	const ids = messageIds(firstHeader(headers, "references"));
	for (const id of messageIds(firstHeader(headers, "in-reply-to"))) {
		if (!ids.includes(id)) ids.push(id);
	}
	return ids.slice(-MAX_REFERENCES);
}

// "Re:", "Fwd:" and their kin in other languages, maybe numbered as in "Re[2]:", and list tags such
// as "[team]". Full-width colons come from Chinese and Japanese mail programs.
const PREFIX =
	/^\s*(?:(?:re|fwd?|fw|aw|wg|sv|vs|antw|doorst|tr|rif|r|res|enc|odp|pd|ynt|ilt|yan[ıi]t|回复|回覆|转发|轉寄|答复|返信|転送)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]|\[[^\]]{1,40}\])\s*/iu;

/**
 * A subject as threads compare it: decoded, without the prefixes replies and forwards add, in one
 * case, with its spaces collapsed. "Re: [team] AW: Invoice 42" and "Invoice  42" are the same.
 */
export function subjectKey(subject: string | null): string {
	if (!subject) return "";
	let text: string;
	try {
		text = decodeWords(subject);
	} catch {
		text = subject;
	}
	text = text.normalize("NFKC").replace(/\s+/g, " ").trim();
	for (let i = 0; i < 20; i++) {
		const shorter = text.replace(PREFIX, "");
		if (shorter === text) break;
		text = shorter;
	}
	return text.toLowerCase();
}
