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
 * is, until the mailbox's alarm seals it (`resealing.ts`). A seal names the key it was made with
 * (`v2.<key id>.<salt>`), so mail sealed under the key before the current one opens with
 * `SECRETS_KEY_PREVIOUS`. A seal from before keys had ids (`v1.<salt>`) opens with either, the
 * current key tried first. Mail under a key the deployment no longer has is lost.
 */
import { fromBase64, toBase64 } from "../base64";
import {
	canSealWith,
	keysFor,
	type SecretsKey,
	type SecretsKeySettings,
	secretsKeys,
} from "../secrets-key";

/** How much of a message each sealed chunk holds. */
export const SEALED_CHUNK = 64 * 1024;
/** What AES-GCM adds to each chunk. */
const TAG = 16;
const STRIDE = SEALED_CHUNK + TAG;
const SALT_BYTES = 16;
const INFO = "gateweave-mail/raw-mail/v1 ";
const LAST = Uint8Array.of(1);
const NOT_LAST = Uint8Array.of(0);

/** What a message's row knows of its raw mail. A type, so the object's SQL rows can be one. */
export type RawRef = {
	object: string;
	/** The mail's own size, in bytes. */
	size: number;
	/**
	 * Null for mail kept as it came. A row from an object older than sealing, during a deploy, has
	 * none at all, which reads the same.
	 */
	seal: string | null;
};

/**
 * Sealed mail that doesn't open. `no-key`: the server has no `SECRETS_KEY` to open it with, which
 * setting one may mend, so what reads it may try again. `unopened`: it was changed, cut or moved,
 * or neither the server's `SECRETS_KEY` nor its `SECRETS_KEY_PREVIOUS` is the one it was sealed
 * with, which trying again won't mend. Its message says which, and never anything of the mail.
 */
export class SealError extends Error {
	override name = "SealError";
	readonly kind: "no-key" | "unopened";

	constructor(message: string, kind: "no-key" | "unopened" = "unopened") {
		super(message);
		this.kind = kind;
	}
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

/** A seal's parts: the id of the key it was made with, null for seals from before ids, and its salt. */
function parsed(seal: string): { id: string | null; salt: Uint8Array<ArrayBuffer> } {
	const parts = seal.split(".");
	const [version] = parts;
	const [id, salt] =
		version === "v2" && parts.length === 3
			? [parts[1] ?? "", parts[2]]
			: version === "v1" && parts.length === 2
				? [null, parts[1]]
				: [];
	const saltBytes = salt ? fromBase64(salt) : null;
	if (id === "" || !saltBytes || saltBytes.length !== SALT_BYTES) {
		throw new SealError("This mail's seal is of no kind this server knows");
	}
	return { id: id ?? null, salt: saltBytes };
}

/** One object's own key, from one of the deployment's keys. */
function objectKey(
	key: SecretsKey,
	object: string,
	salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(INFO + object) },
		key.hkdf,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** The keys an object may open with, the likeliest first: one, unless its seal names none. */
async function openingKeys(
	settings: SecretsKeySettings,
	object: string,
	seal: string,
): Promise<CryptoKey[]> {
	const keys = await secretsKeys(settings);
	if (!keys.current && !keys.previous) {
		throw new SealError(
			"This mail is sealed, and the server has no SECRETS_KEY to open it",
			"no-key",
		);
	}
	const { id, salt } = parsed(seal);
	const found = keysFor(keys, id);
	if (found.length === 0) {
		throw new SealError("This mail is sealed under a SECRETS_KEY this server doesn't have");
	}
	return Promise.all(found.map((key) => objectKey(key, object, salt)));
}

/** The key new mail is sealed with: the current one, which its seal must name. */
async function sealingKey(
	settings: SecretsKeySettings,
	object: string,
	seal: string,
): Promise<CryptoKey> {
	const { current } = await secretsKeys(settings);
	if (!current) {
		throw new SealError("This mail is to be sealed, and the server has no SECRETS_KEY", "no-key");
	}
	const { id, salt } = parsed(seal);
	if (id !== current.id) throw new Error("New mail is sealed only under the current SECRETS_KEY");
	return objectKey(current, object, salt);
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

/**
 * The stream, with its first part already read, so that mail which doesn't open at all fails
 * before a response has begun, rather than as a download cut short.
 */
async function started(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
	const reader = body.getReader();
	let first: ReadableStreamReadResult<Uint8Array> | null = await reader.read();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = first ?? (await reader.read());
			first = null;
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
		cancel: (reason) => reader.cancel(reason),
	});
}

/** Said once an isolate, as each delivery would say it again. */
let warned = false;

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
	readonly #keys: SecretsKeySettings;

	constructor(bucket: R2Bucket, keys: SecretsKeySettings) {
		this.#bucket = bucket;
		this.#keys = keys;
	}

	/**
	 * A seal for mail about to be written, which its row keeps, or null when this server keeps mail
	 * as it comes, having no `SECRETS_KEY` long enough to seal with.
	 */
	async newSeal(): Promise<string | null> {
		const { current } = await secretsKeys(this.#keys);
		if (!current) {
			if (this.#keys.SECRETS_KEY && !warned) {
				warned = true;
				console.warn(
					"raw mail: SECRETS_KEY isn't 32 or more bytes of base64, so mail is kept unencrypted",
				);
			}
			return null;
		}
		return `v2.${current.id}.${toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)))}`;
	}

	/** Whether this server has a `SECRETS_KEY` long enough to seal with. */
	canSeal(): boolean {
		return canSealWith(this.#keys);
	}

	/**
	 * Writes a sealed copy of mail kept as it came, under `object`, and gives the seal its row must
	 * take to read it. The original is left as it is. The copy is read back at its start before this
	 * returns, so a row never names an object that doesn't open. Null when this server can't seal.
	 * Throws a `SealError` when the original is missing or isn't the size its row says, which
	 * trying again won't mend; any other error is R2's, and may be tried again.
	 */
	async sealedCopy(from: RawRef, object: string): Promise<string | null> {
		if (typeof from.seal === "string") throw new Error("This mail is already sealed");
		const seal = await this.newSeal();
		if (seal === null) return null;
		const found = await this.get(from);
		if (!found) throw new SealError("Stored mail is missing");
		if (found.size !== from.size) {
			await found.body.cancel().catch(() => {});
			throw new SealError("Stored mail isn't as long as its message");
		}
		const copy = { object, size: from.size, seal };
		await this.put(copy, found.body);
		const check = await this.get(copy);
		if (!check) throw new Error("The sealed copy isn't in R2");
		await check.body.cancel().catch(() => {});
		return seal;
	}

	/** Writes a message's mail, which must be exactly `ref.size` bytes, sealed when it has a seal. */
	async put(ref: RawRef, mail: ReadableStream<Uint8Array> | string): Promise<void> {
		if (typeof ref.seal !== "string") {
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
		let key: CryptoKey;
		try {
			key = await sealingKey(this.#keys, ref.object, ref.seal);
		} catch (error) {
			if (typeof mail !== "string") await mail.cancel().catch(() => {});
			throw error;
		}
		const stream = typeof mail === "string" ? new Blob([mail]).stream() : mail;
		const sized = new FixedLengthStream(sealedSize(ref.size));
		await Promise.all([
			this.#bucket.put(ref.object, sized.readable),
			stream.pipeThrough(sealing(key, ref.size)).pipeTo(sized.writable),
		]);
	}

	/**
	 * A message's mail, or the part of it `range` names, as it was written, and the whole mail's
	 * size. Null when R2 doesn't have it. Sealed mail that doesn't open throws a `SealError`: under
	 * another key, or changed at its start, before anything is returned; changed further on, by
	 * erroring the stream there. Mail whose seal names no key is opened with each key in turn, read
	 * from R2 again when the first doesn't open it.
	 */
	async get(
		ref: RawRef,
		range?: RawRange,
	): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
		if (typeof ref.seal !== "string") {
			const object = await this.#bucket.get(ref.object, range ? { range } : undefined);
			return object && { body: object.body, size: object.size };
		}
		const keys = await openingKeys(this.#keys, ref.object, ref.seal);
		const count = chunkCount(ref.size);
		const start = Math.min(range?.offset ?? 0, ref.size);
		const end = range ? Math.min(ref.size, start + range.length) : ref.size;
		const first = Math.min(Math.floor(start / SEALED_CHUNK), count - 1);
		const last = Math.max(first, Math.min(Math.ceil(end / SEALED_CHUNK) - 1, count - 1));
		const whole = first === 0 && last === count - 1;
		const offset = first * STRIDE;
		const length = Math.min(sealedSize(ref.size), (last + 1) * STRIDE) - offset;
		for (const [at, key] of keys.entries()) {
			const object = await this.#bucket.get(
				ref.object,
				whole ? undefined : { range: { offset, length } },
			);
			if (!object) return null;
			if (object.size !== sealedSize(ref.size)) {
				await object.body.cancel().catch(() => {});
				throw new SealError("Stored mail isn't as long as its message");
			}
			try {
				return {
					body: await started(
						object.body.pipeThrough(opening(key, ref.size, { first, last, start, end })),
					),
					size: ref.size,
				};
			} catch (error) {
				// Its first chunk didn't open under this key: the next may be the one it was sealed with.
				if (!(error instanceof SealError) || at === keys.length - 1) throw error;
			}
		}
		throw new SealError("This mail is sealed under a SECRETS_KEY this server doesn't have");
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
export const rawMail = (env: { RAW_MAIL: R2Bucket } & SecretsKeySettings) =>
	new RawMail(env.RAW_MAIL, env);
