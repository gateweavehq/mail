import { DurableObject } from "cloudflare:workers";
import type { SendStatus } from "../../lib/outbox";
import { KEY_CHANGED, RESEND_CODE, type SendsWith } from "../../lib/providers";
import { createDb } from "../db";
import { openProviderKey } from "../providers/keys";
import { RESEND_API, type ResendFailure, sendWithResend } from "../providers/resend";
import { bodyHash } from "./body";
import { DELIVERIES_JSON, type DeliveryEvent, RECIPIENT_COUNT, recordDelivery } from "./deliveries";
import { type Outcome, outcomeOf, resendOutcome, STALE_SENDING_MS, WAITS_MS } from "./delivery";
import { indexBatch } from "./indexing";
import { LINKED_THREADS, migrate } from "./schema";
import { ftsQuery, searchable } from "./search";
import { MAX_REFERENCES, messageIds, subjectKey } from "./thread";

/** How much one mailbox may hold unless `MAILBOX_BYTES` says otherwise, counting messages on their way in. */
export const MAILBOX_BYTES = 1024 * 1024 * 1024;

/** How much a mailbox may hold here: `MAILBOX_BYTES` when it is set to a whole number, or 1 GiB. */
export function mailboxLimit(env: Cloudflare.Env): number {
	const set = Number(env.MAILBOX_BYTES);
	return env.MAILBOX_BYTES && Number.isSafeInteger(set) && set > 0 ? set : MAILBOX_BYTES;
}

/** How long a delivery may take between being given a place and saying it's there. */
export const PENDING_MS = 15 * 60 * 1000;

/** The most messages or threads one listing returns. */
export const MAX_LISTED = 100;

/** The most senders a thread's listing names. */
const MAX_SENDERS = 5;

/** How many of a thread's first messages its listing looks through for senders. */
const SENDERS_READ = 200;

/** How long after a message is stored the alarm indexes it, so that a burst is indexed together. */
const INDEX_DELAY_MS = 1000;

/** How long indexing waits after R2 failed to give it a message's mail. */
const INDEX_RETRY_MS = 60_000;

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
	// These two are missing from a Worker older than threads, which can still be running while a
	// deploy reaches every place. The object then finds the message's own id in `messageId`, and it
	// is stored without references.
	/** The id in `messageId`, from `ownId`. */
	ownId?: string | null;
	/** The ids it replies to or follows, from `referencedIds`. */
	references?: string[];
	/**
	 * The DMARC result of the server that took the mail: Cloudflare's, from `cloudflareVerdict`, or
	 * Resend's, from its API.
	 */
	dmarc: string | null;
	/** The domain the message is proved to come from, from `verifiedDomain` or `resendVerifiedDomain`. */
	verifiedDomain: string | null;
}

export type Begun = { ok: true; id: string; object: string } | { ok: false; reason: "full" };

/** A message the mailbox sends: the copy it keeps, and what Email Service is asked to send. */
export interface Sending {
	workspaceId: string;
	mailboxId: string;
	/** The membership of whoever sends it. */
	sentBy: string;
	/** The copy, as raw mail. */
	raw: string;
	/** Its headers as the copy has them. */
	from: string;
	subject: string;
	date: string;
	/** The address it is sent from, and those it goes to, joined. */
	envelopeFrom: string;
	envelopeTo: string;
	/** Mail's own id for it. */
	ownId: string;
	/** The ids it follows, which thread it. */
	references: string[];
	/** What the `EMAIL` binding's `send()` is given, and what Resend's request is made from. */
	request: EmailMessageBuilder;
	/** How it goes: by its domain's setting when it was written. */
	provider: SendsWith;
	/** The draft's own id, which makes a second send of it the first one's. */
	draft: string;
	/**
	 * Whether it waits for a person to approve it before anything is sent, as an agent's mail to
	 * someone it isn't allowed to write to does.
	 */
	hold: boolean;
}

/** The states a person may discard a message the mailbox sent from. */
const DISCARDABLE = new Set(["held", "refused", "uncertain", "waiting", "discarded"]);

/** A message waiting for a person to approve it, as the mailbox's page lists it. */
export type Awaiting = {
	id: string;
	threadId: string;
	subject: string | null;
	sentBy: string | null;
	arrivedAt: number;
};

/** A message as a try finds it. */
type Trying = {
	request: string;
	attempts: number;
	provider: string;
	workspaceId: string | null;
	idempotencyKey: string | null;
	/** 1 when a try under its idempotency key may have sent it. */
	maybeSent: number;
	/** Which saving of the workspace's Resend key the last try used. */
	keyVersion: string | null;
};

/** How handing a message over went. */
type Delivered =
	| { ok: true; providerId: string | null }
	| {
			ok: false;
			outcome: Outcome;
			detail: string | null;
			/** Whether Resend turned the request down, which spends its key. */
			answered: boolean;
			/** Whether this try may have sent it. */
			maybeSent: boolean;
	  };

export type Sent =
	| ({ ok: true; id: string; threadId: string } & SendStatus)
	// "busy": a send of the same draft is still storing its copy.
	| { ok: false; reason: "full" | "busy" };

// Types, not interfaces, so that SQLite's rows can be read as them.

/** One message as a listing shows it. Header values are as sent, not decoded. */
export type StoredSummary = {
	id: string;
	threadId: string;
	arrivedAt: number;
	size: number;
	from: string | null;
	subject: string | null;
	date: string | null;
	dmarc: string | null;
	verifiedDomain: string | null;
	/** For a message the mailbox sent, the membership of whoever sent it. */
	sentBy: string | null;
	/** For a message the mailbox sent, its `SendStatus` as JSON. */
	sending: string | null;
	/** For a message that waited for approval, the membership of whoever approved it. */
	approvedBy: string | null;
	/** For a message the mailbox sent, its recipients' `Delivery` records as a JSON array. */
	deliveries: string;
	/** For a message the mailbox sent, how many addresses it went to; 0 for any other. */
	recipients: number;
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

/** Where a listing of threads goes on from: the last thread it showed. */
export interface ThreadCursor {
	latestAt: number;
	id: string;
}

/** One thread as a listing shows it. Header values are as sent, not decoded. */
export interface ThreadSummary {
	id: string;
	latestAt: number;
	count: number;
	/**
	 * The newest message's, like the proved domain beside it: anyone who knows a message's id and
	 * subject can start its thread, and their subject mustn't seem to come from whoever was proved.
	 */
	subject: string | null;
	/** The From headers of its first messages, each once, in the order they first wrote. */
	senders: (string | null)[];
	/** The domain its newest message is proved to come from. */
	latestVerifiedDomain: string | null;
}

/** A thread's own row. */
type ThreadRow = { id: string; latestAt: number; count: number };

/** A page of a thread. */
export interface ThreadMessages {
	/** How many messages it has, on every page. */
	count: number;
	/** Its newest message's, as in `ThreadSummary`. */
	subject: string | null;
	/** Newest first. */
	messages: StoredSummary[];
}

const SUMMARY = `id, thread_id AS threadId, arrived_at AS arrivedAt, size, from_header AS "from",
	subject, date_header AS date, dmarc, verified_domain AS verifiedDomain, sent_by AS sentBy,
	(SELECT json_object('state', state, 'code', code, 'nextAt', next_at, 'detail', detail) FROM outgoing
		WHERE outgoing.message = message.id) AS sending,
	(SELECT approved_by FROM outgoing WHERE outgoing.message = message.id) AS approvedBy,
	${DELIVERIES_JSON} AS deliveries, ${RECIPIENT_COUNT} AS recipients`;

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
 *
 * Search indexes a message after it is stored, in the alarm, so a delivery never waits for its
 * mail to be parsed.
 */
export class Mailbox extends DurableObject<Cloudflare.Env> {
	/** Deliveries of one message finish one at a time, so a retry can't pass another unnoticed. */
	#finishing = new Map<string, Promise<unknown>>();

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		migrate(ctx.storage);
		// Messages that wait to be indexed, as after an upgrade, or when the object went away before
		// it set its alarm, are indexed soon. An index finds them.
		const waiting = ctx.storage.sql
			.exec("SELECT 1 FROM message WHERE state = 'stored' AND search_id IS NULL LIMIT 1")
			.toArray();
		if (waiting.length > 0) void ctx.blockConcurrencyWhile(() => this.#indexSoon());
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
				envelope_to, from_header, subject, date_header, message_id, dmarc, verified_domain,
				own_id, subject_key)
			VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			arrival.ownId ?? messageIds(arrival.messageId)[0] ?? null,
			subjectKey(arrival.subject),
		);
		for (const ref of (arrival.references ?? []).slice(-MAX_REFERENCES)) {
			sql.exec("INSERT OR IGNORE INTO message_reference (message, ref) VALUES (?, ?)", id, ref);
		}
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
			const result = await turn;
			if (result === "stored") await this.#indexSoon();
			return result;
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

	/**
	 * Stores a pending message in a thread. It joins one when it names a stored message here, a
	 * stored message names it, or the two name the same message, which may be one this mailbox never
	 * got, such as mail its people sent from elsewhere. Their subjects must be the same, too, once
	 * `Re:` and its kin are off. A subject alone never joins a thread, as anyone can write one. A
	 * message that links threads merges them into the one that began first.
	 */
	#store(id: string): "stored" | "gone" {
		const sql = this.ctx.storage.sql;
		return this.ctx.storage.transactionSync(() => {
			const me = sql
				.exec<{ ownId: string | null; subjectKey: string; arrivedAt: number }>(
					`SELECT own_id AS ownId, subject_key AS subjectKey, arrived_at AS arrivedAt
					FROM message WHERE id = ? AND state = 'pending'`,
					id,
				)
				.toArray()[0];
			if (!me) return "gone";
			const [first, ...others] = sql
				.exec<{ id: string }>(
					LINKED_THREADS,
					me.subjectKey,
					id,
					// A message with no id of its own can't be named; null matches nothing.
					me.ownId,
					id,
				)
				.toArray()
				.map((row) => row.id);
			const threadId = first ?? crypto.randomUUID();
			if (!first) {
				sql.exec(
					"INSERT INTO thread (id, first_at, latest_at, count) VALUES (?, ?, ?, 0)",
					threadId,
					me.arrivedAt,
					me.arrivedAt,
				);
			}
			for (const other of others) {
				sql.exec("UPDATE message SET thread_id = ? WHERE thread_id = ?", threadId, other);
				sql.exec("DELETE FROM thread WHERE id = ?", other);
			}
			sql.exec("UPDATE message SET state = 'stored', thread_id = ? WHERE id = ?", threadId, id);
			this.#refreshThread(threadId);
			return "stored";
		});
	}

	/**
	 * Sends a message a person or an agent wrote. Its copy is stored first, in its thread, as mail
	 * that arrives is, and then Email Service is asked to send it; the answer says what became of
	 * it. One to `hold` is only stored, until a person approves it. The copy counts against the
	 * mailbox's space, so a full mailbox sends nothing.
	 */
	async send(sending: Sending): Promise<Sent> {
		const sql = this.ctx.storage.sql;
		// The same draft again, as when its answer was lost: what became of it, not a second send.
		const earlier = this.drafted(sending.draft);
		if (earlier) return earlier;
		const size = new TextEncoder().encode(sending.raw).length;
		const held = sql
			.exec<{ bytes: number; latest: number }>("SELECT bytes, latest FROM held")
			.one();
		if (held.bytes + size > mailboxLimit(this.env)) return { ok: false, reason: "full" };
		const id = crypto.randomUUID();
		const object = `${sending.workspaceId}/${sending.mailboxId}/${id}.eml`;
		const arrivedAt = Math.max(Date.now(), held.latest + 1);
		// Pending until its copy is in R2, as a delivery is, so the alarm clears it should R2 fail.
		this.ctx.storage.transactionSync(() => {
			sql.exec(
				`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
					envelope_to, from_header, subject, date_header, message_id, own_id, subject_key, sent_by)
				VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				`sent:${id}`,
				object,
				size,
				arrivedAt,
				sending.envelopeFrom,
				sending.envelopeTo,
				sending.from,
				sending.subject,
				sending.date,
				`<${sending.ownId}>`,
				sending.ownId,
				subjectKey(sending.subject),
				sending.sentBy,
			);
			for (const ref of sending.references.slice(-MAX_REFERENCES)) {
				sql.exec("INSERT OR IGNORE INTO message_reference (message, ref) VALUES (?, ?)", id, ref);
			}
			// Not tried yet: should nothing try it, the alarm finds it waiting after a while. One held
			// for approval is left alone by the alarm.
			sql.exec(
				`INSERT INTO outgoing (message, state, request, attempted_at, draft, provider, workspace_id,
					idempotency_key)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				sending.hold ? "held" : "sending",
				JSON.stringify(sending.request),
				sending.hold ? null : Date.now(),
				sending.draft,
				sending.provider,
				sending.workspaceId,
				id,
			);
		});
		await this.#alarmBy(Date.now() + PENDING_MS);
		await this.env.RAW_MAIL.put(object, sending.raw);
		if (this.#store(id) === "gone") throw new Error("The copy was given up before it was stored");
		const threadId = sql
			.exec<{ threadId: string }>("SELECT thread_id AS threadId FROM message WHERE id = ?", id)
			.one().threadId;
		await this.#indexSoon();
		if (sending.hold) return { ok: true, id, threadId, ...this.#status(id) };
		return { ok: true, id, threadId, ...((await this.#tryNow(id, "first")) ?? this.#status(id)) };
	}

	/**
	 * Sends a message that waited for approval, once, as approved by this membership. Null when
	 * there is no such message here, or it isn't waiting, as when someone approved or rejected it
	 * first.
	 */
	async approve(id: string, approvedBy: string): Promise<SendStatus | null> {
		return this.#tryNow(id, "approve", approvedBy);
	}

	/** The messages waiting for approval, the oldest first, with how many there are. */
	awaiting(limit: number): { count: number; messages: Awaiting[] } {
		const sql = this.ctx.storage.sql;
		const count = sql
			.exec<{ n: number }>(
				`SELECT count(*) AS n FROM outgoing JOIN message ON message.id = outgoing.message
				WHERE outgoing.state = 'held' AND message.state = 'stored'`,
			)
			.one().n;
		const messages = sql
			.exec<Awaiting>(
				`SELECT message.id AS id, message.thread_id AS threadId, message.subject AS subject,
					message.sent_by AS sentBy, message.arrived_at AS arrivedAt
				FROM outgoing JOIN message ON message.id = outgoing.message
				WHERE outgoing.state = 'held' AND message.state = 'stored'
				ORDER BY message.arrived_at, message.id LIMIT ?`,
				limit,
			)
			.toArray();
		return { count, messages };
	}

	/**
	 * What became of the message sent from this draft, or null when none was. Asked before a send,
	 * so that sending a draft again doesn't count as another message, and again within it.
	 */
	drafted(draft: string): Sent | null {
		const earlier = this.ctx.storage.sql
			.exec<{ id: string; state: string; threadId: string | null }>(
				`SELECT message.id AS id, message.state AS state, message.thread_id AS threadId
				FROM outgoing JOIN message ON message.id = outgoing.message WHERE outgoing.draft = ?`,
				draft,
			)
			.toArray()[0];
		if (!earlier) return null;
		if (earlier.state !== "stored" || earlier.threadId === null) {
			return { ok: false, reason: "busy" };
		}
		return { ok: true, id: earlier.id, threadId: earlier.threadId, ...this.#status(earlier.id) };
	}

	/**
	 * Sends again a message that was refused, or that may or may not have gone. Null when there is
	 * no such message here, or it isn't one of those.
	 */
	async sendAgain(id: string): Promise<SendStatus | null> {
		return this.#tryNow(id, "again");
	}

	/**
	 * Deletes a message that isn't sent, whether held for approval, refused, uncertain or waiting to
	 * be tried again, or discarded already when deleting its copy failed. With `onlyHeld`, only one
	 * held for approval, for someone who may reject it but not discard others' mail. False when there is no such message here, or
	 * it is sent or being sent.
	 */
	async discard(id: string, onlyHeld = false): Promise<boolean> {
		const row = this.ctx.storage.sql
			.exec<{ state: string }>("SELECT state FROM outgoing WHERE message = ?", id)
			.toArray()[0];
		if (!row || !DISCARDABLE.has(row.state)) return false;
		// Checked here, with nothing awaited before it's marked: one approved meanwhile isn't held.
		if (onlyHeld && row.state !== "held") return false;
		return this.remove(id);
	}

	/**
	 * Asks Email Service, or Resend, to send a stored message now, and records how that went. The try
	 * is recorded before either is asked, so that should this object stop while it waits, the alarm
	 * finds the message uncertain rather than trying it again, or for Resend, which knows it by its
	 * key, tries it again. A person's try starts the count of tries over.
	 *
	 * Only from the state the caller found it in, checked as it changes: the first try of a new
	 * message, the alarm's of one that waits, or a person's of one refused or uncertain. A message
	 * discarded, deleted or tried by someone else meanwhile isn't sent, and the answer is null.
	 *
	 * A person who sends again one that stopped because the Resend key changed takes the new key.
	 */
	async #tryNow(
		id: string,
		from: "first" | "due" | "again" | "approve",
		approvedBy: string | null = null,
	): Promise<SendStatus | null> {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const found = {
			first: "state = 'sending' AND attempts = 0",
			due: "state = 'waiting'",
			again: "state IN ('refused', 'uncertain')",
			approve: "state = 'held'",
		}[from];
		const row = sql
			.exec<Trying>(
				`UPDATE outgoing SET state = 'sending', attempted_at = ?, next_at = NULL,
					attempts = CASE WHEN ? THEN 1 ELSE attempts + 1 END,
					approved_by = coalesce(?, approved_by), approved_at = coalesce(?, approved_at),
					key_version = CASE WHEN ? AND code = ? THEN NULL ELSE key_version END
				WHERE message = ? AND ${found}
				RETURNING request, attempts, provider, workspace_id AS workspaceId,
					idempotency_key AS idempotencyKey, maybe_sent AS maybeSent, key_version AS keyVersion`,
				now,
				from === "again" || from === "approve" ? 1 : 0,
				approvedBy,
				approvedBy === null ? null : now,
				from === "again" ? 1 : 0,
				KEY_CHANGED,
				id,
			)
			.toArray()[0];
		if (!row) return null;
		await this.#alarmBy(now + STALE_SENDING_MS);
		const result = await this.#deliver(id, row);
		if (result.ok) {
			sql.exec(
				`UPDATE outgoing SET state = 'sent', code = NULL, detail = NULL, provider_id = ?, sent_at = ?
				WHERE message = ? AND state = 'sending'`,
				result.providerId,
				Date.now(),
				id,
			);
		} else {
			const { outcome } = result;
			sql.exec(
				`UPDATE outgoing SET state = ?, code = ?, next_at = ?, detail = ?,
					maybe_sent = max(maybe_sent, ?),
					idempotency_key = CASE WHEN ? AND maybe_sent = 0 THEN ? ELSE idempotency_key END
				WHERE message = ? AND state = 'sending'`,
				outcome.state,
				outcome.code,
				outcome.state === "waiting" ? outcome.nextAt : null,
				result.detail,
				result.maybeSent ? 1 : 0,
				// Resend turned that request down, and would only give the same answer to its key again,
				// so the next try, after a fix, needs a new one. Unless an earlier try under it may have
				// sent the message: only that key keeps a try from sending it twice.
				result.answered ? 1 : 0,
				crypto.randomUUID(),
				id,
			);
			if (outcome.state === "waiting") await this.#alarmBy(outcome.nextAt);
		}
		return this.#status(id);
	}

	/** Hands a message to Email Service or Resend once, and says how that went. Never throws. */
	async #deliver(id: string, row: Trying): Promise<Delivered> {
		const request = JSON.parse(row.request) as EmailMessageBuilder;
		if (row.provider !== "resend") {
			try {
				const result = await this.env.EMAIL.send(request);
				return { ok: true, providerId: result.messageId };
			} catch (error) {
				const outcome = outcomeOf(error, row.attempts, Date.now());
				return { ok: false, outcome, detail: null, answered: false, maybeSent: false };
			}
		}
		const earlier = row.maybeSent === 1;
		const failed = (failure: ResendFailure): Delivered => ({
			ok: false,
			outcome: resendOutcome(failure, row.attempts, Date.now(), earlier),
			detail: failure.detail,
			answered: failure.answered,
			maybeSent: failure.kind === "unsure",
		});
		const stopped = (code: string): Delivered => ({
			ok: false,
			outcome: { state: earlier ? "uncertain" : "refused", code: `${RESEND_CODE}${code}` },
			detail: null,
			answered: false,
			maybeSent: false,
		});
		let opened: Awaited<ReturnType<typeof openProviderKey>>;
		try {
			// Read at each try, so a key replaced or removed meanwhile is the one that counts.
			opened = await openProviderKey(
				createDb(this.env.DB),
				this.env.SECRETS_KEY,
				row.workspaceId ?? "",
				"resend",
			);
		} catch {
			// D1 didn't answer, and nothing was asked of Resend.
			return failed({
				kind: "busy",
				code: `${RESEND_CODE}key_unavailable`,
				detail: null,
				answered: false,
			});
		}
		// Nothing goes this time, but an earlier try may have, so its key stays.
		if (!opened.ok) return stopped(opened.code);
		// Resend knows an idempotency key only in the account that sent it, so after a try that may
		// have gone, one through another key could send it twice.
		if (earlier && row.keyVersion !== null && row.keyVersion !== opened.version) {
			return stopped("key_changed");
		}
		// Kept before Resend is asked, as the try may never say how it went.
		this.ctx.storage.sql.exec(
			"UPDATE outgoing SET key_version = ? WHERE message = ? AND state = 'sending'",
			opened.version,
			id,
		);
		const answer = await sendWithResend({
			api: this.env.RESEND_API_URL || RESEND_API,
			key: opened.key,
			request,
			idempotencyKey: row.idempotencyKey ?? id,
		});
		return answer.ok ? { ok: true, providerId: answer.id } : failed(answer.failure);
	}

	/**
	 * Records providers' delivery events for messages this mailbox sent, all or none. Says for each
	 * whether its message is here.
	 */
	recordDeliveries(events: DeliveryEvent[]): boolean[] {
		const sql = this.ctx.storage.sql;
		return this.ctx.storage.transactionSync(() =>
			events.map((event) => recordDelivery(sql, event)),
		);
	}

	/**
	 * What became of a message the mailbox sends. When it is gone, deleted while it was sent, nobody
	 * knows whether it went.
	 */
	#status(id: string): SendStatus {
		return (
			this.ctx.storage.sql
				.exec<SendStatus>(
					"SELECT state, code, next_at AS nextAt, detail FROM outgoing WHERE message = ?",
					id,
				)
				.toArray()[0] ?? { state: "uncertain", code: null, nextAt: null, detail: null }
		);
	}

	/** Has the alarm run by then, unless it runs sooner anyway. */
	async #alarmBy(at: number): Promise<void> {
		const set = await this.ctx.storage.getAlarm();
		if (set === null || set > at) await this.ctx.storage.setAlarm(at);
	}

	/** Brings a thread's row up to date with its messages, and removes it when it has none. */
	#refreshThread(threadId: string): void {
		const sql = this.ctx.storage.sql;
		const now = sql
			.exec<{ count: number; firstAt: number | null; latestAt: number | null }>(
				`SELECT count(*) AS count, min(arrived_at) AS firstAt, max(arrived_at) AS latestAt
				FROM message WHERE thread_id = ? AND state = 'stored'`,
				threadId,
			)
			.one();
		if (now.count === 0 || now.firstAt === null || now.latestAt === null) {
			sql.exec("DELETE FROM thread WHERE id = ?", threadId);
			return;
		}
		sql.exec(
			"UPDATE thread SET count = ?, first_at = ?, latest_at = ? WHERE id = ?",
			now.count,
			now.firstAt,
			now.latestAt,
			threadId,
		);
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

	/** Threads, the one with the newest message first, after `before` when given. */
	threads(before: ThreadCursor | null, limit: number): ThreadSummary[] {
		const take = Math.min(Math.max(1, limit), MAX_LISTED);
		const sql = this.ctx.storage.sql;
		const rows = (
			before
				? sql.exec<ThreadRow>(
						`SELECT id, latest_at AS latestAt, count FROM thread WHERE (latest_at, id) < (?, ?)
						ORDER BY latest_at DESC, id DESC LIMIT ?`,
						before.latestAt,
						before.id,
						take,
					)
				: sql.exec<ThreadRow>(
						`SELECT id, latest_at AS latestAt, count FROM thread
						ORDER BY latest_at DESC, id DESC LIMIT ?`,
						take,
					)
		).toArray();
		return rows.map((thread) => this.#summary(thread));
	}

	/**
	 * Threads with a message that has every word someone typed, the one with the newest message
	 * first, after `before` when given. Nothing when what they typed has nothing to look for.
	 */
	search(typed: string, before: ThreadCursor | null, limit: number): ThreadSummary[] {
		const query = ftsQuery(typed);
		if (query === null) return [];
		const take = Math.min(Math.max(1, limit), MAX_LISTED);
		const sql = this.ctx.storage.sql;
		const matching = `id IN (
			SELECT message.thread_id FROM message_search
			JOIN message ON message.search_id = message_search.rowid
			WHERE message_search MATCH ? AND message.state = 'stored'
		)`;
		const rows = (
			before
				? sql.exec<ThreadRow>(
						`SELECT id, latest_at AS latestAt, count FROM thread
						WHERE ${matching} AND (latest_at, id) < (?, ?)
						ORDER BY latest_at DESC, id DESC LIMIT ?`,
						query,
						before.latestAt,
						before.id,
						take,
					)
				: sql.exec<ThreadRow>(
						`SELECT id, latest_at AS latestAt, count FROM thread WHERE ${matching}
						ORDER BY latest_at DESC, id DESC LIMIT ?`,
						query,
						take,
					)
		).toArray();
		return rows.map((thread) => this.#summary(thread));
	}

	/** A thread as a listing shows it. */
	#summary(thread: ThreadRow): ThreadSummary {
		const latest = this.#newest(thread.id);
		// From its first messages only, so that a long thread costs no more than a short one.
		const senders = this.ctx.storage.sql
			.exec<{ from: string | null }>(
				`SELECT "from" FROM (
					SELECT from_header AS "from", arrived_at FROM message
					WHERE thread_id = ? AND state = 'stored' ORDER BY arrived_at, id LIMIT ?
				)
				GROUP BY "from" ORDER BY min(arrived_at) LIMIT ?`,
				thread.id,
				SENDERS_READ,
				MAX_SENDERS,
			)
			.toArray()
			.map((row) => row.from);
		return {
			...thread,
			subject: latest?.subject ?? null,
			senders,
			latestVerifiedDomain: latest?.verifiedDomain ?? null,
		};
	}

	/** A thread's newest message, which its line in a listing speaks for. */
	#newest(threadId: string) {
		return this.ctx.storage.sql
			.exec<{ subject: string | null; verifiedDomain: string | null }>(
				`SELECT subject, verified_domain AS verifiedDomain FROM message
				WHERE thread_id = ? AND state = 'stored' ORDER BY arrived_at DESC, id DESC LIMIT 1`,
				threadId,
			)
			.toArray()[0];
	}

	/**
	 * A thread's messages, newest first, after `before` when given, with how many it has and its
	 * newest message's subject. Null when there is no such thread here. The defaults are for a
	 * Worker from before a thread had pages, which can still be running while a deploy reaches
	 * every place.
	 */
	thread(
		threadId: string,
		before: Cursor | null = null,
		limit = MAX_LISTED,
	): ThreadMessages | null {
		const sql = this.ctx.storage.sql;
		const row = sql
			.exec<{ count: number }>("SELECT count FROM thread WHERE id = ?", threadId)
			.toArray()[0];
		if (!row) return null;
		const take = Math.min(Math.max(1, limit), MAX_LISTED);
		const messages = (
			before
				? sql.exec<StoredSummary>(
						`SELECT ${SUMMARY} FROM message
						WHERE thread_id = ? AND state = 'stored' AND (arrived_at, id) < (?, ?)
						ORDER BY arrived_at DESC, id DESC LIMIT ?`,
						threadId,
						before.arrivedAt,
						before.id,
						take,
					)
				: sql.exec<StoredSummary>(
						`SELECT ${SUMMARY} FROM message WHERE thread_id = ? AND state = 'stored'
						ORDER BY arrived_at DESC, id DESC LIMIT ?`,
						threadId,
						take,
					)
		).toArray();
		return { count: row.count, subject: this.#newest(threadId)?.subject ?? null, messages };
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
		// One that isn't sent is discarded before anything is awaited, a state no try starts from:
		// the alarm, a person's Send again or an approval could otherwise send it while its copy goes.
		sql.exec(
			`UPDATE outgoing SET state = 'discarded', next_at = NULL
			WHERE message = ? AND state IN ('held', 'waiting', 'refused', 'uncertain')`,
			id,
		);
		await this.env.RAW_MAIL.delete(row.object);
		this.ctx.storage.transactionSync(() => {
			// Read again: another message may have merged its thread while R2 was deleting.
			const now = sql
				.exec<{ threadId: string }>("SELECT thread_id AS threadId FROM message WHERE id = ?", id)
				.toArray()[0];
			sql.exec("DELETE FROM message WHERE id = ?", id);
			if (now) this.#refreshThread(now.threadId);
		});
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

	/** Has the alarm run soon to index what waits, unless it runs sooner anyway. */
	async #indexSoon(): Promise<void> {
		const at = Date.now() + INDEX_DELAY_MS;
		const set = await this.ctx.storage.getAlarm();
		if (set === null || set > at) await this.ctx.storage.setAlarm(at);
	}

	/**
	 * Removes deliveries that never said they arrived, with whatever part of them reached R2, and
	 * indexes stored messages for search.
	 */
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
		const stale = Date.now() - STALE_SENDING_MS;
		// A stored message whose first try never began, as when this object stopped just before it,
		// sent nothing, so it waits to be tried.
		sql.exec(
			`UPDATE outgoing SET state = 'waiting', next_at = ?
			WHERE state = 'sending' AND attempts = 0 AND attempted_at <= ?
				AND message IN (SELECT id FROM message WHERE state = 'stored')`,
			Date.now(),
			stale,
		);
		// Resend knows a message by its key for a day, so one of its tries that never said how it went
		// is tried again, as a failure that may have sent it would be, while there are tries left.
		sql.exec(
			`UPDATE outgoing SET state = 'waiting', next_at = ?, code = ?, maybe_sent = 1
			WHERE state = 'sending' AND provider = 'resend' AND attempts > 0 AND attempts <= ?
				AND attempted_at <= ?`,
			Date.now(),
			`${RESEND_CODE}unreachable`,
			WAITS_MS.busy.length,
			stale,
		);
		// A try that never said how it went may have sent the message, so it isn't tried again.
		sql.exec(
			`UPDATE outgoing SET state = 'uncertain', maybe_sent = 1,
				code = CASE WHEN provider = 'resend' THEN ? END
			WHERE state = 'sending' AND attempts > 0 AND attempted_at <= ?`,
			`${RESEND_CODE}unreachable`,
			stale,
		);
		const due = sql
			.exec<{ id: string }>(
				`SELECT message AS id FROM outgoing WHERE state = 'waiting' AND next_at <= ?
				ORDER BY next_at LIMIT 20`,
				Date.now(),
			)
			.toArray();
		// Each is tried only if it still waits when its turn comes.
		for (const { id } of due) await this.#tryNow(id, "due");
		const indexed = await indexBatch(this.ctx.storage, (message) =>
			searchable(this.env.RAW_MAIL, message),
		);
		const next = sql
			.exec<{ at: number | null }>(
				"SELECT min(arrived_at) AS at FROM message WHERE state = 'pending'",
			)
			.one();
		const sends = sql
			.exec<{ waiting: number | null; sending: number | null }>(
				`SELECT (SELECT min(next_at) FROM outgoing WHERE state = 'waiting') AS waiting,
					(SELECT min(attempted_at) FROM outgoing WHERE state = 'sending') AS sending`,
			)
			.one();
		// A delivery may have set the alarm while this ran, and the soonest wins.
		const times = [
			next.at === null ? null : next.at + PENDING_MS,
			sends.waiting,
			sends.sending === null ? null : sends.sending + STALE_SENDING_MS,
			indexed === "more" ? Date.now() : indexed === "failed" ? Date.now() + INDEX_RETRY_MS : null,
			await this.ctx.storage.getAlarm(),
		].filter((at): at is number => at !== null);
		if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
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
