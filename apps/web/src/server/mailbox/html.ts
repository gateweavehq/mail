/**
 * A message's HTML as a page of its own, for a sandboxed frame in the message's page.
 *
 * What keeps it harmless is the policy it is served with, not the cleaning: no scripts at all, an
 * opaque origin, and nothing loaded from outside unless the reader asks for remote images. The
 * cleaning here is a second layer, and it makes links open in a new tab and inline images show.
 * HTMLRewriter exists only in workerd, so the tests for this are the Worker's.
 */
import type { Attachment } from "postal-mime";

/** The most of a message's HTML shown, in characters. */
export const MAX_SHOWN_HTML = 1_000_000;

/** The most the inline images of one message add to its page, in base64 characters. */
export const MAX_INLINE_IMAGES = 5_000_000;

/** Image types a browser shows without running anything, which an inline part may be. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Tags that stay, with the attributes below. Any other tag goes, and keeps its content or not. */
const KEPT_TAGS = new Set([
	"html",
	"head",
	"body",
	"style",
	"div",
	"span",
	"p",
	"br",
	"hr",
	"a",
	"img",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th",
	"caption",
	"colgroup",
	"col",
	"center",
	"font",
	"b",
	"strong",
	"i",
	"em",
	"u",
	"s",
	"strike",
	"del",
	"ins",
	"sub",
	"sup",
	"small",
	"big",
	"mark",
	"code",
	"pre",
	"kbd",
	"samp",
	"tt",
	"var",
	"blockquote",
	"q",
	"cite",
	"abbr",
	"acronym",
	"address",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"dl",
	"dt",
	"dd",
	"figure",
	"figcaption",
	"section",
	"article",
	"header",
	"footer",
	"nav",
	"main",
	"aside",
	"details",
	"summary",
	"time",
	"wbr",
	"label",
	"bdi",
	"bdo",
	"ruby",
	"rt",
	"rp",
	"dfn",
	"nobr",
]);

/**
 * Tags that go with everything in them. Some would load or run something, some are a form's, and
 * some hold raw text: keeping the text of one of those would turn it into markup.
 */
const DROPPED_TAGS = new Set([
	"script",
	"noscript",
	"template",
	"iframe",
	"frame",
	"frameset",
	"noframes",
	"object",
	"embed",
	"applet",
	"param",
	"title",
	"textarea",
	"xmp",
	"plaintext",
	"noembed",
	"svg",
	"math",
	"canvas",
	"audio",
	"video",
	"source",
	"track",
	"link",
	"meta",
	"base",
	"input",
	"select",
	"option",
	"optgroup",
	"datalist",
	"dialog",
	"portal",
	"slot",
	"map",
	"area",
]);

/** Attributes that stay on a kept tag. None of them holds an address. */
const KEPT_ATTRIBUTES = new Set([
	"style",
	"class",
	"id",
	"name",
	"title",
	"lang",
	"dir",
	"align",
	"valign",
	"width",
	"height",
	"bgcolor",
	"color",
	"border",
	"cellpadding",
	"cellspacing",
	"colspan",
	"rowspan",
	"nowrap",
	"alt",
	"face",
	"size",
	"summary",
	"abbr",
	"scope",
	"headers",
	"start",
	"type",
	"reversed",
	"value",
	"hspace",
	"vspace",
	"clear",
	"noshade",
	"span",
	"frame",
	"rules",
	"role",
	"datetime",
	"open",
	"media",
]);

/** Whether an attribute's value, as written, starts with one of these. Entities aren't decoded. */
const startsWith = (value: string, pattern: RegExp) =>
	pattern.test(value.replace(/^[\0-\x20]+/, ""));

const LINK = /^(?:https?:|mailto:|#)/i;
const REMOTE = /^(?:https?:)?\/\//i;
const INLINE_DATA = /^data:image\//i;
const CID = /^cid:/i;

/**
 * Whether the HTML seems to load images from elsewhere, to offer showing them. It may be wrong
 * either way; the policy decides what loads.
 */
export function mayLoadImages(html: string): boolean {
	return /(?:\b(?:src|srcset|background)\s*=\s*["']?|\burl\(\s*["']?)\s*(?:https?:)?\/\//i.test(
		html.slice(0, MAX_SHOWN_HTML),
	);
}

/** The message's images that its HTML names by `cid:`, as `data:` addresses, up to the cap. */
function inlineImages(attachments: Attachment[]): Map<string, string> {
	const found = new Map<string, string>();
	let total = 0;
	for (const attachment of attachments) {
		if (!attachment.contentId || !INLINE_TYPES.has(attachment.mimeType)) continue;
		if (typeof attachment.content !== "string" || attachment.encoding !== "base64") continue;
		const address = `data:${attachment.mimeType};base64,${attachment.content}`;
		if (total + address.length > MAX_INLINE_IMAGES) continue;
		total += address.length;
		found.set(attachment.contentId.trim().replace(/^<(.*)>$/, "$1"), address);
	}
	return found;
}

function contentId(src: string): string {
	const id = src.trim().slice("cid:".length);
	try {
		return decodeURIComponent(id);
	} catch {
		return id;
	}
}

/**
 * The cleaned HTML of a message. `attachments` must come from a parse with `attachmentEncoding:
 * "base64"`. Remote images keep their addresses only when `images` is true.
 */
export async function cleanHtml(
	html: string,
	attachments: Attachment[],
	{ images }: { images: boolean },
): Promise<string> {
	const inline = inlineImages(attachments);
	const rewriter = new HTMLRewriter()
		.on("*", {
			element(element) {
				const tag = element.tagName.toLowerCase();
				if (DROPPED_TAGS.has(tag) || element.namespaceURI !== "http://www.w3.org/1999/xhtml") {
					element.remove();
					return;
				}
				if (!KEPT_TAGS.has(tag)) {
					element.removeAndKeepContent();
					return;
				}
				// The DOM's types, which the app's pages need, give `Element` the DOM's attributes.
				const attributes = element.attributes as unknown as Iterable<[string, string]>;
				const names = [...attributes].map(([name]) => name);
				for (const name of names) {
					const lower = name.toLowerCase();
					if (KEPT_ATTRIBUTES.has(lower)) continue;
					if (tag === "a" && lower === "href") continue;
					if (tag === "img" && lower === "src") continue;
					element.removeAttribute(name);
				}
				if (tag === "a") {
					const href = element.getAttribute("href");
					if (href === null) return;
					if (!startsWith(href, LINK)) {
						element.removeAttribute("href");
					} else if (!startsWith(href, /^#/)) {
						// A new tab, never the app's, and nothing of the frame's address goes with it.
						element.setAttribute("target", "_blank");
						element.setAttribute("rel", "noopener noreferrer");
					}
				}
				if (tag === "img") {
					const src = element.getAttribute("src");
					if (src === null) return;
					if (startsWith(src, CID)) {
						const found = inline.get(contentId(src));
						if (found) element.setAttribute("src", found);
						else element.removeAttribute("src");
					} else if (!startsWith(src, INLINE_DATA) && !(images && startsWith(src, REMOTE))) {
						element.removeAttribute("src");
					}
				}
			},
		})
		.onDocument({
			comments(comment) {
				comment.remove();
			},
		});
	const cut = html.length > MAX_SHOWN_HTML;
	const cleaned = await rewriter
		.transform(
			new Response(html.slice(0, MAX_SHOWN_HTML), {
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		)
		.text();
	return [
		"<!doctype html>",
		'<meta charset="utf-8">',
		`<style>${FRAME_STYLE}</style>`,
		cleaned,
		cut ? `<p style="${CUT_STYLE}">${CUT_NOTE}</p>` : "",
	].join("");
}

/**
 * How a message looks unless it says otherwise: on white, as its sender saw it, whatever the app's
 * theme. Its own styles come after these.
 */
const FRAME_STYLE = [
	":root{color-scheme:light}",
	"html{background:#fff;color:#000}",
	"body{margin:16px;font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;overflow-wrap:break-word}",
	"img{max-width:100%;height:auto}",
	"pre{white-space:pre-wrap}",
].join("");

const CUT_STYLE =
	"font:14px system-ui,sans-serif;color:#555;border-top:1px solid #ddd;padding-top:8px";
const CUT_NOTE = "This message is too long to show in full. Download the original for the rest.";

/**
 * What the frame's page may do: nothing that runs, nothing from elsewhere but images when asked,
 * and only links that open a tab of their own. `sandbox` gives it an opaque origin even when it is
 * opened on its own, so it can't read the app's cookies or reach its pages.
 */
export function framePolicy({ images }: { images: boolean }): string {
	return [
		"sandbox allow-popups allow-popups-to-escape-sandbox",
		"default-src 'none'",
		`img-src data:${images ? " https: http:" : ""}`,
		"style-src 'unsafe-inline'",
		"font-src data:",
		"frame-ancestors 'self'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}
