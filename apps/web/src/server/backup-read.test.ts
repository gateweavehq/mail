import { describe, expect, it } from "vitest";
import { readRolledBack } from "./backup-read";

// The statements a backup sends are checked before they run, so a write never reaches the rollback
// through the entrypoint. The rollback is the second guard, and this is the only place that sees it
// work: a storage whose transactions commit unless their callback throws, as an object's do.

function storage() {
	let rows = [{ name: "Ada" }];
	const sql = {
		exec(statement: string) {
			if (statement.startsWith("UPDATE")) rows = rows.map(() => ({ name: "Changed" }));
			return { toArray: () => rows.map((row) => ({ ...row })) };
		},
	};
	return {
		sql,
		rows: () => rows,
		transactionSync<T>(body: () => T): T {
			const before = rows;
			try {
				return body();
			} catch (error) {
				rows = before;
				throw error;
			}
		},
	} as unknown as DurableObjectStorage & { rows(): { name: string }[] };
}

describe("reads for a backup", () => {
	it("return each statement's rows, and roll back whatever they ran", () => {
		const object = storage();
		const [written, seen] = readRolledBack(object, [
			"UPDATE people SET name = 'Changed'",
			"SELECT name FROM people",
		]);
		// They saw their own write, as one moment, and none of it stays.
		expect(written).toEqual([{ name: "Changed" }]);
		expect(seen).toEqual([{ name: "Changed" }]);
		expect(object.rows()).toEqual([{ name: "Ada" }]);
	});

	it("let a failure of the object's own through", () => {
		const object = storage();
		object.sql.exec = () => {
			throw new Error("no such table");
		};
		expect(() => readRolledBack(object, ["SELECT 1"])).toThrow("no such table");
	});
});
