import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { LINKED_THREADS, MIGRATIONS, type MigratedStorage, migrate } from "./schema";

/**
 * A Durable Object's storage, as far as migrating goes, over Node's SQLite: `exec` runs a script
 * when it has no bindings, as the object's does, and `transactionSync` rolls back on a throw.
 */
function storage() {
	const db = new DatabaseSync(":memory:");
	const cursor = <T>(rows: T[]) => ({
		toArray: () => rows,
		one: () => {
			if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
			return rows[0] as T;
		},
	});
	const sql = {
		exec<T>(query: string, ...bindings: SQLInputValue[]) {
			if (/^\s*SELECT/i.test(query)) return cursor(db.prepare(query).all(...bindings) as T[]);
			if (bindings.length === 0) db.exec(query);
			else db.prepare(query).run(...bindings);
			return cursor<T>([]);
		},
	};
	const transactionSync = <T>(run: () => T): T => {
		db.exec("BEGIN");
		try {
			const result = run();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	};
	return { db, storage: { sql, transactionSync } as unknown as MigratedStorage };
}

const names = (db: DatabaseSync, type: string) =>
	(
		db
			.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
			.all(type) as { name: string }[]
	)
		.map((row) => row.name)
		.sort();

describe("migrate", () => {
	it("brings a new object to the latest version, and does nothing the second time", () => {
		const { db, storage: store } = storage();
		migrate(store);
		migrate(store);
		expect(names(db, "table")).toEqual([
			"held",
			"message",
			"message_reference",
			"schema_migration",
			"thread",
		]);
		expect(db.prepare("SELECT version FROM schema_migration").all()).toEqual([
			{ version: 1 },
			{ version: 2 },
		]);
	});

	it("brings an object from before migrations were counted, giving its messages a thread each", () => {
		const { db, storage: store } = storage();
		// What the first version of the object made, with no record of it.
		MIGRATIONS[0]?.(store.sql);
		const insert = db.prepare(
			`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
				envelope_to, subject, message_id)
			VALUES (?, ?, 'key', 'w/m/x.eml', 10, ?, 'a@x', 'b@y', ?, ?)`,
		);
		insert.run("one", "stored", 1, "Re: =?UTF-8?Q?Caf=C3=A9?= plans", "<one@example.org> (sent)");
		insert.run("two", "stored", 2, "Other", null);
		insert.run("three", "pending", 3, "Later", "<three@example.org>");

		migrate(store);

		expect(
			db
				.prepare(
					"SELECT id, thread_id AS threadId, own_id AS ownId, subject_key AS subjectKey FROM message ORDER BY arrived_at",
				)
				.all(),
		).toEqual([
			{ id: "one", threadId: "one", ownId: "one@example.org", subjectKey: "café plans" },
			{ id: "two", threadId: "two", ownId: null, subjectKey: "other" },
			// A pending message gets its thread when it is stored.
			{ id: "three", threadId: null, ownId: "three@example.org", subjectKey: "later" },
		]);
		expect(
			db.prepare("SELECT id, first_at, latest_at, count FROM thread ORDER BY id").all(),
		).toEqual([
			{ id: "one", first_at: 1, latest_at: 1, count: 1 },
			{ id: "two", first_at: 2, latest_at: 2, count: 1 },
		]);
		expect(db.prepare("SELECT bytes FROM held").get()).toEqual({ bytes: 30 });
	});

	it("gives a thread to a message stored without one, as code from before threads does", () => {
		const { db, storage: store } = storage();
		migrate(store);
		// Stored as the first version stores, after a rollback.
		db.prepare(
			`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
				envelope_to)
			VALUES ('loose', 'stored', 'key', 'w/m/x.eml', 10, 5, 'a@x', 'b@y')`,
		).run();

		migrate(store);

		expect(db.prepare("SELECT thread_id AS threadId FROM message").get()).toEqual({
			threadId: "loose",
		});
		expect(db.prepare("SELECT id, first_at, latest_at, count FROM thread").all()).toEqual([
			{ id: "loose", first_at: 5, latest_at: 5, count: 1 },
		]);
	});

	it("finds a message's threads through indexes, not by reading every stored message", () => {
		const { db, storage: store } = storage();
		migrate(store);
		const plan = (
			db.prepare(`EXPLAIN QUERY PLAN ${LINKED_THREADS}`).all("key", "id", "own", "id") as {
				detail: string;
			}[]
		)
			.map((row) => row.detail)
			.join("\n");
		expect(plan).not.toMatch(/message_listed|SCAN message\b/);
		expect(plan).toMatch(/MULTI-INDEX OR/);
	});

	it("leaves an object as it was when a migration fails", () => {
		const { db, storage: store } = storage();
		MIGRATIONS[0]?.(store.sql);
		// A column the second version adds, there already, makes it fail part way.
		db.exec("ALTER TABLE message ADD COLUMN own_id TEXT");
		expect(() => migrate(store)).toThrow();
		expect(names(db, "table")).toEqual(["held", "message"]);
	});
});
