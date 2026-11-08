/** Text from a message's HTML, for its page and for search. */
import PostalMime from "postal-mime";

/** The most HTML turned into text for one message, in characters. */
export const MAX_HTML_READ = 1_000_000;

/**
 * The text of a message that only has HTML. postal-mime renders HTML as text, dropping scripts and
 * styles and decoding entities, but only for a message that has a text part too, and it has no
 * other way in to that. So it is given one: the HTML beside an empty text part, under a boundary
 * the sender can't know.
 */
export async function textOfHtml(html: string): Promise<{ text: string; cut: boolean }> {
	const boundary = `gateweave-${crypto.randomUUID()}`;
	const wrapped = [
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		"",
		`--${boundary}`,
		"Content-Type: text/html; charset=utf-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		html.slice(0, MAX_HTML_READ),
		`--${boundary}--`,
		"",
	].join("\r\n");
	const email = await PostalMime.parse(wrapped);
	return { text: (email.text ?? "").trim(), cut: html.length > MAX_HTML_READ };
}
