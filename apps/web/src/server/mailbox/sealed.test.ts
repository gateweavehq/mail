import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { RawMail, type RawRef, SEALED_CHUNK, SealError, sealedSize } from "./sealed";

// Node has no FixedLengthStream. This one counts what passes, as workerd's does.
class FixedLength extends TransformStream<Uint8Array, Uint8Array> {
	constructor(expected: number) {
		let seen = 0;
		super({
			transform(chunk, controller) {
				seen += chunk.length;
				if (seen > expected) throw new Error("More than the stream's length");
				controller.enqueue(chunk);
			},
			flush() {
				if (seen !== expected) throw new Error("Less than the stream's length");
			},
		});
	}
}

beforeAll(() => {
	const global = globalThis as { FixedLengthStream?: unknown };
	global.FixedLengthStream ??= FixedLength;
});

const KEY = randomBytes(32).toString("base64");
const STRIDE = SEALED_CHUNK + 16;

/** An R2 bucket in memory, as far as raw mail goes, which notes the ranges it was asked for. */
function memoryBucket() {
	const objects = new Map<string, Uint8Array>();
	const asked: ({ offset: number; length: number } | "whole")[] = [];
	const bucket = {
		async put(key: string, value: ReadableStream<Uint8Array> | string) {
			objects.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
		},
		async get(key: string, options?: { range?: { offset: number; length: number } }) {
			const bytes = objects.get(key);
			if (!bytes) return null;
			asked.push(options?.range ?? "whole");
			const { offset, length } = options?.range ?? { offset: 0, length: bytes.length };
			return {
				size: bytes.length,
				body: new Blob([bytes.slice(offset, offset + length)]).stream(),
			};
		},
	};
	return { objects, asked, bucket: bucket as unknown as R2Bucket };
}

/** Mail of `size` bytes, written in pieces of `piece`, so they straddle the chunks. */
function pieces(bytes: Uint8Array, piece: number): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream({
		pull(controller) {
			if (at >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(at, at + piece));
			at += piece;
		},
	});
}

const text = (bytes: Uint8Array | null) => Buffer.from(bytes ?? []).toString("latin1");

async function sealedMail(size: number, object = "w/m/a.eml") {
	const store = memoryBucket();
	const raw = new RawMail(store.bucket, { SECRETS_KEY: KEY });
	const mail = new Uint8Array(randomBytes(size));
	const ref: RawRef = { object, size, seal: await raw.newSeal() };
	await raw.put(ref, pieces(mail, 1000));
	return { ...store, raw, mail, ref };
}

describe("sealed raw mail", () => {
	it("keeps none of the mail in the bucket, and reads it back byte for byte", async () => {
		const store = memoryBucket();
		const raw = new RawMail(store.bucket, { SECRETS_KEY: KEY });
		const mail = "From: a@example.org\r\nSubject: The quarterly numbers\r\n\r\nThey are good.\r\n";
		const ref: RawRef = { object: "w/m/a.eml", size: mail.length, seal: await raw.newSeal() };
		expect(ref.seal).toMatch(/^v2\.[\w-]{11}\.[\w-]{22}$/);
		await raw.put(ref, mail);
		const stored = store.objects.get(ref.object);
		expect(stored?.length).toBe(sealedSize(mail.length));
		expect(text(stored ?? null)).not.toContain("quarterly");
		expect(text(await raw.bytes(ref))).toBe(mail);
	});

	it("reads mail of any size, across the chunks' edges", async () => {
		for (const size of [
			0,
			1,
			SEALED_CHUNK - 1,
			SEALED_CHUNK,
			SEALED_CHUNK + 1,
			3 * SEALED_CHUNK + 5,
		]) {
			const { raw, ref, mail, objects } = await sealedMail(size);
			expect(objects.get(ref.object)?.length).toBe(sealedSize(size));
			expect(await raw.bytes(ref)).toEqual(mail);
			expect((await raw.get(ref))?.size).toBe(size);
		}
	});

	it("reads a part of the mail from only the chunks that hold it", async () => {
		const size = 3 * SEALED_CHUNK + SEALED_CHUNK / 2;
		const { raw, ref, mail, asked } = await sealedMail(size);
		const parts = [
			{ offset: 0, length: 10 },
			{ offset: SEALED_CHUNK - 5, length: 10 },
			{ offset: SEALED_CHUNK, length: SEALED_CHUNK },
			{ offset: size - 3, length: 100 },
			{ offset: size + 10, length: 5 },
		];
		for (const part of parts) {
			expect(await raw.bytes(ref, part)).toEqual(
				mail.slice(part.offset, part.offset + part.length),
			);
		}
		expect(asked).toEqual([
			{ offset: 0, length: STRIDE },
			{ offset: 0, length: 2 * STRIDE },
			{ offset: STRIDE, length: STRIDE },
			{ offset: 3 * STRIDE, length: SEALED_CHUNK / 2 + 16 },
			{ offset: 3 * STRIDE, length: SEALED_CHUNK / 2 + 16 },
		]);
		expect(await raw.bytes(ref, { offset: 0, length: size })).toEqual(mail);
		expect(asked.at(-1)).toBe("whole");
	});

	it("doesn't open mail that was changed", async () => {
		const { raw, ref, objects } = await sealedMail(2 * SEALED_CHUNK + 7);
		const stored = objects.get(ref.object) ?? new Uint8Array();
		stored[STRIDE + 100] = (stored[STRIDE + 100] ?? 0) ^ 1;
		await expect(raw.bytes(ref)).rejects.toThrow(SealError);
		// The chunk before the change still opens on its own.
		expect(await raw.bytes(ref, { offset: 0, length: 10 })).toHaveLength(10);
		await expect(raw.bytes(ref, { offset: SEALED_CHUNK, length: 10 })).rejects.toThrow(SealError);
		// A change past the start shows as the stream reaches it; one at the start, before anything.
		const whole = await raw.get(ref);
		await expect(new Response(whole?.body).arrayBuffer()).rejects.toThrow();
		stored[3] = (stored[3] ?? 0) ^ 1;
		await expect(raw.get(ref)).rejects.toThrow(SealError);
	});

	it("doesn't open chunks put in another order, or mail cut short", async () => {
		const { raw, ref, objects } = await sealedMail(3 * SEALED_CHUNK);
		const stored = objects.get(ref.object) ?? new Uint8Array();
		const swapped = new Uint8Array(stored);
		swapped.set(stored.subarray(STRIDE, 2 * STRIDE), 0);
		swapped.set(stored.subarray(0, STRIDE), STRIDE);
		objects.set(ref.object, swapped);
		await expect(raw.bytes(ref)).rejects.toThrow(SealError);

		objects.set(ref.object, stored.slice(0, 2 * STRIDE));
		await expect(raw.bytes(ref)).rejects.toThrow(SealError);
		// Even with a size that has it end there: the chunk it ends with doesn't say it is last.
		await expect(raw.bytes({ ...ref, size: 2 * SEALED_CHUNK })).rejects.toThrow(SealError);
		objects.set(ref.object, new Uint8Array([...stored, 0]));
		await expect(raw.bytes(ref)).rejects.toThrow(SealError);
	});

	it("doesn't open one message's mail as another's, or under another name", async () => {
		const store = memoryBucket();
		const raw = new RawMail(store.bucket, { SECRETS_KEY: KEY });
		const mail = "From: a@example.org\r\n\r\nSame length.\r\n";
		const first: RawRef = { object: "w/m/a.eml", size: mail.length, seal: await raw.newSeal() };
		const second: RawRef = { object: "w/m/b.eml", size: mail.length, seal: await raw.newSeal() };
		await raw.put(first, mail);
		await raw.put(second, mail);
		const firstSealed = store.objects.get(first.object) ?? new Uint8Array();
		expect(store.objects.get(second.object)).not.toEqual(firstSealed);

		// Put back over another message's mail.
		store.objects.set(second.object, firstSealed);
		await expect(raw.bytes(second)).rejects.toThrow(SealError);
		// Moved to another workspace's name, its seal and all.
		store.objects.set("v/m/a.eml", firstSealed);
		await expect(raw.bytes({ ...first, object: "v/m/a.eml" })).rejects.toThrow(SealError);
		expect(text(await raw.bytes(first))).toBe(mail);
	});

	it("opens only under the SECRETS_KEY it was sealed with, and says so without one", async () => {
		const { bucket, ref } = await sealedMail(100);
		const other = new RawMail(bucket, { SECRETS_KEY: randomBytes(32).toString("base64") });
		// Before anything is returned, so a download fails rather than starts.
		const unopened = await other.get(ref).catch((error: unknown) => error);
		expect(unopened).toBeInstanceOf(SealError);
		expect((unopened as SealError).kind).toBe("unopened");
		const keyless = await new RawMail(bucket, {}).get(ref).catch((error: unknown) => error);
		expect(keyless).toBeInstanceOf(SealError);
		expect((keyless as SealError).kind).toBe("no-key");
		expect((keyless as SealError).message).toMatch(/no SECRETS_KEY/);
		await expect(
			new RawMail(bucket, { SECRETS_KEY: KEY }).get({ ...ref, seal: "v2.x" }),
		).rejects.toThrow(/no kind this server knows/);
	});

	describe("after SECRETS_KEY changes", () => {
		const NEW = randomBytes(32).toString("base64");
		/** Each read R2 is asked for, to see how many a key that doesn't open costs. */
		const counted = (bucket: R2Bucket) => {
			const reads: string[] = [];
			const wrapped = {
				get: (key: string, options?: R2GetOptions) => {
					reads.push(key);
					return bucket.get(key, options);
				},
			} as unknown as R2Bucket;
			return { reads, wrapped };
		};

		it("names the key in each seal, and opens mail under the old one with SECRETS_KEY_PREVIOUS", async () => {
			const { bucket, ref, mail } = await sealedMail(70_000);
			const rotated = new RawMail(bucket, { SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: KEY });
			expect(text(await rotated.bytes(ref))).toBe(text(mail));
			// Without the old key it is lost, which nothing can mend.
			const lost = await new RawMail(bucket, { SECRETS_KEY: NEW }).get(ref).catch((e) => e);
			expect(lost).toBeInstanceOf(SealError);
			expect((lost as SealError).kind).toBe("unopened");
			expect((lost as SealError).message).toMatch(/SECRETS_KEY this server doesn't have/);
			// New mail goes under the new key, which the seal names.
			const fresh = await rotated.newSeal();
			expect(fresh?.split(".")[1]).not.toBe(ref.seal?.split(".")[1]);
		});

		it("opens a seal from before keys had ids under either key, the current one first", async () => {
			const { bucket, ref, mail } = await sealedMail(100);
			const [, , salt] = (ref.seal ?? "").split(".");
			const old = { ...ref, seal: `v1.${salt}` };
			const same = counted(bucket);
			expect(text(await new RawMail(same.wrapped, { SECRETS_KEY: KEY }).bytes(old))).toBe(
				text(mail),
			);
			expect(same.reads).toHaveLength(1);
			// Sealed under what is now the previous key: read once with each.
			const both = counted(bucket);
			const rotated = new RawMail(both.wrapped, { SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: KEY });
			expect(text(await rotated.bytes(old))).toBe(text(mail));
			expect(both.reads).toHaveLength(2);
			// And a part of it, as search reads.
			expect(text(await rotated.bytes(old, { offset: 10, length: 20 }))).toBe(
				text(mail.subarray(10, 30)),
			);
			await expect(new RawMail(bucket, { SECRETS_KEY: NEW }).get(old)).rejects.toThrow(SealError);
		});

		it("seals new mail only under the current key", async () => {
			const store = memoryBucket();
			const before = await new RawMail(store.bucket, { SECRETS_KEY: KEY }).newSeal();
			const rotated = new RawMail(store.bucket, { SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: KEY });
			await expect(
				rotated.put({ object: "w/m/a.eml", size: 5, seal: before }, "Hello"),
			).rejects.toThrow(/only under the current SECRETS_KEY/);
			expect(store.objects.size).toBe(0);
		});

		it("takes the previous key as unset when it is the current one", async () => {
			const { bucket, ref, mail } = await sealedMail(100);
			const same = new RawMail(bucket, { SECRETS_KEY: KEY, SECRETS_KEY_PREVIOUS: KEY });
			expect(text(await same.bytes(ref))).toBe(text(mail));
			expect((await same.newSeal())?.split(".")[1]).toBe(ref.seal?.split(".")[1]);
		});
	});

	it("keeps mail as it comes without a SECRETS_KEY to seal with, and reads mail kept so", async () => {
		const store = memoryBucket();
		expect(await new RawMail(store.bucket, {}).newSeal()).toBeNull();
		expect(
			await new RawMail(store.bucket, {
				SECRETS_KEY: randomBytes(16).toString("base64"),
			}).newSeal(),
		).toBeNull();
		const plain = new RawMail(store.bucket, {});
		const mail = "From: a@example.org\r\n\r\nKept as it came.\r\n";
		const ref: RawRef = { object: "w/m/a.eml", size: mail.length, seal: null };
		await plain.put(ref, pieces(new TextEncoder().encode(mail), 7));
		expect(text(store.objects.get(ref.object) ?? null)).toBe(mail);
		// A server that seals reads what was kept before it did.
		const sealing = new RawMail(store.bucket, { SECRETS_KEY: KEY });
		expect(text(await sealing.bytes(ref))).toBe(mail);
		expect(text(await sealing.bytes(ref, { offset: 5, length: 4 }))).toBe(mail.slice(5, 9));
		// A row from an object older than sealing, during a deploy, has no seal at all.
		const { seal: _, ...older } = ref;
		expect(text(await sealing.bytes(older as RawRef))).toBe(mail);
	});

	it("leaves a stream it can't seal, rather than hold it open", async () => {
		const store = memoryBucket();
		let cancelled = false;
		const mail = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const ref: RawRef = { object: "w/m/a.eml", size: 5, seal: "v1.AAAAAAAAAAAAAAAAAAAAAA" };
		await expect(new RawMail(store.bucket, {}).put(ref, mail)).rejects.toThrow(SealError);
		expect(cancelled).toBe(true);
		expect(store.objects.size).toBe(0);
	});

	it("refuses mail that isn't as long as it was said to be", async () => {
		const store = memoryBucket();
		const raw = new RawMail(store.bucket, { SECRETS_KEY: KEY });
		const mail = new Uint8Array(randomBytes(SEALED_CHUNK + 10));
		for (const size of [mail.length - 1, mail.length + 1, SEALED_CHUNK]) {
			await expect(
				raw.put({ object: "w/m/a.eml", size, seal: await raw.newSeal() }, pieces(mail, 4096)),
			).rejects.toThrow();
		}
	});

	describe("sealing mail kept as it came", () => {
		/** Mail of `size` bytes kept as it came, as a row without a seal says. */
		async function plain(size: number) {
			const store = memoryBucket();
			const raw = new RawMail(store.bucket, { SECRETS_KEY: KEY });
			const mail = new Uint8Array(randomBytes(size));
			const ref: RawRef = { object: "w/m/a.eml", size, seal: null };
			await raw.put(ref, pieces(mail, 1000));
			return { ...store, raw, mail, ref };
		}

		it("writes a sealed copy under another name, which reads the same, and leaves the original", async () => {
			for (const size of [0, 10, SEALED_CHUNK + 1]) {
				const { raw, ref, mail, objects } = await plain(size);
				const seal = await raw.sealedCopy(ref, "w/m/a.sealed.eml");
				expect(seal).toMatch(/^v2\./);
				expect(objects.get("w/m/a.eml")).toEqual(mail);
				expect(objects.get("w/m/a.sealed.eml")?.length).toBe(sealedSize(size));
				expect(await raw.bytes({ object: "w/m/a.sealed.eml", size, seal })).toEqual(mail);
			}
		});

		it("does nothing when the server can't seal", async () => {
			const { ref, objects, bucket } = await plain(10);
			expect(await new RawMail(bucket, {}).sealedCopy(ref, "w/m/a.sealed.eml")).toBeNull();
			expect([...objects.keys()]).toEqual(["w/m/a.eml"]);
		});

		it("refuses mail that is missing or isn't the size its row says, as one that doesn't open", async () => {
			const { raw, ref, objects } = await plain(10);
			await expect(raw.sealedCopy({ ...ref, size: 11 }, "w/m/a.sealed.eml")).rejects.toThrow(
				SealError,
			);
			await expect(
				raw.sealedCopy({ ...ref, object: "w/m/none.eml" }, "w/m/none.sealed.eml"),
			).rejects.toThrow(SealError);
			expect([...objects.keys()]).toEqual(["w/m/a.eml"]);
		});

		it("doesn't seal what is sealed", async () => {
			const { raw, ref } = await sealedMail(10);
			await expect(raw.sealedCopy(ref, "w/m/b.eml")).rejects.toThrow();
		});
	});
});
