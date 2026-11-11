/**
 * Sealing mail kept as it came, a few stored messages at a time, from the mailbox object's alarm.
 *
 * A message stored before sealing, or while the deployment had no `SECRETS_KEY`, has no seal and
 * its mail sits in R2 as it came. Once the deployment has a key, each such message gets a sealed
 * copy under a name of its own, the row switches to it in one synchronous step (object and seal
 * together), and the original is deleted after that, once a grace window has passed, so that a
 * page or a download that read the row just before the switch still finds its object. Whatever
 * stops the work, the row names an object that is there and opens: before the switch it names the
 * original, after it the copy.
 *
 * Nothing here is unknown to the mailbox. The copy's name comes from the message's (`sealedName`),
 * so a copy a stop left behind is overwritten by the next try, or deleted with its message, and
 * the original a stop left behind is kept in the row (`stale_object`) until it is deleted.
 */
import type { MigratedStorage } from "./schema";
import { type RawRef, SealError } from "./sealed";

/** How many messages one run of the alarm seals. */
export const RESEAL_BATCH = 5;

/**
 * How many bytes of mail one run of the alarm seals, counted by the messages' own sizes. A message
 * that is over it alone is still sealed, one to a run: mail streams through, so what a run holds in
 * memory doesn't grow with it, and a run's time does. At most 5 messages and 32 MiB a run keeps
 * the work to a few seconds of R2 and AES-GCM, a small part of what an alarm may take, so the
 * deliveries and sends the alarm also does never wait long behind it, and it runs last.
 */
export const RESEAL_BYTES = 32 * 1024 * 1024;

/** How many stale originals one run deletes. */
const STALE_BATCH = 100;

/**
 * How many times R2 may fail to seal a message before the alarm gives up on it, as on mail that
 * doesn't open.
 */
export const RESEAL_TRIES = 5;

/** What a message's sealed copy is named: the message's own name, with `.sealed` before `.eml`. */
export const sealedName = (object: string) =>
	object.endsWith(".eml") ? `${object.slice(0, -4)}.sealed.eml` : `${object}.sealed`;

/**
 * Not those whose copy may still be read to send or send again: they are sealed once their sending
 * is settled.
 */
const NOT_SENDING = `NOT EXISTS (
	SELECT 1 FROM outgoing
	WHERE outgoing.message = message.id AND outgoing.state NOT IN ('sent', 'discarded')
)`;

/**
 * Stored messages whose mail is as it came, the newest first. Named, as SQLite would otherwise
 * sort every such message on every run.
 */
const UNSEALED = `SELECT id, object, size, seal FROM message INDEXED BY message_unsealed
	WHERE state = 'stored' AND seal IS NULL AND seal_failed_at IS NULL AND ${NOT_SENDING}
	ORDER BY arrived_at DESC, id DESC LIMIT ?`;

/** What a run needs of R2. */
export interface Sealer {
	/** Writes the sealed copy and gives its seal, or null when the server can't seal. */
	copy(from: RawRef, object: string): Promise<string | null>;
	/** Deletes objects by name. Deleting what isn't there is fine. */
	remove(objects: string[]): Promise<void>;
}

/**
 * What a run did: sealed all that waited, left more for the next, or met something R2 gave no
 * answer to, which a later run tries again.
 */
export type Resealed = "done" | "more" | "failed";

const named = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/** When the first original that a sealed copy replaced was replaced, or null when none waits. */
export function oldestStale(storage: MigratedStorage): number | null {
	return storage.sql
		.exec<{ at: number | null }>(
			"SELECT min(stale_at) AS at FROM message INDEXED BY message_stale WHERE stale_object IS NOT NULL",
		)
		.one().at;
}

/**
 * Deletes the originals that sealed copies replaced at `before` or earlier. Later ones are kept
 * for now, so that a page or a download that read a row just before its switch still finds its
 * object. Those R2 can't delete wait for the next run.
 */
export async function dropStale(
	storage: MigratedStorage,
	sealer: Sealer,
	before: number,
): Promise<"done" | "failed"> {
	const sql = storage.sql;
	const stale = sql
		.exec<{ id: string; stale: string }>(
			`SELECT id, stale_object AS stale FROM message INDEXED BY message_stale
			WHERE stale_object IS NOT NULL AND stale_at <= ? LIMIT ?`,
			before,
			STALE_BATCH,
		)
		.toArray();
	if (stale.length === 0) return "done";
	try {
		await sealer.remove(stale.map((row) => row.stale));
	} catch (error) {
		console.error("mailbox: deleting mail that was sealed failed; it will be tried again", {
			name: named(error),
		});
		return "failed";
	}
	for (const row of stale) {
		sql.exec(
			"UPDATE message SET stale_object = NULL, stale_at = NULL WHERE id = ? AND stale_object = ?",
			row.id,
			row.stale,
		);
	}
	return "done";
}

/**
 * Seals a few stored messages' mail, the newest first, as search is indexed. A message whose mail
 * doesn't open is marked and not tried again; one R2 failed on is tried again later while the rest
 * are sealed.
 */
export async function resealBatch(storage: MigratedStorage, sealer: Sealer): Promise<Resealed> {
	const sql = storage.sql;
	const waiting = sql.exec<RawRef & { id: string }>(UNSEALED, RESEAL_BATCH + 1).toArray();
	const batch: typeof waiting = [];
	let bytes = 0;
	for (const row of waiting.slice(0, RESEAL_BATCH)) {
		if (batch.length > 0 && bytes + row.size > RESEAL_BYTES) break;
		batch.push(row);
		bytes += row.size;
	}
	let failures = 0;
	for (const row of batch) {
		const copy = sealedName(row.object);
		let seal: string | null;
		try {
			seal = await sealer.copy(row, copy);
		} catch (error) {
			await forget(sealer, copy);
			if (error instanceof SealError) {
				// Nothing clears this mark. Mail that is missing, or isn't the size its row says, won't
				// mend by trying again, and the message is read as it is, as before. Setting its
				// `seal_failed_at` to NULL in the object's storage would have the alarm try it again.
				sql.exec(
					"UPDATE message SET seal_failed_at = ? WHERE id = ? AND seal IS NULL AND object = ?",
					Date.now(),
					row.id,
					row.object,
				);
				console.error("mailbox: mail kept as it came can't be sealed; it is left as it is", {
					name: error.name,
				});
			} else {
				// Counted, so that mail R2 never gives doesn't hold the alarm in a retry for good. The
				// fifth failure marks it, as mail that doesn't open.
				sql.exec(
					`UPDATE message SET seal_tries = seal_tries + 1,
						seal_failed_at = CASE WHEN seal_tries + 1 >= ? THEN ? END
					WHERE id = ? AND seal IS NULL AND object = ?`,
					RESEAL_TRIES,
					Date.now(),
					row.id,
					row.object,
				);
				const marked = sql
					.exec("SELECT 1 FROM message WHERE id = ? AND seal_failed_at IS NOT NULL", row.id)
					.toArray();
				console.error(
					marked.length > 0
						? "mailbox: sealing a message's mail failed too often; it is left as it is"
						: "mailbox: sealing a message's mail failed; it will be tried again",
					{ name: named(error) },
				);
				failures++;
			}
			continue;
		}
		// The key went away, as when a deployment removes it: nothing is sealed until it is back.
		if (seal === null) return "done";
		let switched: boolean;
		try {
			// One step: the row names the copy, with the seal that opens it, or it is left as it is.
			// Left as it is when the message was deleted, or sealed, or is being sent, while the copy
			// was written.
			switched = storage.transactionSync(() => {
				const still = sql
					.exec(
						`SELECT 1 FROM message WHERE id = ? AND state = 'stored' AND seal IS NULL
							AND object = ? AND ${NOT_SENDING}`,
						row.id,
						row.object,
					)
					.toArray();
				if (still.length === 0) return false;
				sql.exec(
					"UPDATE message SET object = ?, seal = ?, stale_object = ?, stale_at = ? WHERE id = ?",
					copy,
					seal,
					row.object,
					Date.now(),
					row.id,
				);
				return true;
			});
		} catch (error) {
			// The storage went away under this, as when the mailbox was removed meanwhile. What was
			// written is deleted, and the original goes with the rest of the mailbox's mail.
			console.error("mailbox: switching a message to its sealed mail failed", {
				name: named(error),
			});
			await forget(sealer, copy);
			return "done";
		}
		if (!switched) {
			await forget(sealer, copy);
		}
		// The original stays for now: `dropStale` deletes it after the grace window.
	}
	// When none of a run's could be sealed, R2 is likely failing: running again at once won't help.
	if (failures > 0 && failures === batch.length) return "failed";
	if (waiting.length > batch.length) return "more";
	return failures > 0 ? "failed" : "done";
}

/** Deletes a copy nothing names, if it can. A copy R2 won't delete goes with its message. */
async function forget(sealer: Sealer, object: string): Promise<void> {
	try {
		await sealer.remove([object]);
	} catch (error) {
		console.error("mailbox: deleting a copy of mail that wasn't used failed", {
			name: named(error),
		});
	}
}
