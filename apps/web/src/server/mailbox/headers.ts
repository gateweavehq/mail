/**
 * A message's header block, read from the raw message as it arrives.
 *
 * `message.headers` in `email()` joins every copy of a header with ", ", so a sender's own
 * `Authentication-Results` would come along in the same string as Cloudflare's. Reading the block
 * keeps the order, and Cloudflare puts what it adds above everything the sender wrote.
 */

/** The most of a message's start that is read for its headers. */
export const HEADER_BLOCK_LIMIT = 256 * 1024;

/** The longest header value kept for a message's listing. */
export const MAX_KEPT_HEADER = 2_000;

export interface Header {
	/** Lowercase. */
	name: string;
	/** Unfolded and trimmed, otherwise as sent. */
	value: string;
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
		headers.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1) });
	}
	for (const header of headers) header.value = header.value.trim();
	return headers;
}

/** The first value of a header, cut to what a listing keeps, or null when there is none. */
export function firstHeader(headers: Header[], name: string): string | null {
	const value = headers.find((header) => header.name === name)?.value;
	return value === undefined ? null : value.slice(0, MAX_KEPT_HEADER);
}

/** What Cloudflare adds above a message before it reaches the Worker. */
const ADDED_BY_CLOUDFLARE = new Set([
	"arc-seal",
	"arc-message-signature",
	"arc-authentication-results",
	"received-spf",
	"authentication-results",
]);

/**
 * Cloudflare's DMARC verdict on a message, such as "pass", "fail" or "none", or null when it can't
 * be told. Only Cloudflare's own `Authentication-Results` counts: the first one, among the fields
 * Cloudflare adds above its `Received`, from `mx.cloudflare.net`. Anything else is the sender's to
 * write. When the message doesn't start the way Cloudflare's do, nothing is trusted.
 */
export function cloudflareDmarc(headers: Header[]): string | null {
	const [received, ...rest] = headers;
	if (received?.name !== "received" || !/\bby cloudflare-email\.net\b/i.test(received.value)) {
		return null;
	}
	for (const header of rest) {
		if (header.name === "authentication-results") {
			if (!/^mx\.cloudflare\.net\s*;/i.test(header.value)) return null;
			const verdict = /(?:^|;)\s*dmarc\s*=\s*([a-z]+)/i.exec(header.value);
			return verdict?.[1]?.toLowerCase() ?? null;
		}
		if (!ADDED_BY_CLOUDFLARE.has(header.name) && !header.name.startsWith("x-cf-")) return null;
	}
	return null;
}

/**
 * What tells two deliveries of one message apart from two messages: the mailbox and the sender's
 * `Message-ID`, `From`, `Date` and `Subject`. A retry brings different raw bytes, as Cloudflare
 * signs each delivery anew, so the raw message can't be the key. Null without a `Message-ID`.
 */
export async function deliveryKey(mailboxId: string, headers: Header[]): Promise<string | null> {
	const messageId = firstHeader(headers, "message-id");
	if (!messageId) return null;
	const parts = [
		mailboxId,
		messageId,
		...["from", "date", "subject"].map((n) => firstHeader(headers, n)),
	];
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(parts)),
	);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
