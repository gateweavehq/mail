import { type Header, parseHeaders, readHeaderSection, soleField } from "./headers";
import { receivedFrom } from "./people";
import type { MigratedStorage } from "./schema";
import { type RawRef, SealError } from "./sealed";

/** The old listing kept only the first From, and shortened it. Only the original settles it. */
export const indexedSender = (headers: Header[], complete: boolean) =>
	complete ? receivedFrom(soleField(headers, "from")?.value ?? null) : null;

const PENDING = "state = 'stored' AND sent_by IS NULL AND sender_check_at IS NOT NULL";

export function nextSenderCheck(sql: SqlStorage): number | null {
	return sql
		.exec<{ at: number | null }>(
			`SELECT min(sender_check_at) AS at FROM message WHERE ${PENDING} AND sender_check_at >= 0`,
		)
		.one().at;
}

/** The alarm checks a batch; a send can first check a few candidates that might answer its query. */
export async function checkOldSenders(
	storage: MigratedStorage,
	open: (ref: RawRef) => Promise<ReadableStream<Uint8Array> | null>,
	now: number,
	wanted?: string[],
): Promise<void> {
	const sql = storage.sql;
	type Row = RawRef & {
		id: string;
		hint: string | null;
		attempts: number;
		backoff: number;
		due: number;
	};
	const select = `SELECT id, sender_address AS hint, sender_attempts AS attempts, sender_backoff AS backoff, sender_check_at AS due, object, seal, size FROM message WHERE ${PENDING} AND sender_check_at <= ?`;
	const rows = wanted?.length
		? sql
				.exec<Row>(
					`${select} AND sender_address IN (${wanted.map(() => "?").join(", ")}) LIMIT 2`,
					now,
					...wanted,
				)
				.toArray()
		: [];
	const remaining = (wanted ? 2 : 8) - rows.length;
	if (remaining) {
		rows.push(
			...sql
				.exec<Row>(
					`${select} AND sender_check_at >= 0
			${wanted ? "AND sender_address IS NULL" : ""} ORDER BY sender_check_at LIMIT ?`,
					now,
					remaining,
				)
				.toArray(),
		);
	}
	for (const row of rows) {
		// Claim the try before opening R2. A send and the alarm may have selected the same row.
		const lease = now + 60_000;
		const claimed = sql.exec(
			`UPDATE message SET sender_check_at = ?, sender_check_started = coalesce(sender_check_started, ?) WHERE id = ? AND sender_check_at = ? RETURNING id`,
			lease,
			now,
			row.id,
			row.due,
		);
		if (!claimed.toArray().length) continue;
		let address: string | null = null;
		let attempts = row.attempts;
		let backoff = 0;
		let next: number | null = null;
		try {
			const stream = await open(row);
			if (!stream) throw new SealError("Stored mail is missing");
			const { block, complete } = await readHeaderSection(stream);
			try {
				address = indexedSender(parseHeaders(block), complete);
			} catch {
				throw new SealError("Stored headers could not be parsed");
			}
		} catch (error) {
			if (error instanceof SealError && error.kind !== "no-key") {
				attempts++;
				if (attempts < 3) next = lease;
			} else {
				next = now + Math.min(60, 2 ** row.backoff) * 60_000;
				backoff = Math.min(6, row.backoff + 1);
			}
		}
		const changed = sql.exec(
			`UPDATE message SET sender_address = ?, sender_attempts = ?, sender_backoff = ?, sender_check_at = ?
			WHERE id = ? AND sender_check_at = ? RETURNING id`,
			next === null ? address : row.hint,
			attempts,
			backoff,
			next,
			row.id,
			lease,
		);
		if (!changed.toArray().length || next !== null) continue;
		if (row.hint && row.hint !== address) queueHint(sql, row.hint);
	}
}

/** Queue one candidate at a time. Once one confirms the address, no more need to be opened. */
function queueHint(sql: SqlStorage, address: string): void {
	sql.exec(
		`UPDATE message SET sender_check_at = 0 WHERE id = (
		SELECT id FROM message WHERE ${PENDING} AND sender_address = ? AND sender_check_at = -1 LIMIT 1
	) AND NOT EXISTS (SELECT 1 FROM message WHERE ${PENDING} AND sender_address = ? AND sender_check_at >= 0)`,
		address,
		address,
	);
}

/** Which missing addresses the alarm could still establish. A clipped From could be any of them. */
export function pendingSenders(sql: SqlStorage, missing: string[], now = Date.now()): string[] {
	if (!missing.length) return [];
	// A retryable answer has to end, or an agent can loop on one unreadable message. So the hour
	// runs from when the check was recorded (arrival or the upgrade), not from when it is first
	// tried: a candidate queued behind one that keeps failing is never tried. A row without a start
	// holds nothing.
	const holding = `${PENDING} AND sender_check_started > ?`;
	const cutoff = now - 60 * 60_000;
	const hints = sql
		.exec<{ address: string }>(
			`SELECT DISTINCT sender_address AS address FROM message
		WHERE ${holding} AND sender_address IN (${missing.map(() => "?").join(", ")})`,
			cutoff,
			...missing,
		)
		.toArray()
		.map(({ address }) => address);
	for (const address of hints) queueHint(sql, address);
	const clipped = sql
		.exec(`SELECT 1 FROM message WHERE ${holding} AND sender_address IS NULL LIMIT 1`, cutoff)
		.toArray();
	return clipped.length ? missing : hints;
}
