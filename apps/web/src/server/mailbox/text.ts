/** Text from a message's HTML, for reading, search and sending. */
import PostalMime from "postal-mime";

/** The most HTML turned into text for one message, in characters. */
export const MAX_HTML_READ = 1_000_000;

async function linksAfterLabels(html: string): Promise<string> {
	let openAnchors = 0;
	try {
		const rewritten = await new HTMLRewriter()
			.on("a", {
				element(element) {
					if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
					const href = element.getAttribute("href")?.trim();
					// Keep the tag boundaries for PostalMime, but hide the attributes from its
					// href matcher, which can mistake words in a title for a destination.
					element.before("<a>", { html: true });
					element.removeAndKeepContent();
					openAnchors++;
					element.onEndTag((end) => {
						openAnchors--;
						// HTMLRewriter returns the attribute as written. Leave entities for
						// PostalMime to decode once, and keep literal angles out of its markup.
						const address = href?.replace(/</g, "&lt;").replace(/>/g, "&gt;");
						end.before(address ? `</a> (${address})` : "</a>", { html: true });
					});
				},
			})
			.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }))
			.text();
		// An unclosed anchor (including one left open by the size limit) has no end
		// callback. Use the original so a destination is still in the text.
		return openAnchors === 0 ? rewritten : html;
	} catch {
		// If the rewriter cannot process malformed HTML, keep PostalMime's fallback.
		return html;
	}
}

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
		await linksAfterLabels(html.slice(0, MAX_HTML_READ)),
		`--${boundary}--`,
		"",
	].join("\r\n");
	const email = await PostalMime.parse(wrapped);
	return { text: (email.text ?? "").trim(), cut: html.length > MAX_HTML_READ };
}
