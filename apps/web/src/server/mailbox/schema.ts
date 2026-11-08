/**
 * The mailbox object's SQLite schema, and the migrations that bring an object to it. Durable
 * Objects have no `PRAGMA user_version`, so the versions run are kept in a table.
 */
import { messageIds, subjectKey } from "./thread";

// A message is pending from when it is given a place until its mail is in R2, then stored. One
// that took too long is expired, until the alarm has deleted what reached R2 of it.
// Each statement may run again on an object that has them, since objects made before migrations
// were counted have this schema with no record of it.
const VERSION_1 = `
CREATE TABLE IF NOT EXISTS message (
	id TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (state IN ('pending', 'stored', 'expired')),
	delivery_key TEXT NOT NULL,
	object TEXT NOT NULL,
	size INTEGER NOT NULL,
	body_hash TEXT,
	arrived_at INTEGER NOT NULL,
	envelope_from TEXT NOT NULL,
	envelope_to TEXT NOT NULL,
	from_header TEXT,
	subject TEXT,
	date_header TEXT,
	message_id TEXT,
	dmarc TEXT,
	verified_domain TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS message_delivery ON message (delivery_key, body_hash);
CREATE INDEX IF NOT EXISTS message_listed ON message (state, arrived_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS held (
	one INTEGER PRIMARY KEY CHECK (one = 1),
	bytes INTEGER NOT NULL,
	latest INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO held (one, bytes, latest) VALUES (1, 0, 0);
CREATE TRIGGER IF NOT EXISTS message_added AFTER INSERT ON message BEGIN
	UPDATE held SET bytes = bytes + new.size, latest = max(latest, new.arrived_at) WHERE one = 1;
END;
CREATE TRIGGER IF NOT EXISTS message_gone AFTER DELETE ON message BEGIN
	UPDATE held SET bytes = bytes - old.size WHERE one = 1;
END;
`;

// Threads. A stored message has one, and pending ones get theirs when stored. A thread's row keeps
// what a listing needs, which the object brings up to date after every change.
const VERSION_2 = `
ALTER TABLE message ADD COLUMN thread_id TEXT;
ALTER TABLE message ADD COLUMN own_id TEXT;
ALTER TABLE message ADD COLUMN subject_key TEXT NOT NULL DEFAULT '';
CREATE INDEX message_own_id ON message (own_id);
CREATE INDEX message_thread ON message (thread_id, arrived_at, id);
CREATE TABLE thread (
	id TEXT PRIMARY KEY,
	first_at INTEGER NOT NULL,
	latest_at INTEGER NOT NULL,
	count INTEGER NOT NULL
) STRICT;
CREATE INDEX thread_listed ON thread (latest_at DESC, id DESC);
CREATE TABLE message_reference (
	message TEXT NOT NULL,
	ref TEXT NOT NULL,
	PRIMARY KEY (message, ref)
) STRICT, WITHOUT ROWID;
CREATE INDEX message_reference_ref ON message_reference (ref);
CREATE TRIGGER message_references_gone AFTER DELETE ON message BEGIN
	DELETE FROM message_reference WHERE message = old.id;
END;
UPDATE message SET thread_id = id WHERE state = 'stored';
INSERT INTO thread (id, first_at, latest_at, count)
	SELECT id, arrived_at, arrived_at, 1 FROM message WHERE state = 'stored';
`;

/**
 * The threads a pending message links, the one that began first first. Its values are the
 * message's subject key, its id, its own id and its id again: the same few however many threads it
 * links, as SQLite takes at most a hundred and a stranger can make a thread of every message they
 * send. `+state` keeps SQLite off the index on `state`, which would have it read every stored
 * message; without that index, each part of the `OR` is looked up by an index of its own.
 */
export const LINKED_THREADS = `SELECT id FROM thread WHERE id IN (
	SELECT thread_id FROM message
	WHERE +state = 'stored' AND subject_key = ? AND (
		own_id IN (SELECT ref FROM message_reference WHERE message = ?)
		OR id IN (SELECT message FROM message_reference WHERE ref = ?)
		OR id IN (
			SELECT message FROM message_reference
			WHERE ref IN (SELECT ref FROM message_reference WHERE message = ?)
		)
	)
)
ORDER BY first_at, id`;

// Search. A stored message gets an entry in `message_search` once the alarm has read its text, and
// keeps the entry's row id; deleting the message deletes the entry. The table keeps no text of its
// own, only what finds it, so the text isn't held twice. Messages from before it are indexed by the
// alarm like new ones.
const VERSION_3 = `
ALTER TABLE message ADD COLUMN search_id INTEGER;
CREATE UNIQUE INDEX message_search_id ON message (search_id);
CREATE INDEX message_unsearched ON message (arrived_at, id)
	WHERE state = 'stored' AND search_id IS NULL;
CREATE VIRTUAL TABLE message_search USING fts5(
	subject, sender, attachments, body,
	content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER message_search_gone AFTER DELETE ON message WHEN old.search_id IS NOT NULL BEGIN
	DELETE FROM message_search WHERE rowid = old.search_id;
END;
`;

/** Each brings the schema from the version before it. Append only: objects keep what they ran. */
export const MIGRATIONS: ((sql: SqlStorage) => void)[] = [
	(sql) => sql.exec(VERSION_1),
	(sql) => {
		sql.exec(VERSION_2);
		// Messages from before threads become a thread each. Their references weren't kept, but a
		// reply to one still finds it by its own id.
		const rows = sql
			.exec<{ id: string; messageId: string | null; subject: string | null }>(
				"SELECT id, message_id AS messageId, subject FROM message",
			)
			.toArray();
		for (const row of rows) {
			sql.exec(
				"UPDATE message SET own_id = ?, subject_key = ? WHERE id = ?",
				messageIds(row.messageId)[0] ?? null,
				subjectKey(row.subject),
				row.id,
			);
		}
	},
	(sql) => sql.exec(VERSION_3),
];

/** What migrating needs of a Durable Object's storage. */
export type MigratedStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** Runs the migrations this object hasn't, all or none. */
export function migrate(storage: MigratedStorage): void {
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
		// Code from before threads stores messages without one, should it run again after version 2,
		// as in a rollback. Such a message becomes a thread of its own. An index finds them.
		sql.exec(
			`INSERT OR IGNORE INTO thread (id, first_at, latest_at, count)
			SELECT id, arrived_at, arrived_at, 1 FROM message WHERE thread_id IS NULL AND state = 'stored'`,
		);
		sql.exec("UPDATE message SET thread_id = id WHERE thread_id IS NULL AND state = 'stored'");
	});
}
