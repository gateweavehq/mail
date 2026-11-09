import { headerEnd } from "./headers";
import { type RawMail, type RawRef, SealError } from "./sealed";

// The pages need the DOM's `Crypto` type, which doesn't know the Workers runtime's addition to it.
const { DigestStream: Digest } = crypto as Crypto & { DigestStream: typeof DigestStream };

const hex = (bytes: ArrayBuffer) =>
	[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Passes on what follows a message's header block and drops the block. Only the header block is
 * looked through; the body passes as it comes. A message with no empty line has no body.
 */
export function afterHeaders(): TransformStream<Uint8Array, Uint8Array> {
	let tail = new Uint8Array(0);
	let inBody = false;
	return new TransformStream({
		transform(chunk, controller) {
			if (inBody) {
				controller.enqueue(chunk);
				return;
			}
			// The empty line may straddle two chunks, so the last bytes of the one before come along.
			const joined = new Uint8Array(tail.length + chunk.length);
			joined.set(tail);
			joined.set(chunk, tail.length);
			const end = headerEnd(joined);
			if (end === -1) {
				tail = joined.slice(-2);
				return;
			}
			inBody = true;
			const start = end + (joined[end] === 0x0d ? 2 : 1);
			if (start < joined.length) controller.enqueue(joined.subarray(start));
		},
	});
}

/**
 * SHA-256 of a stored message's body as it was written, in hex, so sealed mail and mail kept as it
 * came compare alike. Null when the object isn't there, or doesn't open.
 */
export async function bodyHash(raw: RawMail, ref: RawRef): Promise<string | null> {
	try {
		const object = await raw.get(ref);
		if (!object) return null;
		const digest = new Digest("SHA-256");
		await object.body.pipeThrough(afterHeaders()).pipeTo(digest);
		return hex(await digest.digest);
	} catch (error) {
		if (error instanceof SealError) return null;
		throw error;
	}
}
