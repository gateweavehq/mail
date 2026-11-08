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
 * What a stored message is found by: its subject and From always, and its text and attachments'
 * names when the start of its mail parses. A message that doesn't parse is still found by its
 * headers, so it can't hold up the rest. Reading R2 may throw, for the alarm to try again.
 */
export async function searchable(
	bucket: R2Bucket,
	message: { object: string; size: number; subject: string | null; from: string | null },
): Promise<Searchable> {
	const found = {
		subject: decoded(message.subject),
		sender: decoded(message.from),
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
		found.body = text.slice(0, MAX_SEARCHED_TEXT);
		found.attachments = email.attachments
			.map((attachment) => attachment.filename ?? "")
			.filter((name) => name.length > 0)
			.join(" ");
	} catch {
		// Its headers are enough to find it by.
	}
	return found;
}

/**
 * What someone typed, as an FTS5 query, or null when it has nothing to look for. Each word is
 * quoted, so that what FTS5 would read as syntax (`OR`, `NEAR`, `*`, `column:`) is only text, and
 * a message must have them all. The last word also finds the words it starts, as it may be half
 * typed. A word with no letter or digit in it has nothing to find, and is left out.
 */
export function ftsQuery(typed: string): string | null {
	const words = typed
		.slice(0, MAX_QUERY)
		.normalize("NFKC")
		.split(/\s+/)
		.filter((word) => /[\p{L}\p{N}]/u.test(word))
		.slice(0, MAX_QUERY_WORDS);
	if (words.length === 0) return null;
	return words
		.map((word, at) => {
			const quoted = `"${word.replaceAll('"', '""')}"`;
			return at === words.length - 1 ? `${quoted}*` : quoted;
		})
		.join(" ");
}
