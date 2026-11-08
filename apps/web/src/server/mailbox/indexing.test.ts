import { afterEach, describe, expect, it, vi } from "vitest";
import { INDEX_BATCH, indexBatch, WAITING, type Waiting } from "./indexing";
import { migrate } from "./schema";
import type { Searchable } from "./search";
import { nodeStorage } from "./testing";

/** A migrated mailbox with `count` stored messages, m0 the oldest, none indexed yet. */
function mailbox(count: number) {
	const { db, storage } = nodeStorage();
	migrate(storage);
	const insert = db.prepare(
		`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
			envelope_to, subject)
		VALUES (?, 'stored', ?, ?, 10, ?, 'a@x', 'b@y', ?)`,
	);
	for (let n = 0; n < count; n++)
		insert.run(`m${n}`, `key${n}`, `w/m/m${n}.eml`, n, `Message ${n}`);
	const indexed = () =>
		(
			db
				.prepare("SELECT id FROM message WHERE search_id IS NOT NULL ORDER BY arrived_at")
				.all() as { id: string }[]
		).map((row) => row.id);
	const found = (word: string) =>
		(
			db
				.prepare(
					`SELECT message.id FROM message_search
					JOIN message ON message.search_id = message_search.rowid
					WHERE message_search MATCH ? ORDER BY message.arrived_at`,
				)
				.all(word) as { id: string }[]
		).map((row) => row.id);
	return { db, storage, indexed, found };
}

const ids = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, n) => `m${from + n}`);

/** What reading a message's mail gives, without R2. */
const read = async (message: Waiting): Promise<Searchable> => ({
	subject: message.subject ?? "",
	sender: "",
	attachments: "",
	body: `text of ${message.id}`,
});

const unreadable = new TypeError("R2 is down");

describe("indexBatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("indexes the newest messages first, a batch at a time", async () => {
		const box = mailbox(INDEX_BATCH + 5);
		expect(await indexBatch(box.storage, read)).toBe("more");
		expect(box.indexed()).toEqual(ids(5, INDEX_BATCH + 4));
		expect(await indexBatch(box.storage, read)).toBe("done");
		expect(box.indexed()).toEqual(ids(0, INDEX_BATCH + 4));
		expect(box.found("m3")).toEqual(["m3"]);
		expect(await indexBatch(box.storage, read)).toBe("done");
	});

	it("leaves a message it can't read for a later run, and indexes the rest", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(3);
		const failing = async (message: Waiting) => {
			if (message.id === "m1") throw unreadable;
			return read(message);
		};
		expect(await indexBatch(box.storage, failing)).toBe("failed");
		expect(box.indexed()).toEqual(["m0", "m2"]);
		// Its name only: what it says of the mail stays out of the logs.
		expect(logged).toHaveBeenCalledWith(expect.stringMatching(/tried again/), {
			name: "TypeError",
		});

		expect(await indexBatch(box.storage, read)).toBe("done");
		expect(box.indexed()).toEqual(["m0", "m1", "m2"]);
	});

	it("goes on at once past a message it can't read while more wait", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(INDEX_BATCH + 5);
		const newest = `m${INDEX_BATCH + 4}`;
		const failing = async (message: Waiting) => {
			if (message.id === newest) throw unreadable;
			return read(message);
		};
		expect(await indexBatch(box.storage, failing)).toBe("more");
		expect(box.indexed()).toEqual(ids(5, INDEX_BATCH + 3));
		expect(await indexBatch(box.storage, failing)).toBe("failed");
		expect(box.indexed()).toEqual(ids(0, INDEX_BATCH + 3));
	});

	it("waits when it could read none of a batch, as running again at once won't help", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(INDEX_BATCH + 5);
		expect(
			await indexBatch(box.storage, async () => {
				throw unreadable;
			}),
		).toBe("failed");
		expect(box.indexed()).toEqual([]);
	});

	it("leaves out a message deleted while its mail was read", async () => {
		const box = mailbox(2);
		const deleting = async (message: Waiting) => {
			if (message.id === "m1") box.db.prepare("DELETE FROM message WHERE id = 'm1'").run();
			return read(message);
		};
		expect(await indexBatch(box.storage, deleting)).toBe("done");
		expect(box.indexed()).toEqual(["m0"]);
		expect(box.db.prepare("SELECT count(*) AS count FROM message_search").get()).toEqual({
			count: 1,
		});
	});

	it("indexes a message whose entry can't be written by its headers, or by nothing", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const box = mailbox(2);
		// Node's SQLite can't bind an object, as the object's can't take a value over 2 MB.
		const unwritable = {} as unknown as string;
		const holding = async (message: Waiting): Promise<Searchable> => ({
			subject: message.id === "m0" ? unwritable : (message.subject ?? ""),
			sender: "",
			attachments: "",
			body: unwritable,
		});
		expect(await indexBatch(box.storage, holding)).toBe("done");
		expect(box.indexed()).toEqual(["m0", "m1"]);
		// m1 by its subject, m0, whose subject couldn't be written either, by nothing.
		expect(box.found("message")).toEqual(["m1"]);
		expect(logged).toHaveBeenCalledTimes(3);
		expect(box.db.prepare("SELECT count(*) AS count FROM message_search").get()).toEqual({
			count: 2,
		});
	});

	it("finds what waits through the index that holds only them, without sorting", () => {
		const box = mailbox(0);
		const plan = (
			box.db.prepare(`EXPLAIN QUERY PLAN ${WAITING}`).all(INDEX_BATCH + 1) as {
				detail: string;
			}[]
		)
			.map((row) => row.detail)
			.join("\n");
		expect(plan).toMatch(/message_unsearched/);
		expect(plan).not.toMatch(/TEMP B-TREE/);
	});
});
