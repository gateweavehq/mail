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

// Sending. What the mailbox sends is a message like any other, stored at once with the member who
// sent it, and `outgoing` follows it to Email Service: sending, waiting to try again, sent, refused,
// or uncertain when it may or may not have gone. `request` is what Email Service is given, so a try
// again sends the same. The row goes with its message.
const VERSION_4 = `
ALTER TABLE message ADD COLUMN sent_by TEXT;
CREATE TABLE outgoing (
	message TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (
		state IN ('sending', 'waiting', 'sent', 'refused', 'uncertain', 'discarded')
	),
	request TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	attempted_at INTEGER,
	next_at INTEGER,
	code TEXT,
	provider_id TEXT,
	sent_at INTEGER,
	draft TEXT
) STRICT;
CREATE INDEX outgoing_due ON outgoing (state, next_at);
CREATE UNIQUE INDEX outgoing_draft ON outgoing (draft);
CREATE TRIGGER outgoing_gone AFTER DELETE ON message BEGIN
	DELETE FROM outgoing WHERE message = old.id;
END;
`;

// An agent's mail can wait for a person: `held` until someone approves it, who is kept with when.
// SQLite can't change a CHECK in place, so `outgoing` is made again. Its trigger, on `message`, goes
// first and comes back after: renaming a table checks every trigger, and this one would name a
// table that is gone.
const VERSION_5 = `
DROP TRIGGER outgoing_gone;
CREATE TABLE outgoing_new (
	message TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (
		state IN ('held', 'sending', 'waiting', 'sent', 'refused', 'uncertain', 'discarded')
	),
	request TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	attempted_at INTEGER,
	next_at INTEGER,
	code TEXT,
	provider_id TEXT,
	sent_at INTEGER,
	draft TEXT,
	approved_by TEXT,
	approved_at INTEGER
) STRICT;
INSERT INTO outgoing_new (message, state, request, attempts, attempted_at, next_at, code,
	provider_id, sent_at, draft)
SELECT message, state, request, attempts, attempted_at, next_at, code, provider_id, sent_at, draft
FROM outgoing;
DROP TABLE outgoing;
ALTER TABLE outgoing_new RENAME TO outgoing;
CREATE INDEX outgoing_due ON outgoing (state, next_at);
CREATE UNIQUE INDEX outgoing_draft ON outgoing (draft);
CREATE TRIGGER outgoing_gone AFTER DELETE ON message BEGIN
	DELETE FROM outgoing WHERE message = old.id;
END;
`;

// How each message goes: through Email Service's binding, or Resend with the workspace's key, which
// the object reads from D1 at each try. Resend knows a message by `idempotency_key` for a day, and
// `detail` keeps its words for a refusal. Rows from before are all Email Service's.
const VERSION_6 = `
ALTER TABLE outgoing ADD COLUMN provider TEXT NOT NULL DEFAULT 'cloudflare';
ALTER TABLE outgoing ADD COLUMN workspace_id TEXT;
ALTER TABLE outgoing ADD COLUMN idempotency_key TEXT;
ALTER TABLE outgoing ADD COLUMN detail TEXT;
ALTER TABLE outgoing ADD COLUMN maybe_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outgoing ADD COLUMN key_version TEXT;
`;

// What became of a sent message at each recipient's server, from the provider's delivery events,
// which name the message by the id the provider gave it, kept in `provider_id`. One row per
// recipient, moved on only as `DELIVERY_RANK` allows. The rows go with their message.
const VERSION_7 = `
CREATE INDEX outgoing_provider_id ON outgoing (provider_id) WHERE provider_id IS NOT NULL;
CREATE TABLE delivery (
	message TEXT NOT NULL,
	recipient TEXT NOT NULL,
	state TEXT NOT NULL CHECK (
		state IN ('deferred', 'delivered', 'bounced', 'failed', 'rejected', 'complained')
	),
	at INTEGER NOT NULL,
	detail TEXT,
	PRIMARY KEY (message, recipient)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER delivery_gone AFTER DELETE ON message BEGIN
	DELETE FROM delivery WHERE message = old.id;
END;
`;

// Mail that came, told to the workspace's webhooks from here: `event` is the outbox, written in the
// transaction that stores the message and emptied once the workspace's webhook object has it.
// `place` is which workspace and mailbox this object is, as the first delivery to it said.
const VERSION_8 = `
CREATE TABLE place (
	only INTEGER PRIMARY KEY CHECK (only = 1),
	workspace_id TEXT NOT NULL,
	mailbox_id TEXT NOT NULL
) STRICT;
CREATE TABLE event (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	message TEXT NOT NULL,
	at INTEGER NOT NULL
) STRICT;
CREATE INDEX event_at ON event (at);
`;

// Events about mail this mailbox sends, from held to bounced. Each keeps what it tells of in
// `data`, taken when it happened: the message may be gone by the time it is told, as a rejected one
// is at once. Events about mail that came keep nothing here and are read from the message.
const VERSION_9 = `
ALTER TABLE event ADD COLUMN data TEXT;
`;

// How many files a message the mailbox sends carries. Their bytes stay in its copy in R2, which each
// try reads them from, so none are in the request kept here.
const VERSION_10 = `
ALTER TABLE outgoing ADD COLUMN files TEXT NOT NULL DEFAULT '[]';
`;

// Which agent a message that arrived came for: the one that made the address it was delivered to,
// as the directory said then, so that the agent's page finds it after the address has ended. Its
// page lists what the agent wrote the same way, newest first.
const VERSION_11 = `
ALTER TABLE message ADD COLUMN came_for TEXT;
CREATE INDEX message_came_for ON message (came_for, arrived_at DESC, id DESC)
	WHERE came_for IS NOT NULL;
CREATE INDEX message_sent_by ON message (sent_by, arrived_at DESC, id DESC)
	WHERE sent_by IS NOT NULL;
`;

// How a message's raw mail is sealed in R2: null for mail kept as it came, as all of it was before
// this, or the random salt its own key was derived with. See `sealed.ts`.
const VERSION_12 = `
ALTER TABLE message ADD COLUMN seal TEXT;
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
	(sql) => sql.exec(VERSION_4),
	(sql) => sql.exec(VERSION_5),
	(sql) => sql.exec(VERSION_6),
	(sql) => sql.exec(VERSION_7),
	(sql) => sql.exec(VERSION_8),
	(sql) => sql.exec(VERSION_9),
	(sql) => sql.exec(VERSION_10),
	(sql) => sql.exec(VERSION_11),
	(sql) => sql.exec(VERSION_12),
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
