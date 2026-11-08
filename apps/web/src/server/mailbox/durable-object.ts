import { DurableObject } from "cloudflare:workers";
import { bodyHash } from "./body";

/** How much one mailbox may hold unless `MAILBOX_BYTES` says otherwise, counting messages on their way in. */
export const MAILBOX_BYTES = 1024 * 1024 * 1024;

/** How much a mailbox may hold here: `MAILBOX_BYTES` when it is set to a whole number, or 1 GiB. */
export function mailboxLimit(env: Cloudflare.Env): number {
	const set = Number(env.MAILBOX_BYTES);
	return env.MAILBOX_BYTES && Number.isSafeInteger(set) && set > 0 ? set : MAILBOX_BYTES;
}

/** How long a delivery may take between being given a place and saying it's there. */
export const PENDING_MS = 15 * 60 * 1000;

/** The most messages one listing returns. */
export const MAX_LISTED = 100;

/** What `email()` knows of a message before storing it. */
export interface Arrival {
	workspaceId: string;
	mailboxId: string;
	/** From `deliveryKey`: the same for every delivery of one message. */
	key: string;
	size: number;
	envelopeFrom: string;
	envelopeTo: string;
	from: string | null;
	subject: string | null;
	date: string | null;
	messageId: string | null;
	/** Cloudflare's DMARC verdict, from `cloudflareVerdict`. */
	dmarc: string | null;
	/** The domain the message is proved to come from, from `verifiedDomain`. */
	verifiedDomain: string | null;
}

export type Begun = { ok: true; id: string; object: string } | { ok: false; reason: "full" };

// Types, not interfaces, so that SQLite's rows can be read as them.

/** One message as a listing shows it. Header values are as sent, not decoded. */
export type StoredSummary = {
	id: string;
	arrivedAt: number;
	size: number;
	from: string | null;
	subject: string | null;
	date: string | null;
	dmarc: string | null;
	verifiedDomain: string | null;
};

export type StoredMessage = StoredSummary & {
	object: string;
	envelopeFrom: string;
	envelopeTo: string;
	messageId: string | null;
};

/** Where a listing goes on from: the last message it showed. */
export interface Cursor {
	arrivedAt: number;
	id: string;
}

// A message is pending from when it is given a place until its mail is in R2, then stored. One
// that took too long is expired, until the alarm has deleted what reached R2 of it.
const SCHEMA = `
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

const SUMMARY = `id, arrived_at AS arrivedAt, size, from_header AS "from", subject, date_header AS date,
	dmarc, verified_domain AS verifiedDomain`;

/**
 * One mailbox: its messages' index in SQLite, their raw mail in R2 under
 * `<workspace>/<mailbox>/`. Each mailbox has its own instance, named by the mailbox's id.
 *
 * It has no route of its own. The Worker reaches it after checking who is asking: `email()` after
 * looking the address up in the directory, pages after checking membership.
 *
 * Every R2 object is named here before it is written, as a pending message, and an alarm removes
 * those that never arrive. So R2 holds nothing the mailbox doesn't know about, and removing a
 * mailbox's prefix removes all of it. The `held` row keeps what the messages add up to, through
 * triggers, so that a delivery doesn't have to count them.
 */
export class Mailbox extends DurableObject<Cloudflare.Env> {
	/** Deliveries of one message finish one at a time, so a retry can't pass another unnoticed. */
	#finishing = new Map<string, Promise<unknown>>();

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA);
	}

	/** Gives a message a place in R2, or says the mailbox is full. */
	async begin(arrival: Arrival): Promise<Begun> {
		const sql = this.ctx.storage.sql;
		// Read and written before anything is awaited, so two deliveries can't both take the last space.
		const held = sql
			.exec<{ bytes: number; latest: number }>("SELECT bytes, latest FROM held")
			.one();
		if (held.bytes + arrival.size > mailboxLimit(this.env)) return { ok: false, reason: "full" };
		const id = crypto.randomUUID();
		const object = `${arrival.workspaceId}/${arrival.mailboxId}/${id}.eml`;
		// Later than everything before it, so the order of arrival is the order shown even when two
		// arrive within a millisecond.
		const arrivedAt = Math.max(Date.now(), held.latest + 1);
		sql.exec(
			`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
				envelope_to, from_header, subject, date_header, message_id, dmarc, verified_domain)
			VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			arrival.key,
			object,
			arrival.size,
			arrivedAt,
			arrival.envelopeFrom,
			arrival.envelopeTo,
			arrival.from,
			arrival.subject,
			arrival.date,
			arrival.messageId,
			arrival.dmarc,
			arrival.verifiedDomain,
		);
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + PENDING_MS);
		}
		return { ok: true, id, object };
	}

	/**
	 * Says a message's raw mail is in R2. A message already stored with the same delivery key and
	 * the same body is a retry, and this copy goes. With another body it is a different message,
	 * which stays, so someone who guessed a mail's headers can't get it dropped. "gone" means the
	 * mailbox no longer knows the delivery, and nothing keeps its mail.
	 */
	async finish(id: string): Promise<"stored" | "duplicate" | "gone"> {
		const row = this.ctx.storage.sql
			.exec<{ key: string }>(
				"SELECT delivery_key AS key FROM message WHERE id = ? AND state = 'pending'",
				id,
			)
			.toArray()[0];
		if (!row) return "gone";
		const key = row.key;
		const before = this.#finishing.get(key) ?? Promise.resolve();
		const turn = before.catch(() => {}).then(() => this.#finishOne(id, key));
		this.#finishing.set(key, turn);
		try {
			return await turn;
		} finally {
			if (this.#finishing.get(key) === turn) this.#finishing.delete(key);
		}
	}

	async #finishOne(id: string, key: string): Promise<"stored" | "duplicate" | "gone"> {
		const sql = this.ctx.storage.sql;
		const mine = sql
			.exec<{ object: string }>("SELECT object FROM message WHERE id = ? AND state = 'pending'", id)
			.toArray()[0];
		if (!mine) return "gone";
		const earlier = sql
			.exec("SELECT 1 FROM message WHERE delivery_key = ? AND state = 'stored' LIMIT 1", key)
			.toArray();
		if (earlier.length === 0) return this.#store(id);

		const myHash = await bodyHash(this.env.RAW_MAIL, mine.object);
		if (myHash === null) throw new Error("A delivered message isn't in R2");
		// The first message under a key was stored without its body's hash, as there was nothing to
		// compare it with then.
		const unhashed = sql
			.exec<{ id: string; object: string }>(
				"SELECT id, object FROM message WHERE delivery_key = ? AND state = 'stored' AND body_hash IS NULL",
				key,
			)
			.toArray();
		for (const other of unhashed) {
			const hash = await bodyHash(this.env.RAW_MAIL, other.object);
			if (hash !== null) sql.exec("UPDATE message SET body_hash = ? WHERE id = ?", hash, other.id);
		}
		const same = sql
			.exec(
				"SELECT 1 FROM message WHERE delivery_key = ? AND body_hash = ? AND state = 'stored' LIMIT 1",
				key,
				myHash,
			)
			.toArray();
		if (same.length > 0) {
			// The mail goes before its row. Should deleting it fail, the row is still pending, and the
			// alarm removes both.
			await this.env.RAW_MAIL.delete(mine.object);
			sql.exec("DELETE FROM message WHERE id = ? AND state = 'pending'", id);
			return "duplicate";
		}
		sql.exec("UPDATE message SET body_hash = ? WHERE id = ?", myHash, id);
		return this.#store(id);
	}

	#store(id: string): "stored" | "gone" {
		const { rowsWritten } = this.ctx.storage.sql.exec(
			"UPDATE message SET state = 'stored' WHERE id = ? AND state = 'pending'",
			id,
		);
		return rowsWritten > 0 ? "stored" : "gone";
	}

	/** Stored messages, newest first, after `before` when given. */
	list(before: Cursor | null, limit: number): StoredSummary[] {
		const take = Math.min(Math.max(1, limit), MAX_LISTED);
		const sql = this.ctx.storage.sql;
		const rows = before
			? sql.exec<StoredSummary>(
					`SELECT ${SUMMARY} FROM message WHERE state = 'stored' AND (arrived_at, id) < (?, ?)
					ORDER BY arrived_at DESC, id DESC LIMIT ?`,
					before.arrivedAt,
					before.id,
					take,
				)
			: sql.exec<StoredSummary>(
					`SELECT ${SUMMARY} FROM message WHERE state = 'stored'
					ORDER BY arrived_at DESC, id DESC LIMIT ?`,
					take,
				);
		return rows.toArray();
	}

	/** One stored message, or null when there is no such message here. */
	get(id: string): StoredMessage | null {
		return (
			this.ctx.storage.sql
				.exec<StoredMessage>(
					`SELECT ${SUMMARY}, object, envelope_from AS envelopeFrom, envelope_to AS envelopeTo,
						message_id AS messageId
					FROM message WHERE id = ? AND state = 'stored'`,
					id,
				)
				.toArray()[0] ?? null
		);
	}

	/**
	 * Deletes a stored message, which frees its space. Its mail goes first, so a failure leaves the
	 * message as it was. False when there is no such message.
	 */
	async remove(id: string): Promise<boolean> {
		const sql = this.ctx.storage.sql;
		const row = sql
			.exec<{ object: string }>("SELECT object FROM message WHERE id = ? AND state = 'stored'", id)
			.toArray()[0];
		if (!row) return false;
		await this.env.RAW_MAIL.delete(row.object);
		sql.exec("DELETE FROM message WHERE id = ?", id);
		return true;
	}

	/**
	 * Removes everything this mailbox holds: its index first, then its raw mail. Safe to run again,
	 * which the daily run does for every removal.
	 */
	async destroy(prefix: string): Promise<void> {
		if (!/^[0-9A-Za-z_-]+\/[0-9A-Za-z_-]+\/$/.test(prefix)) throw new Error("Not a mailbox prefix");
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		await deletePrefix(this.env.RAW_MAIL, prefix);
	}

	/** Removes deliveries that never said they arrived, with whatever part of them reached R2. */
	override async alarm(): Promise<void> {
		const sql = this.ctx.storage.sql;
		// Marked before anything is awaited. A delivery that finishes from here on finds its row gone
		// and is tried again, rather than being stored with its mail deleted below.
		sql.exec(
			"UPDATE message SET state = 'expired' WHERE state = 'pending' AND arrived_at <= ?",
			Date.now() - PENDING_MS,
		);
		const expired = sql
			.exec<{ id: string; object: string }>(
				"SELECT id, object FROM message WHERE state = 'expired'",
			)
			.toArray();
		// R2 deletes at most a thousand keys at once. A row goes once its mail has, so what fails
		// here is still expired when the alarm is tried again.
		for (let at = 0; at < expired.length; at += 1000) {
			const chunk = expired.slice(at, at + 1000);
			await this.env.RAW_MAIL.delete(chunk.map((row) => row.object));
			for (const row of chunk) sql.exec("DELETE FROM message WHERE id = ?", row.id);
		}
		const next = sql
			.exec<{ at: number | null }>(
				"SELECT min(arrived_at) AS at FROM message WHERE state = 'pending'",
			)
			.one();
		if (next.at !== null) await this.ctx.storage.setAlarm(next.at + PENDING_MS);
	}
}

/** Deletes every object under a prefix, a thousand at a time. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
	for (;;) {
		const listed = await bucket.list({ prefix, limit: 1000 });
		if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
		if (!listed.truncated) return;
	}
}
