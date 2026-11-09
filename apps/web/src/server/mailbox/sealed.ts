/**
 * Raw mail as R2 keeps it: sealed, when the deployment has a `SECRETS_KEY`, so that the bucket alone
 * gives nobody anyone's mail. Each message is encrypted with AES-256-GCM under its own key, which
 * HKDF derives from `SECRETS_KEY`, a random salt kept in the message's row (its `seal`), and the
 * object's name, which holds the workspace's and the mailbox's ids. An object copied or moved to
 * another's name doesn't open there, and neither does one put back from another message.
 *
 * The mail is sealed in chunks of 64 KiB, each with its own tag, so that it streams in and out
 * without being held whole, and a part of it can be read without the rest, as search reads a
 * message's start. A chunk's nonce is its place, and the last one says it is last, so chunks can't
 * be reordered, dropped or cut off unnoticed. The row's size, the mail's own, says how many there
 * are, and the object must be exactly as long as they make it.
 *
 * Mail kept before this, or by a deployment without a `SECRETS_KEY`, has no seal and is read as it
 * is. Sealed mail is lost when `SECRETS_KEY` changes. A seal starts with its version, so another
 * scheme, or a second key for rotation, can sit beside this one.
 */
import { fromBase64, toBase64 } from "../secrets";

/** How much of a message each sealed chunk holds. */
export const SEALED_CHUNK = 64 * 1024;
/** What AES-GCM adds to each chunk. */
const TAG = 16;
const STRIDE = SEALED_CHUNK + TAG;
const VERSION = "v1";
const SALT_BYTES = 16;
const MIN_KEY_BYTES = 32;
const INFO = "gateweave-mail/raw-mail/v1 ";
const LAST = Uint8Array.of(1);
const NOT_LAST = Uint8Array.of(0);

/** What a message's row knows of its raw mail. A type, so the object's SQL rows can be one. */
export type RawRef = {
	object: string;
	/** The mail's own size, in bytes. */
	size: number;
	/** Null for mail kept as it came. */
	seal: string | null;
};

/**
 * Sealed mail that doesn't open: it was changed, cut or moved, or the server's `SECRETS_KEY` isn't
 * the one it was sealed with. Its message says which, and never anything of the mail.
 */
export class SealError extends Error {
	override name = "SealError";
}

const chunkCount = (size: number) => Math.max(1, Math.ceil(size / SEALED_CHUNK));

/** How long the object for mail of `size` bytes is once sealed. */
export const sealedSize = (size: number) => size + TAG * chunkCount(size);

/** A chunk's nonce: its place in the mail. Each object has its own key, so none repeats. */
function nonce(index: number): Uint8Array<ArrayBuffer> {
	const iv = new Uint8Array(12);
	new DataView(iv.buffer).setUint32(8, index);
	return iv;
}

/** The bytes of a `SECRETS_KEY` long enough to seal with, or null. */
function usable(secretsKey: string | undefined): Uint8Array<ArrayBuffer> | null {
	const bytes = secretsKey ? fromBase64(secretsKey) : null;
	return bytes && bytes.length >= MIN_KEY_BYTES ? bytes : null;
}

/** The HKDF key for the deployment's `SECRETS_KEY`, made once for the isolate. */
let base: { secretsKey: string; key: Promise<CryptoKey> } | null = null;

function baseKey(secretsKey: string | undefined): Promise<CryptoKey> | null {
	if (!secretsKey) return null;
	if (base?.secretsKey !== secretsKey) {
		const bytes = usable(secretsKey);
		if (!bytes) return null;
		base = {
			secretsKey,
			key: crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]),
		};
	}
	return base.key;
}

/** The key one object is sealed with. */
async function objectKey(
	secretsKey: string | undefined,
	object: string,
	seal: string,
): Promise<CryptoKey> {
	const key = baseKey(secretsKey);
	if (!key)
		throw new SealError("This mail is sealed, and the server has no SECRETS_KEY to open it");
	const [version, salt, ...rest] = seal.split(".");
	const saltBytes = salt ? fromBase64(salt) : null;
	if (version !== VERSION || rest.length > 0 || !saltBytes || saltBytes.length !== SALT_BYTES) {
		throw new SealError("This mail's seal is of no kind this server knows");
	}
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: saltBytes,
			info: new TextEncoder().encode(INFO + object),
		},
		await key,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** Seals mail of exactly `size` bytes, chunk by chunk, as it passes. */
function sealing(key: CryptoKey, size: number): TransformStream<Uint8Array, Uint8Array> {
	const count = chunkCount(size);
	const pending = new Uint8Array(SEALED_CHUNK);
	let filled = 0;
	let index = 0;
	async function seal(controller: TransformStreamDefaultController<Uint8Array>, last: boolean) {
		// The chunk that ends the mail must be the one its size makes last, or the mail would read as
		// longer or shorter than it is.
		if (last !== (index === count - 1)) {
			throw new SealError("The mail isn't as long as it was said to be");
		}
		const sealed = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce(index), additionalData: last ? LAST : NOT_LAST },
			key,
			pending.subarray(0, filled),
		);
		controller.enqueue(new Uint8Array(sealed));
		index++;
		filled = 0;
	}
	return new TransformStream({
		async transform(chunk, controller) {
			for (let at = 0; at < chunk.length; ) {
				// A full chunk is sealed only when more comes, so that the last one is known as last.
				if (filled === SEALED_CHUNK) await seal(controller, false);
				const take = Math.min(SEALED_CHUNK - filled, chunk.length - at);
				pending.set(chunk.subarray(at, at + take), filled);
				filled += take;
				at += take;
			}
		},
		flush: (controller) => seal(controller, true),
	});
}

/**
 * Opens chunks `first` to `last` of mail of `size` bytes, as they come from R2, and passes on the
 * part of the mail from `start` to `end`.
 */
function opening(
	key: CryptoKey,
	size: number,
	{ first, last, start, end }: { first: number; last: number; start: number; end: number },
): TransformStream<Uint8Array, Uint8Array> {
	const count = chunkCount(size);
	const box = new Uint8Array(STRIDE);
	let filled = 0;
	let index = first;
	const sealedLength = (at: number) => Math.min(SEALED_CHUNK, size - at * SEALED_CHUNK) + TAG;
	async function open(controller: TransformStreamDefaultController<Uint8Array>) {
		let plain: Uint8Array;
		try {
			plain = new Uint8Array(
				await crypto.subtle.decrypt(
					{
						name: "AES-GCM",
						iv: nonce(index),
						additionalData: index === count - 1 ? LAST : NOT_LAST,
					},
					key,
					box.subarray(0, filled),
				),
			);
		} catch {
			// WebCrypto's own error says nothing more.
			throw new SealError("Stored mail doesn't open: it was changed, or isn't this message's");
		}
		const from = index * SEALED_CHUNK;
		const part = plain.subarray(Math.max(0, start - from), Math.max(0, end - from));
		if (part.length > 0) controller.enqueue(part);
		index++;
		filled = 0;
	}
	return new TransformStream({
		async transform(chunk, controller) {
			for (let at = 0; at < chunk.length; ) {
				if (index > last) throw new SealError("Stored mail is longer than its message");
				const take = Math.min(sealedLength(index) - filled, chunk.length - at);
				box.set(chunk.subarray(at, at + take), filled);
				filled += take;
				at += take;
				if (filled === sealedLength(index)) await open(controller);
			}
		},
		flush() {
			if (index !== last + 1) throw new SealError("Stored mail is shorter than its message");
		},
	});
}

/** A part of a message's mail: `length` bytes from `offset`. */
export interface RawRange {
	offset: number;
	length: number;
}

/**
 * Where messages' raw mail is written and read. Everything that touches it goes through here, so
 * that sealed mail and mail kept as it came read alike.
 */
export class RawMail {
	readonly #bucket: R2Bucket;
	readonly #secretsKey: string | undefined;

	constructor(bucket: R2Bucket, secretsKey: string | undefined) {
		this.#bucket = bucket;
		this.#secretsKey = secretsKey;
	}

	/**
	 * A seal for mail about to be written, which its row keeps, or null when this server keeps mail
	 * as it comes, having no `SECRETS_KEY` long enough to seal with.
	 */
	newSeal(): string | null {
		if (!usable(this.#secretsKey)) return null;
		return `${VERSION}.${toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)))}`;
	}

	/** Writes a message's mail, which must be exactly `ref.size` bytes, sealed when it has a seal. */
	async put(ref: RawRef, mail: ReadableStream<Uint8Array> | string): Promise<void> {
		if (ref.seal === null) {
			if (typeof mail === "string") {
				await this.#bucket.put(ref.object, mail);
				return;
			}
			// R2 needs the length up front to take a stream.
			const sized = new FixedLengthStream(ref.size);
			await Promise.all([
				this.#bucket.put(ref.object, sized.readable),
				mail.pipeTo(sized.writable),
			]);
			return;
		}
		const key = await objectKey(this.#secretsKey, ref.object, ref.seal);
		const stream = typeof mail === "string" ? new Blob([mail]).stream() : mail;
		const sized = new FixedLengthStream(sealedSize(ref.size));
		await Promise.all([
			this.#bucket.put(ref.object, sized.readable),
			stream.pipeThrough(sealing(key, ref.size)).pipeTo(sized.writable),
		]);
	}

	/**
	 * A message's mail, or the part of it `range` names, as it was written, and the whole mail's
	 * size. Null when R2 doesn't have it. Sealed mail that doesn't open throws a `SealError`, or
	 * errors the stream with one when that shows only as it is read.
	 */
	async get(
		ref: RawRef,
		range?: RawRange,
	): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
		if (ref.seal === null) {
			const object = await this.#bucket.get(ref.object, range ? { range } : undefined);
			return object && { body: object.body, size: object.size };
		}
		const key = await objectKey(this.#secretsKey, ref.object, ref.seal);
		const count = chunkCount(ref.size);
		const start = Math.min(range?.offset ?? 0, ref.size);
		const end = range ? Math.min(ref.size, start + range.length) : ref.size;
		const first = Math.min(Math.floor(start / SEALED_CHUNK), count - 1);
		const last = Math.max(first, Math.min(Math.ceil(end / SEALED_CHUNK) - 1, count - 1));
		const whole = first === 0 && last === count - 1;
		const offset = first * STRIDE;
		const object = await this.#bucket.get(
			ref.object,
			whole
				? undefined
				: {
						range: { offset, length: Math.min(sealedSize(ref.size), (last + 1) * STRIDE) - offset },
					},
		);
		if (!object) return null;
		if (object.size !== sealedSize(ref.size)) {
			await object.body.cancel().catch(() => {});
			throw new SealError("Stored mail isn't as long as its message");
		}
		return {
			body: object.body.pipeThrough(opening(key, ref.size, { first, last, start, end })),
			size: ref.size,
		};
	}

	/** Like `get`, all read. Read here rather than by a `Response`, so a `SealError` stays one. */
	async bytes(ref: RawRef, range?: RawRange): Promise<Uint8Array<ArrayBuffer> | null> {
		const found = await this.get(ref, range);
		if (!found) return null;
		const parts: Uint8Array[] = [];
		let length = 0;
		const reader = found.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
			length += value.length;
		}
		const all = new Uint8Array(length);
		let at = 0;
		for (const part of parts) {
			all.set(part, at);
			at += part.length;
		}
		return all;
	}
}

/** The deployment's raw mail. */
export const rawMail = (env: { RAW_MAIL: R2Bucket; SECRETS_KEY?: string }) =>
	new RawMail(env.RAW_MAIL, env.SECRETS_KEY);
