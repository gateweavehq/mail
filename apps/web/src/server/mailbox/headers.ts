/**
 * A message's header block, read from the raw message as it arrives.
 *
 * `message.headers` in `email()` joins every copy of a header with ", ", so a sender's own
 * `Authentication-Results` would come along in the same string as Cloudflare's. Reading the block
 * keeps the order, and Cloudflare puts what it adds above everything the sender wrote.
 */
import { addressParser } from "postal-mime";

/** The most of a message's start that is read for its headers. */
export const HEADER_BLOCK_LIMIT = 256 * 1024;

/** The longest header value kept for a message's listing. */
export const MAX_KEPT_HEADER = 2_000;

export interface Header {
	/** Lowercase. */
	name: string;
	/** Unfolded and trimmed, otherwise as sent. */
	value: string;
	/**
	 * The name is written as the standard says, with nothing but printable ASCII. Programs differ on
	 * what a name such as `From ` with a space means, so such a field is never trusted.
	 */
	strict: boolean;
}

/**
 * Where the header block ends: the index of the empty line that follows it, or -1 when there is
 * none in these bytes. A bare LF is taken as a line end too, as some senders use one.
 */
export function headerEnd(bytes: Uint8Array): number {
	for (let i = 0; i < bytes.length - 1; i++) {
		if (bytes[i] !== 0x0a) continue;
		if (bytes[i + 1] === 0x0a) return i + 1;
		if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) return i + 1;
	}
	return -1;
}

/**
 * Reads the header block from the start of a message, and stops reading there. A message with no
 * empty line in its first `HEADER_BLOCK_LIMIT` bytes gets those bytes as its headers.
 */
export async function readHeaderBlock(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	let bytes = new Uint8Array(0);
	let end = -1;
	try {
		while (bytes.length < HEADER_BLOCK_LIMIT) {
			const { done, value } = await reader.read();
			if (done) break;
			const joined = new Uint8Array(bytes.length + value.length);
			joined.set(bytes);
			joined.set(value, bytes.length);
			// The empty line may straddle two chunks, so look again from a little before the new one.
			const from = Math.max(0, bytes.length - 2);
			bytes = joined;
			const found = headerEnd(bytes.subarray(from));
			if (found !== -1) {
				end = from + found;
				break;
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const block = bytes.subarray(0, end === -1 ? Math.min(bytes.length, HEADER_BLOCK_LIMIT) : end);
	return new TextDecoder().decode(block);
}

/** The header block's fields, in order, with folded lines joined. */
export function parseHeaders(block: string): Header[] {
	const headers: Header[] = [];
	for (const line of block.split(/\r?\n/)) {
		const last = headers.at(-1);
		if (/^[ \t]/.test(line)) {
			if (last) last.value = `${last.value} ${line.trim()}`;
			continue;
		}
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const name = line.slice(0, colon);
		headers.push({
			name: name.trim().toLowerCase(),
			value: line.slice(colon + 1),
			strict: /^[\x21-\x39\x3b-\x7e]+$/.test(name),
		});
	}
	for (const header of headers) header.value = header.value.trim();
	return headers;
}

/** The first value of a header, cut to what a listing keeps, or null when there is none. */
export function firstHeader(headers: Header[], name: string): string | null {
	const value = headers.find((header) => header.name === name)?.value;
	return value === undefined ? null : value.slice(0, MAX_KEPT_HEADER);
}

/** What Cloudflare adds above a message before it reaches the Worker, in the order it adds them. */
const ADDED_BY_CLOUDFLARE = [
	"arc-seal",
	"arc-message-signature",
	"arc-authentication-results",
	"received-spf",
	"authentication-results",
];

/** Cloudflare's DMARC check of a message. */
export interface Verdict {
	/** Such as "pass", "fail" or "none". */
	dmarc: string;
	/** The From domain it checked, in lower case, or null when it didn't say. */
	fromDomain: string | null;
}

/**
 * Cloudflare's DMARC verdict on a message, or null when it can't be told. Only Cloudflare's own
 * `Authentication-Results` counts: the one among the fields Cloudflare adds above its `Received`,
 * from `mx.cloudflare.net`. Cloudflare adds each of those once and in one order, so a field out of
 * that order is the sender's, and so is everything after it. When the message doesn't start the
 * way Cloudflare's do, nothing is trusted.
 */
export function cloudflareVerdict(headers: Header[]): Verdict | null {
	const [received, ...rest] = headers;
	if (
		!received?.strict ||
		received.name !== "received" ||
		!/\bby cloudflare-email\.net\b/i.test(received.value)
	) {
		return null;
	}
	let at = -1;
	for (const header of rest) {
		const place = header.strict ? ADDED_BY_CLOUDFLARE.indexOf(header.name) : -1;
		if (place <= at) return null;
		at = place;
		if (header.name === "authentication-results") return verdictIn(header.value);
	}
	return null;
}

/** The DMARC result in an `Authentication-Results` value from Cloudflare. */
function verdictIn(value: string): Verdict | null {
	const [server, ...results] = resultParts(value);
	if (!server || !/^mx\.cloudflare\.net(?:\s+\d+)?$/i.test(server)) return null;
	const dmarc = results.filter((part) => /^dmarc\s*=/i.test(part));
	// One message gets one DMARC check. A second can only have come from something the sender wrote.
	const [only] = dmarc;
	if (dmarc.length !== 1 || !only) return null;
	const result = /^dmarc\s*=\s*([a-z]+)(?:\s|$)/i.exec(only);
	if (!result?.[1]) return null;
	const domain = /(?:^|\s)header\.from\s*=\s*("[^"]*"|[^\s"]+)/i.exec(only)?.[1];
	return {
		dmarc: result[1].toLowerCase(),
		fromDomain: domain ? normalDomain(domain.replace(/^"|"$/g, "")) : null,
	};
}

/**
 * An `Authentication-Results` value cut at its semicolons, with its comments left out. A
 * semicolon inside a quoted string or a comment doesn't cut, as Cloudflare's comments quote the
 * envelope sender, which the sender chooses. Nothing comes back when the brackets or quotes don't
 * close.
 */
function resultParts(value: string): string[] {
	const parts: string[] = [];
	let part = "";
	let depth = 0;
	let quoted = false;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === "\\" && (depth > 0 || quoted)) {
			if (quoted) part += value.slice(i, i + 2);
			i++;
		} else if (depth > 0) {
			if (char === "(") depth++;
			else if (char === ")") depth--;
		} else if (quoted) {
			part += char;
			if (char === '"') quoted = false;
		} else if (char === '"') {
			quoted = true;
			part += char;
		} else if (char === "(") {
			depth = 1;
			part += " ";
		} else if (char === ";") {
			parts.push(part.trim());
			part = "";
		} else {
			part += char;
		}
	}
	if (depth > 0 || quoted) return [];
	parts.push(part.trim());
	return parts;
}

const normalDomain = (domain: string) => domain.trim().toLowerCase().replace(/\.$/, "");

/**
 * The domain of the one address in the one `From`, which is the address a page shows, or null when
 * there isn't exactly one. A field whose name only looks like `From` counts as a second one:
 * programs differ on such names, and a checker may have read it instead.
 */
export function soleFromDomain(headers: Header[]): string | null {
	const froms = headers.filter((header) => header.name.replace(/[^a-z]/g, "") === "from");
	const [from] = froms;
	if (froms.length !== 1 || !from?.strict || from.name !== "from") return null;
	let senders: ReturnType<typeof addressParser>;
	try {
		senders = addressParser(from.value);
	} catch {
		return null;
	}
	const [sender] = senders;
	if (senders.length !== 1 || !sender || sender.group || !sender.address) return null;
	const at = sender.address.lastIndexOf("@");
	if (at <= 0) return null;
	return normalDomain(sender.address.slice(at + 1));
}

/**
 * The domain a message is proved to come from, or null. That is when Cloudflare's DMARC check
 * passed for the domain of the one address in the one `From`.
 */
export function verifiedDomain(headers: Header[], verdict: Verdict | null): string | null {
	if (verdict?.dmarc !== "pass" || !verdict.fromDomain) return null;
	const domain = soleFromDomain(headers);
	return domain === verdict.fromDomain ? domain : null;
}

/**
 * The same for mail that came through Resend, whose DMARC result comes from its API rather than
 * from a header. DMARC checks the domain of `From`, and with only one address there, that is the
 * domain it passed.
 */
export function resendVerifiedDomain(headers: Header[], dmarc: string | null): string | null {
	return dmarc === "pass" ? soleFromDomain(headers) : null;
}

/**
 * What tells two deliveries of one message apart from two messages: the mailbox and the sender's
 * `Message-ID`, `From`, `Date` and `Subject`, whichever of them it has. A retry brings different
 * raw bytes, as Cloudflare signs each delivery anew, so the raw message can't be the key. Messages
 * that share a key are told apart by their bodies.
 */
export async function deliveryKey(mailboxId: string, headers: Header[]): Promise<string> {
	const parts = [
		mailboxId,
		...["message-id", "from", "date", "subject"].map((name) => firstHeader(headers, name)),
	];
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(parts)),
	);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
