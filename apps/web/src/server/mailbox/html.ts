/**
 * A message's HTML as a page of its own, for a sandboxed frame in the message's page.
 *
 * What keeps it harmless is the policy it is served with, not the cleaning: no scripts at all, an
 * opaque origin, and nothing loaded from outside unless the reader asks for remote images. The
 * cleaning here is a second layer, and it makes links open in a new tab and inline images show.
 * HTMLRewriter exists only in workerd, so the tests for the cleaning are the Worker's.
 */
import type { Attachment } from "postal-mime";

/** The most of a message's HTML shown, in characters. */
export const MAX_SHOWN_HTML = 1_000_000;

/** The most the inline images of one message add to its page, in characters, at every use. */
export const MAX_INLINE_IMAGES = 5_000_000;

/**
 * Image types a browser shows without running anything, which an inline part may be. A part sent
 * as `image/jpg` counts as JPEG.
 */
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
 * Whether the HTML seems to load images from elsewhere, to offer showing them: an `src` or a CSS
 * `url()` with a web address, which is what `images` lets load. It may be wrong either way; the
 * policy decides what loads. Each run of spaces or quotes is read once, so a mail made of them
 * can't make this slow.
 */
export function mayLoadImages(html: string): boolean {
	return /(?:\bsrc\s*=|\burl\()[\s"']*(?:https?:)?\/\//i.test(html.slice(0, MAX_SHOWN_HTML));
}

/** A part the HTML may name by `cid:`, before it is made a `data:` address. */
interface InlinePart {
	type: string;
	bytes: Uint8Array;
}

/** The message's parts that may show as images, by their Content-ID. */
function inlineParts(attachments: Attachment[]): Map<string, InlinePart> {
	const found = new Map<string, InlinePart>();
	for (const attachment of attachments) {
		const type = attachment.mimeType === "image/jpg" ? "image/jpeg" : attachment.mimeType;
		if (!attachment.contentId || !INLINE_TYPES.has(type)) continue;
		if (typeof attachment.content === "string") continue;
		const bytes =
			attachment.content instanceof Uint8Array
				? attachment.content
				: new Uint8Array(attachment.content);
		const id = attachment.contentId.trim().replace(/^<(.*)>$/, "$1");
		if (!found.has(id)) found.set(id, { type, bytes });
	}
	return found;
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let start = 0; start < bytes.length; start += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
	}
	return btoa(binary);
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The few entities a Content-ID in an attribute is likely to be written with. */
function decodeEntities(value: string): string {
	return value.replace(
		/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|lt|gt|quot|apos));/gi,
		(whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
			if (name) return NAMED[name.toLowerCase()] ?? whole;
			const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
			return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		},
	);
}

function contentId(src: string): string {
	const id = decodeEntities(src.trim().slice("cid:".length));
	try {
		return decodeURIComponent(id);
	} catch {
		return id;
	}
}

/**
 * The cleaned HTML of a message, at most `MAX_SHOWN_HTML` characters of it. Remote images keep their
 * addresses only when `images` is true.
 *
 * Nothing is added after the message's own HTML: HTMLRewriter passes a tag that the end of its input
 * leaves open as it is, unread, and anything after it would close that tag. At the end of the page,
 * a browser drops it.
 */
export async function cleanHtml(
	html: string,
	attachments: Attachment[],
	{ images }: { images: boolean },
): Promise<string> {
	const parts = inlineParts(attachments);
	const made = new Map<string, string>();
	// Counted at every image that uses one, since each puts the whole address in the page.
	let inlineLeft = MAX_INLINE_IMAGES;
	const inlineImage = (id: string): string | null => {
		const part = parts.get(id);
		if (!part) return null;
		const length = `data:${part.type};base64,`.length + Math.ceil(part.bytes.length / 3) * 4;
		if (length > inlineLeft) return null;
		inlineLeft -= length;
		let address = made.get(id);
		if (!address) {
			address = `data:${part.type};base64,${base64(part.bytes)}`;
			made.set(id, address);
		}
		return address;
	};
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
						const found = inlineImage(contentId(src));
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
	const cleaned = await rewriter
		.transform(
			new Response(html.slice(0, MAX_SHOWN_HTML), {
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		)
		.text();
	return `<!doctype html><meta charset="utf-8"><style>${FRAME_STYLE}</style>${cleaned}`;
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
