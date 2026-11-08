/** Filling a mailbox's search index, a few stored messages at a time, from its object's alarm. */
import type { MigratedStorage } from "./schema";
import type { Searchable } from "./search";

/** How many messages one run of the alarm indexes for search. */
export const INDEX_BATCH = 20;

/**
 * Stored messages that wait to be indexed, the newest first. Named, as SQLite would otherwise find
 * them through the index on `search_id` and sort them all on every run.
 */
export const WAITING = `SELECT id, object, size, subject, from_header AS "from"
	FROM message INDEXED BY message_unsearched
	WHERE state = 'stored' AND search_id IS NULL ORDER BY arrived_at DESC, id DESC LIMIT ?`;

/** A message that waits to be indexed, as `WAITING` reads it. */
export type Waiting = {
	id: string;
	object: string;
	size: number;
	subject: string | null;
	from: string | null;
};

/**
 * What a run did: indexed all that waited, left more for the next, or couldn't read the mail of
 * some, which a later run tries again.
 */
export type Indexed = "done" | "more" | "failed";

/** What a message is found by when nothing it holds could be written: nothing. */
const NOTHING: Searchable = { subject: "", sender: "", attachments: "", body: "" };

/**
 * Indexes a few stored messages, the newest first, so that new mail can be found soon even while
 * a mailbox's older mail waits. A message whose mail can't be read is left for a later run while
 * the rest are indexed, so one can't hold up the others.
 */
export async function indexBatch(
	storage: MigratedStorage,
	read: (message: Waiting) => Promise<Searchable>,
): Promise<Indexed> {
	const sql = storage.sql;
	const waiting = sql.exec<Waiting>(WAITING, INDEX_BATCH + 1).toArray();
	const batch = waiting.slice(0, INDEX_BATCH);
	let failures = 0;
	for (const message of batch) {
		let found: Searchable;
		try {
			found = await read(message);
		} catch (error) {
			console.error("mailbox: reading a message to index it failed; it will be tried again", {
				name: error instanceof Error ? error.name : "unknown",
			});
			failures++;
			continue;
		}
		// What a message holds must never stop the alarm, which also expires deliveries: when its
		// entry can't be written, it is found by its headers, or by nothing, rather than not indexed.
		const entries = [found, { ...found, attachments: "", body: "" }, NOTHING];
		for (const entry of entries) {
			try {
				write(storage, message.id, entry);
				break;
			} catch (error) {
				console.error("mailbox: writing a message's search entry failed", {
					name: error instanceof Error ? error.name : "unknown",
				});
			}
		}
	}
	// When none of the batch could be read, R2 is likely down: running again at once won't help.
	// So are 20 messages whose mail R2 always fails to give, which would hold up older mail.
	if (failures > 0 && failures === batch.length) return "failed";
	if (waiting.length > INDEX_BATCH) return "more";
	return failures > 0 ? "failed" : "done";
}

/** Writes a message's search entry, unless it was deleted, or indexed, while its mail was read. */
function write(storage: MigratedStorage, id: string, entry: Searchable): void {
	const sql = storage.sql;
	storage.transactionSync(() => {
		const still = sql
			.exec("SELECT 1 FROM message WHERE id = ? AND state = 'stored' AND search_id IS NULL", id)
			.toArray();
		if (still.length === 0) return;
		const searchId = sql
			.exec<{ next: number }>("SELECT coalesce(max(search_id), 0) + 1 AS next FROM message")
			.one().next;
		sql.exec(
			`INSERT INTO message_search (rowid, subject, sender, attachments, body)
			VALUES (?, ?, ?, ?, ?)`,
			searchId,
			entry.subject,
			entry.sender,
			entry.attachments,
			entry.body,
		);
		sql.exec("UPDATE message SET search_id = ? WHERE id = ?", searchId, id);
	});
}
