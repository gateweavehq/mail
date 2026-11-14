/**
 * Reads for Gateweave Backup (docs/architecture.md, "Backups"). A backup dumps a Durable Object's
 * SQLite, a mailbox's or a workspace's webhooks, by sending the SELECTs of its dump, and they run
 * here together, in one transaction that is always rolled back: they see one moment, and nothing
 * they run can change the object. Only reads get in, one statement each, as a second guard.
 */
import { z } from "zod";

const READ = /^\s*(?:SELECT\b|PRAGMA\s+table_(?:list|info|xinfo)\b)/i;

export const backupStatements = z
	.array(
		z
			.string()
			.max(100_000)
			.regex(READ, "A backup only reads: SELECT, or PRAGMA table_list, table_info or table_xinfo.")
			.refine((sql) => !sql.includes(";"), "One statement at a time."),
	)
	.min(1)
	.max(1000);

export type BackupRow = Record<string, SqlStorageValue>;

class RollBack extends Error {}

/** Runs the statements together and rolls back whatever they did, returning each one's rows. */
export function readRolledBack(storage: DurableObjectStorage, statements: string[]): BackupRow[][] {
	let rows: BackupRow[][] = [];
	try {
		storage.transactionSync(() => {
			rows = statements.map((sql) => storage.sql.exec<BackupRow>(sql).toArray());
			throw new RollBack();
		});
	} catch (error) {
		if (!(error instanceof RollBack)) throw error;
	}
	return rows;
}

/**
 * Reads for a backup: statements from outside, checked first. A refusal says why, never what was
 * sent, since its message lands in the backup's catalog.
 */
export function readForBackup(storage: DurableObjectStorage, statements: unknown): BackupRow[][] {
	const parsed = backupStatements.safeParse(statements);
	if (!parsed.success) {
		const reason = parsed.error.issues[0]?.message ?? "Not a list of statements.";
		throw new Error(`The object refused the backup's read. ${reason}`);
	}
	return readRolledBack(storage, parsed.data);
}
