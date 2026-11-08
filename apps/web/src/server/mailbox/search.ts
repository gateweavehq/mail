/**
 * Search: what the mailbox object puts in its full-text index for each message, and how what
 * someone types becomes an FTS5 query.
 */
import PostalMime, { decodeWords } from "postal-mime";
import { textOfHtml } from "./text";

/** How much of a message's start is read for its text. Text parts come before most attachments. */
export const SEARCH_READ_BYTES = 2 * 1024 * 1024;

/** The most of a message's text the index takes, in characters. */
export const MAX_SEARCHED_TEXT = 100_000;

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
 * half-width letters and digits, ligatures. Either side may be written in them.
 */
function plain(text: string): string {
	return text.normalize("NFKC");
}

/**
 * What a stored message is found by: its subject and From always, and its text and attachments'
 * names when the start of its mail parses. A message that doesn't parse is still found by its
 * headers, so it can't hold up the rest. Reading R2 may throw, for the alarm to try again.
 */
export async function searchable(
	bucket: R2Bucket,
	message: { object: string; size: number; subject: string | null; from: string | null },
): Promise<Searchable> {
	const found = {
		subject: plain(decoded(message.subject)),
		sender: plain(decoded(message.from)),
		attachments: "",
		body: "",
	};
	const object = await bucket.get(message.object, {
		range: { offset: 0, length: Math.max(1, Math.min(message.size, SEARCH_READ_BYTES)) },
	});
	if (!object) return found;
	const start = await object.arrayBuffer();
	try {
		const email = await PostalMime.parse(start);
		const text = email.text ?? (email.html ? (await textOfHtml(email.html)).text : "");
		// Cut again once plain, as NFKC can make a character many.
		found.body = plain(text.slice(0, MAX_SEARCHED_TEXT)).slice(0, MAX_SEARCHED_TEXT);
		found.attachments = plain(
			email.attachments
				.map((attachment) => attachment.filename ?? "")
				.filter((name) => name.length > 0)
				.join(" "),
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
 * typed, when it is long enough. A word with no letter or digit in it has nothing to find, and is
 * left out. Control characters part words: FTS5 would end a quoted word at a NUL.
 */
export function ftsQuery(typed: string): string | null {
	const words = plain(typed.slice(0, MAX_QUERY))
		.replace(/\p{Cc}/gu, " ")
		.split(/\s+/)
		.filter((word) => /[\p{L}\p{N}]/u.test(word))
		.slice(0, MAX_QUERY_WORDS);
	if (words.length === 0) return null;
	return words
		.map((word, at) => {
			const quoted = `"${word.replaceAll('"', '""')}"`;
			const last = at === words.length - 1;
			return last && [...word].length >= MIN_PREFIX ? `${quoted}*` : quoted;
		})
		.join(" ");
}
