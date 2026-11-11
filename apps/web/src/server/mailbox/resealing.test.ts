import { afterEach, describe, expect, it, vi } from "vitest";
import {
	dropStale,
	RESEAL_BATCH,
	RESEAL_BYTES,
	resealBatch,
	type Sealer,
	sealedName,
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
				"SELECT object, seal, stale_object AS stale, seal_failed_at AS failed FROM message WHERE id = ?",
			)
			.get(id) as
			| { object: string; seal: string | null; stale: string | null; failed: number | null }
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

	it("switches a message to its sealed copy in one step, and deletes the original after", async () => {
		const box = mailbox(1);
		const r2 = bucket(box);
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.row("m0")).toEqual({
			object: "w/b/m0.sealed.eml",
			seal: "v1.salt",
			stale: null,
			failed: null,
		});
		expect([...r2.objects]).toEqual(["w/b/m0.sealed.eml"]);
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(r2.calls.copy).toEqual(["w/b/m0.eml"]);
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
		// The copy went. The original is the message's own, which whoever deleted it deletes.
		expect([...r2.objects].sort()).toEqual(["w/b/m0.sealed.eml", "w/b/m1.eml"]);
	});

	it("leaves a message as it is when it began being sent while its copy was written", async () => {
		const box = mailbox(1);
		const r2 = bucket(box);
		r2.hooks.written = () => {
			box.db.prepare("UPDATE message SET sent_by = 'member' WHERE id = 'm0'").run();
			box.db
				.prepare("INSERT INTO outgoing (message, state, request) VALUES ('m0', 'waiting', '{}')")
				.run();
		};
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.row("m0")).toMatchObject({ object: "w/b/m0.eml", seal: null, stale: null });
		expect([...r2.objects]).toEqual(["w/b/m0.eml"]);
		// Not picked while it waits to be sent, but once it is sent.
		r2.hooks.written = undefined;
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.sealed()).toEqual([]);
		box.db.prepare("UPDATE outgoing SET state = 'sent' WHERE message = 'm0'").run();
		expect(await resealBatch(box.storage, r2.sealer)).toBe("done");
		expect(box.sealed()).toEqual(["m0"]);
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

	it("keeps the original in the row when it can't delete it, and a later run does", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(1);
		const r2 = bucket(box);
		r2.hooks.remove = () => {
			throw new TypeError("R2 is down");
		};
		// A stop between the switch and the delete is the same: the row names the copy, which is there.
		expect(await resealBatch(box.storage, r2.sealer)).toBe("failed");
		expect(box.row("m0")).toMatchObject({ object: "w/b/m0.sealed.eml", stale: "w/b/m0.eml" });
		expect([...r2.objects].sort()).toEqual(["w/b/m0.eml", "w/b/m0.sealed.eml"]);
		expect(await dropStale(box.storage, r2.sealer)).toBe("failed");
		r2.hooks.remove = undefined;
		expect(await dropStale(box.storage, r2.sealer)).toBe("done");
		expect(box.row("m0")?.stale).toBeNull();
		expect([...r2.objects]).toEqual(["w/b/m0.sealed.eml"]);
	});
});
