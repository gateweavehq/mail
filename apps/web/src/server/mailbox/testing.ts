/** For tests: what the mailbox's code needs of a Durable Object's storage, over Node's SQLite. */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { MigratedStorage } from "./schema";

/**
 * A Durable Object's storage, as far as migrating and indexing go: `exec` runs a script when it
 * has no bindings, as the object's does, and `transactionSync` rolls back on a throw.
 */
export function nodeStorage() {
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
			if (/^\s*SELECT|\bRETURNING\b/i.test(query)) {
				return cursor(db.prepare(query).all(...bindings) as T[]);
			}
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
