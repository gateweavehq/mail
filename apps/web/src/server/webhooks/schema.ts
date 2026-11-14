/**
 * The webhook object's tables. Objects have no `PRAGMA user_version`, so the versions run are kept
 * in a table, as the mailbox's are.
 */

// `meta` holds the workspace's id and the app's origin, as the gateway last gave them. A webhook's
// events and mailboxes are JSON arrays; no mailboxes means every mailbox. A delivery keeps the body
// it was queued with, so each retry sends the same bytes under the same `webhook-id`, and the
// mailbox it tells of (none for a test), so that it is dropped should the webhook stop hearing that
// mailbox. `seen_event` is what mailboxes handed over, so that an event handed over twice is queued
// once.
const VERSION_1 = `
CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE webhook (
	id TEXT PRIMARY KEY,
	url TEXT NOT NULL,
	events TEXT NOT NULL,
	mailbox_ids TEXT,
	active INTEGER NOT NULL,
	secret TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE delivery (
	id TEXT PRIMARY KEY,
	webhook_id TEXT NOT NULL,
	event TEXT NOT NULL,
	mailbox_id TEXT,
	payload TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 0,
	response_status INTEGER,
	error TEXT,
	next_attempt_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX delivery_due ON delivery (next_attempt_at) WHERE status = 'pending';
CREATE INDEX delivery_of_webhook ON delivery (webhook_id, created_at);
CREATE TABLE seen_event (
	id TEXT PRIMARY KEY,
	at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
`;

// An agent's own webhook names its membership and the key that made it, and lasts as long as that
// key; the workspace's own, which owners and admins make, name neither. `paused_by_admin` keeps an
// admin's pause of an agent's own from being undone by the agent.
const VERSION_2 = `
ALTER TABLE webhook ADD COLUMN agent_member_id TEXT;
ALTER TABLE webhook ADD COLUMN agent_key_id TEXT;
ALTER TABLE webhook ADD COLUMN paused_by_admin INTEGER NOT NULL DEFAULT 0;
`;

// A webhook's secret is sealed under SECRETS_KEY from now on, so the first characters the pages
// show to tell secrets apart are kept beside it. Every secret is still as made when this runs: 10 is
// `whsec_` and four more, what `secretStart` keeps.
const VERSION_3 = `
ALTER TABLE webhook ADD COLUMN secret_start TEXT NOT NULL DEFAULT '';
UPDATE webhook SET secret_start = substr(secret, 1, 10);
`;

/** Each brings the schema from the version before it. Append only: objects keep what they ran. */
export const MIGRATIONS: ((sql: SqlStorage) => void)[] = [
	(sql) => sql.exec(VERSION_1),
	(sql) => sql.exec(VERSION_2),
	(sql) => sql.exec(VERSION_3),
];

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
