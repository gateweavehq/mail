/**
 * The audience object's tables. Objects have no `PRAGMA user_version`, so the versions run are kept
 * in a table, as the mailbox's and the webhooks' are.
 */

// A template is a name and its versions. `name_key` is the name folded to lower case, so that two
// live templates can't differ only by case, and a removed one's name is free again: the index
// covers live templates only. A version is written once and never changed; `variables` is a JSON
// list of the names its subject and body use.
const VERSION_1 = `
CREATE TABLE template (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	name_key TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	removed_at INTEGER
) STRICT;
CREATE UNIQUE INDEX template_live_name ON template (name_key) WHERE removed_at IS NULL;
CREATE TABLE template_version (
	template_id TEXT NOT NULL,
	number INTEGER NOT NULL,
	subject TEXT NOT NULL,
	body TEXT NOT NULL,
	variables TEXT NOT NULL,
	made_by TEXT,
	made_at INTEGER NOT NULL,
	PRIMARY KEY (template_id, number)
) STRICT, WITHOUT ROWID;
`;

/** Each brings the schema from the version before it. Append only: objects keep what they ran. */
export const MIGRATIONS: ((sql: SqlStorage) => void)[] = [(sql) => sql.exec(VERSION_1)];

/** Runs the migrations this object hasn't, all or none. */
export function migrate(storage: Pick<DurableObjectStorage, "sql" | "transactionSync">): void {
	storage.transactionSync(() => {
		const sql = storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY) STRICT");
		const done = sql
			.exec<{ version: number | null }>("SELECT max(version) AS version FROM schema_migration")
			.one().version;
		for (let version = done ?? 0; version < MIGRATIONS.length; version++) {
			MIGRATIONS[version]?.(sql);
			sql.exec("INSERT INTO schema_migration (version) VALUES (?)", version + 1);
		}
	});
}
