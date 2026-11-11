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
 * After `SECRETS_KEY` changes, with the old one kept as `SECRETS_KEY_PREVIOUS`, mail sealed under
 * the old key, or under a seal from before keys had ids (`v1`), is sealed again under the new one
 * the same way, so that the old key can go once none is left (`resealStatus`, which the daily run
 * asks each mailbox).
 *
 * Nothing here is unknown to the mailbox. The copy's name comes from the message's (`sealedName`,
 * `rekeyedName`), so a copy a stop left behind is overwritten by the next try, or deleted with its
 * message, and the original a stop left behind is kept in the row (`stale_object`) until it is
 * deleted.
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
 * What a message's mail is named once sealed again under the key `keyId`: beside its object, with
 * the message's id and the key's, so that each change of key writes a name of its own.
 */
export const rekeyedName = (object: string, id: string, keyId: string) =>
	`${object.slice(0, object.lastIndexOf("/") + 1)}${id}.${keyId}.eml`;

/** The ids of the deployment's keys (`secrets-key.ts`), as far as sealing mail again goes. */
export interface KeyIds {
	current: string;
	/** Mail under this key, or under a seal that names none (`v1`), is sealed again. */
	previous: string | null;
}

/**
 * Not one being tried right now: it is sealed by a later run, once the try is over. Mail waiting to
 * be sent, approved or sent again is sealed like the rest, as it may wait for good. Each try reads
 * the copy through the row, and the original outlives the switch by the grace window.
 */
const NOT_SENDING = `NOT EXISTS (
	SELECT 1 FROM outgoing WHERE outgoing.message = message.id AND outgoing.state = 'sending'
)`;

/**
 * Stored messages whose mail is as it came, the newest first. Named, as SQLite would otherwise
 * sort every such message on every run.
 */
const UNSEALED = `SELECT id, object, size, seal FROM message INDEXED BY message_unsealed
	WHERE state = 'stored' AND seal IS NULL AND seal_failed_at IS NULL AND ${NOT_SENDING}
	ORDER BY arrived_at DESC, id DESC LIMIT ?`;

/**
 * Seals as a range of `message_sealed`: those that name the key `id`, or from before ids. A key id
 * never holds a dot, and `/` sorts right after it.
 */
const keyRange = (id: string) => [`v2.${id}.`, `v2.${id}/`] as const;
const BEFORE_IDS = ["v1.", "v1/"] as const;

/**
 * Stored messages whose mail is sealed in one range of seals and waits to be sealed again: not
 * one whose original still waits to be deleted, that R2 failed on too often since the daily run
 * last asked, or that didn't open under this previous key.
 */
const UNDER_PREVIOUS = `SELECT id, object, size, seal FROM message INDEXED BY message_sealed
	WHERE state = 'stored' AND seal IS NOT NULL AND seal >= ? AND seal < ?
		AND stale_object IS NULL AND seal_tries < ${RESEAL_TRIES} AND rekey_failed IS NOT ?
		AND ${NOT_SENDING}
	LIMIT ?`;

/** Up to `limit` stored messages whose mail waits to be sealed under the current key. */
function underPrevious(storage: MigratedStorage, keys: KeyIds, limit: number) {
	const rows: (RawRef & { id: string })[] = [];
	if (!keys.previous) return rows;
	for (const [from, to] of [BEFORE_IDS, keyRange(keys.previous)]) {
		if (rows.length >= limit) break;
		rows.push(
			...storage.sql
				.exec<RawRef & { id: string }>(UNDER_PREVIOUS, from, to, keys.previous, limit - rows.length)
				.toArray(),
		);
	}
	return rows;
}

/** Whether the alarm has mail to seal again under the current key. */
export const waitsUnderPrevious = (storage: MigratedStorage, keys: KeyIds) =>
	underPrevious(storage, keys, 1).length > 0;

/** What a mailbox still holds under a key other than the current one. */
export interface ResealStatus {
	/** Messages whose mail still needs `SECRETS_KEY_PREVIOUS`: under it, or sealed before ids. */
	left: number;
	/** Messages whose mail opens with neither key, or names a key the server doesn't have. */
	unopened: number;
}

/**
 * What a mailbox holds under its previous key, for the daily run, which may take the key away once
 * no mailbox has any left. Mail R2 failed on too often is tried again from now on.
 */
export function resealStatus(
	storage: MigratedStorage,
	keys: KeyIds & { previous: string },
): ResealStatus {
	const sql = storage.sql;
	const count = (where: string, ...params: string[]) =>
		sql
			.exec<{ count: number }>(
				`SELECT count(*) AS count FROM message INDEXED BY message_sealed
				WHERE state = 'stored' AND seal IS NOT NULL AND ${where}`,
				...params,
			)
			.one().count;
	sql.exec(
		`UPDATE message SET seal_tries = 0
		WHERE state = 'stored' AND seal IS NOT NULL AND seal_tries >= ?`,
		RESEAL_TRIES,
	);
	const [from, to] = keyRange(keys.current);
	const notCurrent = count("seal < ?", from) + count("seal >= ?", to);
	let left = 0;
	for (const [start, end] of [BEFORE_IDS, keyRange(keys.previous)]) {
		left += count("seal >= ? AND seal < ? AND rekey_failed IS NOT ?", start, end, keys.previous);
	}
	// A delivery still on its way, sealed by a Worker that had another key, as during a deploy.
	const pending = sql
		.exec<{ count: number }>(
			`SELECT count(*) AS count FROM message
			WHERE state = 'pending' AND seal IS NOT NULL AND (seal < ? OR seal >= ?)`,
			from,
			to,
		)
		.one().count;
	return { left: left + pending, unopened: notCurrent - left };
}

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
 * Seals a few stored messages' mail, the newest first, as search is indexed, then, with `keys`,
 * seals again under the current key mail under the previous one. A message whose mail doesn't open
 * is marked and not tried again; one R2 failed on is tried again later while the rest are sealed.
 */
export async function resealBatch(
	storage: MigratedStorage,
	sealer: Sealer,
	keys: KeyIds | null = null,
): Promise<Resealed> {
	const sql = storage.sql;
	const unsealed = sql.exec<RawRef & { id: string }>(UNSEALED, RESEAL_BATCH + 1).toArray();
	const waiting = keys
		? [...unsealed, ...underPrevious(storage, keys, RESEAL_BATCH + 1 - unsealed.length)]
		: unsealed;
	const batch: typeof waiting = [];
	let bytes = 0;
	for (const row of waiting.slice(0, RESEAL_BATCH)) {
		if (batch.length > 0 && bytes + row.size > RESEAL_BYTES) break;
		batch.push(row);
		bytes += row.size;
	}
	let failures = 0;
	for (const row of batch) {
		const again = typeof row.seal === "string" ? keys : null;
		const copy = again ? rekeyedName(row.object, row.id, again.current) : sealedName(row.object);
		let seal: string | null;
		try {
			seal = await sealer.copy(row, copy);
		} catch (error) {
			await forget(sealer, copy);
			if (error instanceof SealError && again) {
				// Opens with neither key, or is missing. Marked with the previous key, so that another
				// SECRETS_KEY_PREVIOUS has it tried again; it is left as it is, under its own seal.
				sql.exec(
					"UPDATE message SET rekey_failed = ? WHERE id = ? AND seal IS ? AND object = ?",
					again.previous,
					row.id,
					row.seal,
					row.object,
				);
				console.error("mailbox: mail under the previous SECRETS_KEY can't be sealed again", {
					name: error.name,
				});
			} else if (error instanceof SealError) {
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
				// Mail under the previous key that fails too often waits until the daily run asks again.
				sql.exec(
					`UPDATE message SET seal_tries = seal_tries + 1,
						seal_failed_at = CASE WHEN seal IS NULL AND seal_tries + 1 >= ? THEN ? END
					WHERE id = ? AND seal IS ? AND object = ?`,
					RESEAL_TRIES,
					Date.now(),
					row.id,
					row.seal,
					row.object,
				);
				const tries = sql
					.exec<{ tries: number }>("SELECT seal_tries AS tries FROM message WHERE id = ?", row.id)
					.toArray()[0]?.tries;
				console.error(
					(tries ?? 0) >= RESEAL_TRIES
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
						`SELECT 1 FROM message WHERE id = ? AND state = 'stored' AND seal IS ?
							AND object = ? AND stale_object IS NULL AND ${NOT_SENDING}`,
						row.id,
						row.seal,
						row.object,
					)
					.toArray();
				if (still.length === 0) return false;
				sql.exec(
					`UPDATE message SET object = ?, seal = ?, stale_object = ?, stale_at = ?, seal_tries = 0,
						rekey_failed = NULL
					WHERE id = ?`,
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
