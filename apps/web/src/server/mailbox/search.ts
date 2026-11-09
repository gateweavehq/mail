/**
 * Search: what the mailbox object puts in its full-text index for each message, and how what
 * someone types becomes an FTS5 query.
 */
import PostalMime, { decodeWords } from "postal-mime";
import { type RawMail, type RawRef, SealError } from "./sealed";
import { textOfHtml } from "./text";

/** How much of a message's start is read for its text. Text parts come before most attachments. */
export const SEARCH_READ_BYTES = 2 * 1024 * 1024;

/**
 * The most of a message's text the index takes, in characters. With the caps below, a message's
 * entry stays well under the 2 MB a Durable Object's SQLite takes in one value.
 */
export const MAX_SEARCHED_TEXT = 100_000;

/** The most of a message's subject, or of its sender, the index takes. */
export const MAX_SEARCHED_HEADER = 1_000;

/** The most of a message's attachments' names, all together, the index takes. */
export const MAX_SEARCHED_NAMES = 10_000;

/** The longest query, in characters. */
export const MAX_QUERY = 200;

/** The most words a query looks for. */
export const MAX_QUERY_WORDS = 10;

/**
 * How long the last word must be to also find the words it starts. A shorter one starts so many
 * that a big mailbox would read most of its index for it.
 */
export const MIN_PREFIX = 2;

/** What a message is found by, as the index's columns take it. */
export interface Searchable {
	subject: string;
	sender: string;
	attachments: string;
	body: string;
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

/**
 * Text as both the index and a query take it, with look-alike forms made plain: full-width and
 * half-width letters and digits, ligatures. Either side may be written in them. Cut before, so
 * that little is made plain, and after, as NFKC can make one character many.
 */
function plain(text: string, max: number): string {
	return text.slice(0, max).normalize("NFKC").slice(0, max);
}

/**
 * What a stored message is found by: its subject and From always, and its text and attachments'
 * names when the start of its mail parses. A message that doesn't parse, or whose sealed mail
 * doesn't open, is still found by its headers, so it can't hold up the rest. Reading R2 may throw,
 * for the alarm to try again.
 */
export async function searchable(
	raw: RawMail,
	message: RawRef & { subject: string | null; from: string | null },
): Promise<Searchable> {
	const found = {
		subject: plain(decoded(message.subject), MAX_SEARCHED_HEADER),
		sender: plain(decoded(message.from), MAX_SEARCHED_HEADER),
		attachments: "",
		body: "",
	};
	let start: Uint8Array<ArrayBuffer> | null;
	try {
		start = await raw.bytes(message, {
			offset: 0,
			length: Math.max(1, Math.min(message.size, SEARCH_READ_BYTES)),
		});
	} catch (error) {
		if (error instanceof SealError) return found;
		throw error;
	}
	if (!start) return found;
	try {
		const email = await PostalMime.parse(start);
		const text = email.text ?? (email.html ? (await textOfHtml(email.html)).text : "");
		found.body = plain(text, MAX_SEARCHED_TEXT);
		found.attachments = plain(
			email.attachments
				.map((attachment) => attachment.filename ?? "")
				.filter((name) => name.length > 0)
				.join(" "),
			MAX_SEARCHED_NAMES,
		);
	} catch {
		// Its headers are enough to find it by.
	}
	return found;
}

/**
 * What someone typed, as an FTS5 query, or null when it has nothing to look for. Each word is
 * quoted, so that what FTS5 would read as syntax (`OR`, `NEAR`, `*`, `column:`) is only text, and
 * a message must have them all. The last word also finds the words it starts, as it may be half
 * typed, when what it ends with is long enough: FTS5 takes the prefix from its last token, so `a.`
 * would look for every word that starts with `a`. A word with no letter or digit in it has nothing
 * to find, and is left out. Control characters part words: FTS5 would end a quoted word at a NUL.
 */
export function ftsQuery(typed: string): string | null {
	const words = plain(typed, MAX_QUERY)
		.replace(/\p{Cc}/gu, " ")
		.split(/\s+/)
		.filter((word) => /[\p{L}\p{N}]/u.test(word))
		.slice(0, MAX_QUERY_WORDS);
	if (words.length === 0) return null;
	return words
		.map((word, at) => {
			const quoted = `"${word.replaceAll('"', '""')}"`;
			if (at < words.length - 1) return quoted;
			// The letters and digits it ends with, marks such as accents aside.
			const end = word.match(/[\p{L}\p{N}\p{M}]+$/u)?.[0] ?? "";
			const counted = end.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
			return counted >= MIN_PREFIX ? `${quoted}*` : quoted;
		})
		.join(" ");
}
