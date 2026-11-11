import { afterEach, describe, expect, it, vi } from "vitest";
import {
	dropStale,
	oldestStale,
	RESEAL_BATCH,
	RESEAL_BYTES,
	RESEAL_TRIES,
	rekeyedName,
	resealBatch,
	resealStatus,
	type Sealer,
	sealedName,
	waitsUnderPrevious,
} from "./resealing";
import { migrate } from "./schema";
import { SealError } from "./sealed";
import { nodeStorage } from "./testing";

/** A migrated mailbox with `count` stored messages kept as they came, m0 the oldest. */
function mailbox(count: number, size = 10) {
	const { db, storage } = nodeStorage();
	migrate(storage);
	const insert = db.prepare(
		`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
			envelope_to)
		VALUES (?, 'stored', ?, ?, ?, ?, 'a@x', 'b@y')`,
	);
	for (let n = 0; n < count; n++) insert.run(`m${n}`, `key${n}`, `w/b/m${n}.eml`, size, n);
	const row = (id: string) =>
		db
			.prepare(
				`SELECT object, seal, stale_object AS stale, stale_at AS staleAt,
					seal_tries AS tries, seal_failed_at AS failed FROM message WHERE id = ?`,
			)
			.get(id) as
			| {
					object: string;
					seal: string | null;
					stale: string | null;
					staleAt: number | null;
					tries: number;
					failed: number | null;
			  }
			| undefined;
	const sealed = () =>
		(
			db.prepare("SELECT id FROM message WHERE seal IS NOT NULL ORDER BY arrived_at").all() as {
				id: string;
			}[]
		).map((one) => one.id);
	return { db, storage, row, sealed };
}

/** R2 as far as a run goes: the objects it holds, which start as each message's own. */
function bucket(box: { db: ReturnType<typeof mailbox>["db"] }) {
	const objects = new Set<string>(
		(box.db.prepare("SELECT object FROM message").all() as { object: string }[]).map(
			(one) => one.object,
		),
	);
	const calls = { copy: [] as string[], remove: [] as string[][] };
	const hooks: {
		/** Runs when the copy is written, before the row can switch to it. */
		written?: (object: string) => void;
		/** Runs as the copy begins, and may throw as R2 or the mail would. */
		copy?: (object: string) => void;
		remove?: () => void;
	} = {};
	const sealer: Sealer = {
		async copy(from, object) {
			calls.copy.push(from.object);
			hooks.copy?.(from.object);
			objects.add(object);
			hooks.written?.(object);
			return "v1.salt";
		},
		async remove(names) {
			calls.remove.push(names);
			hooks.remove?.();
			for (const name of names) objects.delete(name);
		},
	};
	return { objects, calls, hooks, sealer };
}

const ids = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, n) => `m${from + n}`);

describe("sealedName", () => {
	it("stays under the message's prefix, beside its own name", () => {
		expect(sealedName("w/b/abc.eml")).toBe("w/b/abc.sealed.eml");
		expect(sealedName("w/b/abc")).toBe("w/b/abc.sealed");
	});
});

describe("resealBatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("switches a message to its sealed copy in one step, and keeps the original for a while", async () => {
		const box = mailbox(1);
		const r2 = bucket(box);
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		const switched = box.row("m0");
		expect(switched).toMatchObject({
			object: "w/b/m0.sealed.eml",
			seal: "v1.salt",
			stale: "w/b/m0.eml",
			failed: null,
		});
		const at = switched?.staleAt ?? 0;
		expect(at).toBeGreaterThan(0);
		expect(oldestStale(box.storage)).toBe(at);
		// A page that read the row just before still finds its object.
		expect([...r2.objects].sort()).toEqual(["w/b/m0.eml", "w/b/m0.sealed.eml"]);
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(r2.calls.copy).toEqual(["w/b/m0.eml"]);

		// Deleted only once the window has passed.
		expect(await dropStale(box.storage, r2.sealer, at - 1)).toBe("done");
		expect([...r2.objects].sort()).toEqual(["w/b/m0.eml", "w/b/m0.sealed.eml"]);
		expect(box.row("m0")?.stale).toBe("w/b/m0.eml");
		expect(await dropStale(box.storage, r2.sealer, at)).toBe("done");
		expect([...r2.objects]).toEqual(["w/b/m0.sealed.eml"]);
		expect(box.row("m0")).toMatchObject({ stale: null, staleAt: null });
		expect(oldestStale(box.storage)).toBeNull();
	});

	it("takes a few messages a run, the newest first, until none is left", async () => {
		const box = mailbox(RESEAL_BATCH * 2 + 2);
		const r2 = bucket(box);
		expect(await resealBatch(box.storage, r2.sealer)).toBe("more");
		expect(box.sealed()).toEqual(ids(RESEAL_BATCH + 2, RESEAL_BATCH * 2 + 1));
		expect(await resealBatch(box.storage, r2.sealer)).toBe("more");
		expect(box.sealed().length).toBe(RESEAL_BATCH * 2);
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.sealed()).toEqual(ids(0, RESEAL_BATCH * 2 + 1));
		expect(r2.calls.copy.length).toBe(RESEAL_BATCH * 2 + 2);
	});

	it("takes fewer when their bytes pass the cap, and one that is over it alone", async () => {
		const box = mailbox(3, RESEAL_BYTES / 2 + 1);
		const r2 = bucket(box);
		expect(await resealBatch(box.storage, r2.sealer)).toBe("more");
		expect(box.sealed()).toEqual(["m2"]);
		expect(await resealBatch(box.storage, r2.sealer)).toBe("more");
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.sealed()).toEqual(ids(0, 2));
	});

	it("marks mail that doesn't open and doesn't try it again, while sealing the rest", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(3);
		const r2 = bucket(box);
		r2.hooks.copy = (object) => {
			if (object === "w/b/m1.eml") throw new SealError("Stored mail is missing");
		};
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.sealed()).toEqual(["m0", "m2"]);
		expect(box.row("m1")).toMatchObject({ object: "w/b/m1.eml", seal: null });
		expect(box.row("m1")?.failed).toEqual(expect.any(Number));
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(r2.calls.copy.filter((object) => object === "w/b/m1.eml").length).toBe(1);
		// Said without anything of the mail.
		expect(JSON.stringify(logged.mock.calls)).not.toContain("m1");
	});

	it("tries a message again that R2 failed on, and says so when nothing could be sealed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(2);
		const r2 = bucket(box);
		let down = true;
		r2.hooks.copy = () => {
			if (down) throw new TypeError("R2 is down");
		};
		expect(await resealBatch(box.storage, r2.sealer)).toBe("failed");
		expect(box.sealed()).toEqual([]);
		expect(box.row("m0")?.failed).toBeNull();
		down = false;
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.sealed()).toEqual(["m0", "m1"]);
	});

	it("gives up on a message after R2 has failed five times, and doesn't take it again", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(2);
		const r2 = bucket(box);
		r2.hooks.copy = (object) => {
			if (object === "w/b/m1.eml") throw new TypeError("R2 is down");
		};
		for (let run = 1; run < RESEAL_TRIES; run++) {
			await resealBatch(box.storage, r2.sealer);
			expect(box.row("m1")).toMatchObject({ tries: run, failed: null });
		}
		await resealBatch(box.storage, r2.sealer);
		expect(box.row("m1")).toMatchObject({ tries: RESEAL_TRIES, seal: null });
		expect(box.row("m1")?.failed).toEqual(expect.any(Number));
		expect(r2.calls.copy.filter((object) => object === "w/b/m1.eml").length).toBe(RESEAL_TRIES);
		// The sixth run leaves it be, and the other message was sealed all along.
		await resealBatch(box.storage, r2.sealer);
		expect(r2.calls.copy.filter((object) => object === "w/b/m1.eml").length).toBe(RESEAL_TRIES);
		expect(box.sealed()).toEqual(["m0"]);
		// Said by the kind of error alone.
		expect(JSON.stringify(logged.mock.calls)).toContain("too often");
		expect(JSON.stringify(logged.mock.calls)).not.toContain("R2 is down");
	});

	it("seals nothing when the server can't", async () => {
		const box = mailbox(2);
		const r2 = bucket(box);
		r2.sealer.copy = async () => null;
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.sealed()).toEqual([]);
		expect([...r2.objects].sort()).toEqual(["w/b/m0.eml", "w/b/m1.eml"]);
	});

	it("leaves nothing behind for a message deleted while its copy was written", async () => {
		const box = mailbox(2);
		const r2 = bucket(box);
		r2.hooks.written = (object) => {
			if (object === "w/b/m1.sealed.eml") {
				box.db.prepare("DELETE FROM message WHERE id = 'm1'").run();
			}
		};
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.row("m1")).toBeUndefined();
		// The copy went. The original is the message's own, which whoever deleted it deletes. m0's
		// original waits out its window.
		expect([...r2.objects].sort()).toEqual(["w/b/m0.eml", "w/b/m0.sealed.eml", "w/b/m1.eml"]);
	});

	it("leaves a message as it is when a try to send it began while its copy was written", async () => {
		const box = mailbox(1);
		const r2 = bucket(box);
		r2.hooks.written = () => {
			box.db.prepare("UPDATE message SET sent_by = 'member' WHERE id = 'm0'").run();
			box.db
				.prepare("INSERT INTO outgoing (message, state, request) VALUES ('m0', 'sending', '{}')")
				.run();
		};
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.row("m0")).toMatchObject({ object: "w/b/m0.eml", seal: null, stale: null });
		expect([...r2.objects]).toEqual(["w/b/m0.eml"]);
		// Not picked while the try goes on, but once it is over, whatever became of it.
		r2.hooks.written = undefined;
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.sealed()).toEqual([]);
		box.db.prepare("UPDATE outgoing SET state = 'refused' WHERE message = 'm0'").run();
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.sealed()).toEqual(["m0"]);
	});

	it("seals mail that waits to be sent, approved or sent again, as it may wait for good", async () => {
		const states = ["waiting", "held", "refused", "uncertain", "sent", "discarded"];
		const box = mailbox(states.length);
		const r2 = bucket(box);
		const insert = box.db.prepare(
			"INSERT INTO outgoing (message, state, request) VALUES (?, ?, '{}')",
		);
		for (const [n, state] of states.entries()) insert.run(`m${n}`, state);
		while ((await resealBatch(box.storage, r2.sealer)) === "more") {}
		expect(box.sealed()).toEqual(ids(0, states.length - 1));
	});

	it("deletes its copy when the mailbox went away while it was written", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(1);
		const r2 = bucket(box);
		r2.hooks.written = () => {
			box.db.exec("DROP TABLE message");
		};
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect([...r2.objects]).toEqual(["w/b/m0.eml"]);
	});

	it("keeps an original in the row that R2 can't delete, and a later run deletes it", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(1);
		const r2 = bucket(box);
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		const at = box.row("m0")?.staleAt ?? 0;
		r2.hooks.remove = () => {
			throw new TypeError("R2 is down");
		};
		expect(await dropStale(box.storage, r2.sealer, at)).toBe("failed");
		expect(box.row("m0")).toMatchObject({ object: "w/b/m0.sealed.eml", stale: "w/b/m0.eml" });
		expect([...r2.objects].sort()).toEqual(["w/b/m0.eml", "w/b/m0.sealed.eml"]);
		r2.hooks.remove = undefined;
		expect(await dropStale(box.storage, r2.sealer, at)).toBe("done");
		expect(box.row("m0")?.stale).toBeNull();
		expect([...r2.objects]).toEqual(["w/b/m0.sealed.eml"]);
	});
});

describe("after SECRETS_KEY changes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const KEYS = { current: "CURRENTKEY1", previous: "PREVIOUSKEY" };
	const SALT = "AAAAAAAAAAAAAAAAAAAAAA";

	/** A mailbox whose messages are sealed as `seals` says, in order, m0 the oldest; null is none. */
	function sealedBox(seals: (string | null)[]) {
		const box = mailbox(seals.length);
		seals.forEach((seal, n) => {
			box.db.prepare("UPDATE message SET seal = ? WHERE id = ?").run(seal, `m${n}`);
		});
		const extra = (id: string) =>
			box.db
				.prepare("SELECT rekey_failed AS failed, seal_tries AS tries FROM message WHERE id = ?")
				.get(id) as { failed: string | null; tries: number };
		return { ...box, extra };
	}

	/** R2 that seals each copy under the current key, as `RawMail` does. */
	function current(box: ReturnType<typeof sealedBox>) {
		const r2 = bucket(box);
		const copy = r2.sealer.copy;
		r2.sealer.copy = async (from, object) => {
			await copy(from, object);
			return `v2.${KEYS.current}.${SALT}`;
		};
		return r2;
	}

	it("names the copy with the message's id and the key's, beside the mail", () => {
		expect(rekeyedName("w/b/m0.sealed.eml", "m0", "KEY")).toBe("w/b/m0.KEY.eml");
		expect(rekeyedName("w/b/m0.OLD.eml", "m0", "KEY")).toBe("w/b/m0.KEY.eml");
	});

	it("seals again mail under the previous key, or sealed before ids, after mail kept as it came", async () => {
		const box = sealedBox([
			`v1.${SALT}`,
			`v2.${KEYS.previous}.${SALT}`,
			`v2.${KEYS.current}.${SALT}`,
			`v2.SOMEOTHERKY.${SALT}`,
			null,
		]);
		const r2 = current(box);
		expect(await resealBatch(box.storage, r2.sealer, KEYS)).toBe("done");
		// The one kept as it came first, then those under the previous key; the rest are left.
		expect(r2.calls.copy).toEqual(["w/b/m4.eml", "w/b/m0.eml", "w/b/m1.eml"]);
		expect(box.row("m0")).toMatchObject({
			object: `w/b/m0.${KEYS.current}.eml`,
			seal: `v2.${KEYS.current}.${SALT}`,
			stale: "w/b/m0.eml",
		});
		expect(box.row("m1")?.object).toBe(`w/b/m1.${KEYS.current}.eml`);
		expect(box.row("m4")?.object).toBe("w/b/m4.sealed.eml");
		for (const id of ["m2", "m3"]) expect(box.row(id)?.object).toBe(`w/b/${id}.eml`);
		expect(resealStatus(box.storage, KEYS)).toEqual({ left: 0, unopened: 1 });
		// A second run finds nothing more.
		expect(waitsUnderPrevious(box.storage, KEYS)).toBe(false);
	});

	it("leaves sealed mail be without a previous key", async () => {
		const box = sealedBox([`v1.${SALT}`, `v2.${KEYS.previous}.${SALT}`, null]);
		const r2 = current(box);
		const keys = { current: KEYS.current, previous: null };
		expect(waitsUnderPrevious(box.storage, keys)).toBe(false);
		expect(await resealBatch(box.storage, r2.sealer, keys)).toBe("done");
		expect(r2.calls.copy).toEqual(["w/b/m2.eml"]);
	});

	it("waits for an original to go before sealing a message again", async () => {
		const box = sealedBox([`v2.${KEYS.previous}.${SALT}`]);
		box.db
			.prepare(
				"UPDATE message SET stale_object = 'w/b/m0.before.eml', stale_at = 1 WHERE id = 'm0'",
			)
			.run();
		const r2 = current(box);
		expect(await resealBatch(box.storage, r2.sealer, KEYS)).toBe("done");
		expect(r2.calls.copy).toEqual([]);
		// It still needs the previous key.
		expect(resealStatus(box.storage, KEYS)).toEqual({ left: 1, unopened: 0 });
	});

	it("marks mail that opens with neither key, until another previous key", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const box = sealedBox([`v1.${SALT}`]);
		const r2 = current(box);
		r2.hooks.copy = () => {
			throw new SealError("Doesn't open");
		};
		expect(await resealBatch(box.storage, r2.sealer, KEYS)).toBe("done");
		expect(box.extra("m0").failed).toBe(KEYS.previous);
		expect(box.row("m0")).toMatchObject({ object: "w/b/m0.eml", seal: `v1.${SALT}` });
		expect(resealStatus(box.storage, KEYS)).toEqual({ left: 0, unopened: 1 });
		expect(await resealBatch(box.storage, r2.sealer, KEYS)).toBe("done");
		expect(r2.calls.copy).toEqual(["w/b/m0.eml"]);
		// Its copy is deleted, under the current key's name.
		expect(r2.calls.remove).toEqual([[`w/b/m0.${KEYS.current}.eml`]]);

		const other = { current: KEYS.current, previous: "ANOTHERKEY1" };
		expect(waitsUnderPrevious(box.storage, other)).toBe(true);
	});

	it("stops trying mail R2 fails on, until the daily run asks again", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const box = sealedBox([`v2.${KEYS.previous}.${SALT}`]);
		const r2 = current(box);
		r2.hooks.copy = () => {
			throw new TypeError("R2 is down");
		};
		for (let n = 0; n < RESEAL_TRIES; n++) {
			expect(await resealBatch(box.storage, r2.sealer, KEYS)).toBe("failed");
		}
		expect(box.extra("m0")).toEqual({ failed: null, tries: RESEAL_TRIES });
		// Not marked as mail that doesn't open, and not tried again for now.
		expect(box.row("m0")?.failed).toBeNull();
		expect(waitsUnderPrevious(box.storage, KEYS)).toBe(false);
		expect(await resealBatch(box.storage, r2.sealer, KEYS)).toBe("done");
		expect(r2.calls.copy).toHaveLength(RESEAL_TRIES);
		// Asking counts it as still needing the previous key, and has it tried again.
		expect(resealStatus(box.storage, KEYS)).toEqual({ left: 1, unopened: 0 });
		expect(box.extra("m0").tries).toBe(0);
		r2.hooks.copy = undefined;
		expect(await resealBatch(box.storage, r2.sealer, KEYS)).toBe("done");
		expect(box.row("m0")?.object).toBe(`w/b/m0.${KEYS.current}.eml`);
		expect(box.extra("m0").tries).toBe(0);
	});

	it("leaves a message whose seal changed while its copy was written", async () => {
		const box = sealedBox([`v2.${KEYS.previous}.${SALT}`]);
		const r2 = current(box);
		r2.hooks.written = () => {
			box.db
				.prepare("UPDATE message SET seal = ? WHERE id = 'm0'")
				.run(`v2.${KEYS.current}.BBBBBBBBBBBBBBBBBBBBBB`);
		};
		expect(await resealBatch(box.storage, r2.sealer, KEYS)).toBe("done");
		expect(box.row("m0")?.object).toBe("w/b/m0.eml");
		expect([...r2.objects]).toEqual(["w/b/m0.eml"]);
	});
});
