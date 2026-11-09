import { DurableObject } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import {
	MAX_WEBHOOKS,
	WEBHOOK_TEST_EVENT,
	type Webhook,
	type WebhookDelivery,
	type WebhookEventType,
	type WebhookPayload,
	type webhookInput,
	type webhookPatch,
} from "../../lib/webhooks";
import { UNTRUSTED } from "../agent-api/untrusted";
import { createDb, schema } from "../db";
import { decoded, sender } from "../mailbox/people";
import { migrate } from "./schema";
import {
	attempt,
	DELIVERY_RETENTION_MS,
	DELIVERY_TIMEOUT_MS,
	newSecret,
	type Outcome,
	RETRY_DELAYS_MS,
	secretStart,
	urlRefusal,
} from "./signing";

/** What a mailbox hands over of mail it stored. Header values are as sent, not decoded. */
export interface MailEvent {
	/** The event's own id: the same each time the mailbox hands it over, so it is queued once. */
	id: string;
	type: "message.received";
	message: {
		id: string;
		threadId: string;
		arrivedAt: number;
		from: string | null;
		subject: string | null;
		date: string | null;
		envelopeTo: string;
		size: number;
		dmarc: string | null;
		verifiedDomain: string | null;
	};
}

/** What the gateway knows of the workspace a change is for, and where people reach the app. */
export interface WebhookLink {
	workspaceId: string;
	slug: string;
	origin: string;
}

export type Refused = { ok: false; status: 400 | 404 | 409; error: string };

type Fields = z.output<typeof webhookInput>;
type Patch = z.output<typeof webhookPatch>;

/** How many of each webhook's deliveries the settings page shows. */
const RECENT_DELIVERIES = 10;
/** How many deliveries one round of the alarm sends, and how many at once. */
const BATCH_SIZE = 50;
const CONCURRENCY = 10;
/** How long a claimed delivery is left alone while it is sent, should this object stop meanwhile. */
const CLAIM_MS = DELIVERY_TIMEOUT_MS + 60_000;
/** How soon the alarm runs again when D1 didn't answer it. */
const D1_RETRY_MS = 60_000;

// Types, not interfaces, so that SQLite's rows can be read as them.
type WebhookRow = {
	id: string;
	url: string;
	events: string;
	mailboxIds: string | null;
	active: number;
	secret: string;
	createdAt: number;
	updatedAt: number;
};

type DeliveryRow = {
	id: string;
	webhookId: string;
	event: string;
	status: string;
	attempts: number;
	responseStatus: number | null;
	error: string | null;
	nextAttemptAt: number | null;
	createdAt: number;
	updatedAt: number;
};

type Claim = { id: string; attempts: number };

const WEBHOOK_COLUMNS = `id, url, events, mailbox_ids AS mailboxIds, active, secret,
	created_at AS createdAt, updated_at AS updatedAt`;
const DELIVERY_COLUMNS = `id, webhook_id AS webhookId, event, status, attempts,
	response_status AS responseStatus, error, next_attempt_at AS nextAttemptAt,
	created_at AS createdAt, updated_at AS updatedAt`;

const refused = (status: Refused["status"], error: string): Refused => ({
	ok: false,
	status,
	error,
});

/**
 * A workspace's webhooks, with their secrets, and the deliveries on their way to them. Mailboxes
 * hand it what they stored, from an outbox of their own; it queues one delivery for each webhook
 * that listens, and sends them from its alarm, retrying for about a day. Only the Worker reaches
 * it: the gateway, after checking that an owner or admin asks, and the workspace's mailboxes.
 */
export class Webhooks extends DurableObject<Cloudflare.Env> {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		migrate(ctx.storage);
	}

	/** The webhooks, oldest first, with each one's latest deliveries. */
	list(): { webhooks: Webhook[]; deliveries: WebhookDelivery[] } {
		const sql = this.ctx.storage.sql;
		const rows = sql
			.exec<WebhookRow>(`SELECT ${WEBHOOK_COLUMNS} FROM webhook ORDER BY created_at, id`)
			.toArray();
		const deliveries = rows.flatMap((row) =>
			sql
				.exec<DeliveryRow>(
					`SELECT ${DELIVERY_COLUMNS} FROM delivery WHERE webhook_id = ?
					ORDER BY created_at DESC, id LIMIT ?`,
					row.id,
					RECENT_DELIVERIES,
				)
				.toArray()
				.map(toDelivery),
		);
		return { webhooks: rows.map(toWebhook), deliveries };
	}

	/** Adds a webhook, with a new secret that only this answer gives. */
	create(
		link: WebhookLink,
		fields: Fields,
	): { ok: true; webhook: Webhook; secret: string } | Refused {
		const refusal = urlRefusal(fields.url, link.origin);
		if (refusal) return refused(400, refusal);
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const id = crypto.randomUUID();
		const secret = newSecret();
		return this.ctx.storage.transactionSync(() => {
			const { n } = sql.exec<{ n: number }>("SELECT count(*) AS n FROM webhook").one();
			if (n >= MAX_WEBHOOKS) {
				return refused(409, `A workspace can have at most ${MAX_WEBHOOKS} webhooks.`);
			}
			this.#remember(link);
			sql.exec(
				`INSERT INTO webhook (id, url, events, mailbox_ids, active, secret, created_at, updated_at)
				VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
				id,
				fields.url,
				JSON.stringify(fields.events),
				fields.mailboxIds === null ? null : JSON.stringify(fields.mailboxIds),
				secret,
				now,
				now,
			);
			const row = this.#row(id);
			if (!row) throw new Error("The webhook just added isn't there");
			return { ok: true as const, webhook: toWebhook(row), secret };
		});
	}

	/**
	 * Changes a webhook. Of what it had yet to deliver, it drops what it no longer wants: everything
	 * once it is paused, and what tells of a mailbox or an event it no longer hears. A new URL takes
	 * the rest.
	 */
	update(link: WebhookLink, id: string, patch: Patch): { ok: true; webhook: Webhook } | Refused {
		if (patch.url !== undefined) {
			const refusal = urlRefusal(patch.url, link.origin);
			if (refusal) return refused(400, refusal);
		}
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		return this.ctx.storage.transactionSync(() => {
			const row = this.#row(id);
			if (!row) return refused(404, "No such webhook.");
			this.#remember(link);
			const mailboxIds =
				patch.mailboxIds === undefined
					? row.mailboxIds
					: patch.mailboxIds === null
						? null
						: JSON.stringify(patch.mailboxIds);
			sql.exec(
				`UPDATE webhook SET url = ?, events = ?, mailbox_ids = ?, active = ?, updated_at = ?
				WHERE id = ?`,
				patch.url ?? row.url,
				patch.events ? JSON.stringify(patch.events) : row.events,
				mailboxIds,
				patch.active === undefined ? row.active : patch.active ? 1 : 0,
				now,
				id,
			);
			this.#dropUnwanted(id, now);
			const changed = this.#row(id);
			if (!changed) throw new Error("The webhook just changed isn't there");
			return { ok: true as const, webhook: toWebhook(changed) };
		});
	}

	/** Deletes a webhook and what it had not delivered. */
	remove(id: string): { ok: true } | Refused {
		const sql = this.ctx.storage.sql;
		return this.ctx.storage.transactionSync(() => {
			if (!this.#row(id)) return refused(404, "No such webhook.");
			sql.exec("DELETE FROM delivery WHERE webhook_id = ?", id);
			sql.exec("DELETE FROM webhook WHERE id = ?", id);
			return { ok: true as const };
		});
	}

	/** Replaces a webhook's secret. Deliveries fail until the receiver has the new one. */
	rotate(id: string): { ok: true; secret: string } | Refused {
		const sql = this.ctx.storage.sql;
		const secret = newSecret();
		return this.ctx.storage.transactionSync(() => {
			if (!this.#row(id)) return refused(404, "No such webhook.");
			sql.exec(
				"UPDATE webhook SET secret = ?, updated_at = ? WHERE id = ?",
				secret,
				Date.now(),
				id,
			);
			return { ok: true as const, secret };
		});
	}

	/** Queues a `webhook.test` delivery, whatever the webhook listens to, one at a time. */
	async test(link: WebhookLink, id: string): Promise<{ ok: true } | Refused> {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const queued = this.ctx.storage.transactionSync(() => {
			const row = this.#row(id);
			if (!row) return refused(404, "No such webhook.");
			if (row.active !== 1) return refused(409, "Resume the webhook first.");
			const waiting = sql
				.exec(
					"SELECT 1 FROM delivery WHERE webhook_id = ? AND event = ? AND status = 'pending' LIMIT 1",
					id,
					WEBHOOK_TEST_EVENT,
				)
				.toArray();
			if (waiting.length > 0) return refused(409, "A test is already on its way.");
			this.#remember(link);
			const payload: WebhookPayload = {
				type: WEBHOOK_TEST_EVENT,
				timestamp: new Date(now).toISOString(),
				data: { workspace: { id: link.workspaceId, slug: link.slug }, webhookId: id },
			};
			this.#queue(id, WEBHOOK_TEST_EVENT, null, JSON.stringify(payload), now);
			return { ok: true as const };
		});
		if (queued.ok) await this.#alarmBy(now);
		return queued;
	}

	/**
	 * Takes what a mailbox of the workspace stored, and queues a delivery of each event for every
	 * webhook that listens to it there. An event handed over again is queued once. Throws when it
	 * can't tell, which has the mailbox hand the events over again later.
	 */
	async accept(workspaceId: string, mailboxId: string, events: MailEvent[]): Promise<void> {
		if (this.#listening(mailboxId).length === 0) return;
		const origin = this.#meta("origin");
		if (!origin) return;
		// Named as they are now, and only while they are there: a deleted workspace sends nothing.
		const db = createDb(this.env.DB);
		const [workspace, mailbox] = await Promise.all([
			db
				.select({ slug: schema.organization.slug })
				.from(schema.organization)
				.where(eq(schema.organization.id, workspaceId))
				.get(),
			db
				.select({ name: schema.mailbox.name })
				.from(schema.mailbox)
				.where(
					and(eq(schema.mailbox.id, mailboxId), eq(schema.mailbox.organizationId, workspaceId)),
				)
				.get(),
		]);
		if (!workspace) {
			await this.destroy();
			return;
		}
		if (!mailbox) return;
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const queued = this.ctx.storage.transactionSync(() => {
			let any = false;
			for (const event of events) {
				if (sql.exec("SELECT 1 FROM seen_event WHERE id = ?", event.id).toArray().length > 0) {
					continue;
				}
				// As the webhooks are now: one may have changed while the names were looked up.
				const hooks = this.#listening(mailboxId).filter((hook) => hook.events.includes(event.type));
				if (hooks.length === 0) continue;
				sql.exec("INSERT INTO seen_event (id, at) VALUES (?, ?)", event.id, now);
				const body = JSON.stringify(
					received(
						event,
						{ id: workspaceId, slug: workspace.slug },
						mailboxId,
						mailbox.name,
						origin,
					),
				);
				for (const hook of hooks) this.#queue(hook.id, event.type, mailboxId, body, now);
				any = true;
			}
			return any;
		});
		if (queued) {
			await this.#alarmBy(now);
			return;
		}
		// All handed over before, perhaps by a call that ended before it set the alarm: what waits is
		// sent all the same.
		const due = this.#soonestDue();
		if (due !== null) await this.#alarmBy(due);
	}

	/** Removes every webhook and delivery, as when the workspace is deleted. */
	async destroy(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		// Empty again, for anything still on its way to this object.
		migrate(this.ctx.storage);
	}

	/** Sends what is due, drops what is past its time, and sets the alarm for what comes next. */
	override async alarm(): Promise<void> {
		const workspaceId = this.#meta("workspace");
		if (workspaceId) {
			let there: { id: string } | undefined;
			try {
				there = await createDb(this.env.DB)
					.select({ id: schema.organization.id })
					.from(schema.organization)
					.where(eq(schema.organization.id, workspaceId))
					.get();
			} catch (error) {
				// Cloudflare stops retrying an alarm that keeps throwing after a few minutes, and nothing
				// else may set it again, so this one sets its next round itself.
				console.error("webhooks: D1 didn't answer; trying again in a minute", {
					name: error instanceof Error ? error.name : "unknown",
				});
				await this.#alarmBy(Date.now() + D1_RETRY_MS);
				return;
			}
			if (!there) {
				await this.destroy();
				return;
			}
		}
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		sql.exec(
			"DELETE FROM delivery WHERE status != 'pending' AND updated_at < ?",
			now - DELIVERY_RETENTION_MS,
		);
		sql.exec("DELETE FROM seen_event WHERE at < ?", now - DELIVERY_RETENTION_MS);
		const more = await this.#deliverDue();
		const next = sql
			.exec<{ due: number | null; finished: number | null; seen: number | null }>(
				`SELECT (SELECT min(next_attempt_at) FROM delivery WHERE status = 'pending') AS due,
					(SELECT min(updated_at) FROM delivery WHERE status != 'pending') AS finished,
					(SELECT min(at) FROM seen_event) AS seen`,
			)
			.one();
		// A change may have set the alarm while this ran, and the soonest wins.
		const times = [
			more ? Date.now() : null,
			next.due,
			next.finished === null ? null : next.finished + DELIVERY_RETENTION_MS,
			next.seen === null ? null : next.seen + DELIVERY_RETENTION_MS,
			await this.ctx.storage.getAlarm(),
		].filter((at): at is number => at !== null);
		if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
	}

	/** Sends the deliveries that are due. Says whether more were due than one round sends. */
	async #deliverDue(): Promise<boolean> {
		const sql = this.ctx.storage.sql;
		const claims = this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			const due = sql
				.exec<Claim>(
					`SELECT id, attempts + 1 AS attempts FROM delivery
					WHERE status = 'pending' AND next_attempt_at <= ?
					ORDER BY next_attempt_at LIMIT ?`,
					now,
					BATCH_SIZE,
				)
				.toArray();
			// Out of the way while they are sent; should this object stop, they are tried again.
			for (const claim of due) {
				sql.exec(
					"UPDATE delivery SET next_attempt_at = ?, updated_at = ? WHERE id = ?",
					now + CLAIM_MS,
					now,
					claim.id,
				);
			}
			return due;
		});
		let next = 0;
		const worker = async () => {
			while (next < claims.length) {
				const claim = claims[next++];
				if (!claim) break;
				// It may have waited behind slow receivers, and its webhook may have been paused, changed
				// or deleted, or its secret replaced, since.
				const sending = this.#stillToSend(claim.id);
				if (!sending) continue;
				if ("unwanted" in sending) {
					// It goes no further, rather than being claimed again.
					this.#failOne(claim.id, sending.unwanted, Date.now());
					continue;
				}
				const outcome = await attempt({ id: claim.id, ...sending });
				this.ctx.storage.transactionSync(() => this.#record(claim, outcome, Date.now()));
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claims.length) }, worker));
		return claims.length === BATCH_SIZE;
	}

	/**
	 * The body, secret and URL a claimed delivery goes out with now; why its webhook, as it is now,
	 * no longer wants it; or null when it is no longer waiting at all.
	 */
	#stillToSend(
		id: string,
	): { payload: string; secret: string; url: string } | { unwanted: string } | null {
		const delivery = this.ctx.storage.sql
			.exec<{ payload: string; event: string; mailboxId: string | null; webhookId: string }>(
				`SELECT payload, event, mailbox_id AS mailboxId, webhook_id AS webhookId FROM delivery
				WHERE id = ? AND status = 'pending'`,
				id,
			)
			.toArray()[0];
		if (!delivery) return null;
		const webhook = this.#row(delivery.webhookId);
		if (!webhook) return { unwanted: "The webhook was deleted." };
		const reason = unwanted(webhook, delivery);
		if (reason) return { unwanted: reason };
		return { payload: delivery.payload, secret: webhook.secret, url: webhook.url };
	}

	#record(claim: Claim, outcome: Outcome, now: number): void {
		const delay = RETRY_DELAYS_MS[claim.attempts - 1];
		const status = outcome.ok ? "delivered" : delay === undefined ? "failed" : "pending";
		// Paused or deleted while it was being sent: left as that made it.
		this.ctx.storage.sql.exec(
			`UPDATE delivery SET status = ?, attempts = ?, response_status = ?, error = ?,
				next_attempt_at = ?, updated_at = ?
			WHERE id = ? AND status = 'pending'`,
			status,
			claim.attempts,
			outcome.responseStatus,
			outcome.error,
			status === "pending" && delay !== undefined ? now + delay : null,
			now,
			claim.id,
		);
	}

	/** The active webhooks that hear of this mailbox's mail, with what they listen to. */
	#listening(mailboxId: string): { id: string; events: WebhookEventType[] }[] {
		return this.ctx.storage.sql
			.exec<{ id: string; events: string; mailboxIds: string | null }>(
				"SELECT id, events, mailbox_ids AS mailboxIds FROM webhook WHERE active = 1",
			)
			.toArray()
			.filter(
				(row) =>
					row.mailboxIds === null || (JSON.parse(row.mailboxIds) as string[]).includes(mailboxId),
			)
			.map((row) => ({ id: row.id, events: JSON.parse(row.events) as WebhookEventType[] }));
	}

	#queue(
		webhookId: string,
		event: string,
		mailboxId: string | null,
		payload: string,
		now: number,
	): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO delivery (id, webhook_id, event, mailbox_id, payload, status, attempts,
				next_attempt_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
			crypto.randomUUID(),
			webhookId,
			event,
			mailboxId,
			payload,
			now,
			now,
			now,
		);
	}

	/** Fails what a webhook had yet to deliver and, as it is now, no longer wants. */
	#dropUnwanted(webhookId: string, now: number): void {
		const webhook = this.#row(webhookId);
		if (!webhook) return;
		const waiting = this.ctx.storage.sql
			.exec<{ id: string; event: string; mailboxId: string | null }>(
				`SELECT id, event, mailbox_id AS mailboxId FROM delivery
				WHERE webhook_id = ? AND status = 'pending'`,
				webhookId,
			)
			.toArray();
		for (const delivery of waiting) {
			const reason = unwanted(webhook, delivery);
			if (reason) this.#failOne(delivery.id, reason, now);
		}
	}

	#failOne(id: string, error: string, now: number): void {
		this.ctx.storage.sql.exec(
			`UPDATE delivery SET status = 'failed', error = ?, next_attempt_at = NULL, updated_at = ?
			WHERE id = ? AND status = 'pending'`,
			error,
			now,
			id,
		);
	}

	#row(id: string): WebhookRow | null {
		return (
			this.ctx.storage.sql
				.exec<WebhookRow>(`SELECT ${WEBHOOK_COLUMNS} FROM webhook WHERE id = ?`, id)
				.toArray()[0] ?? null
		);
	}

	/** Keeps which workspace this is and where the app is, as the gateway last said. */
	#remember(link: WebhookLink): void {
		const sql = this.ctx.storage.sql;
		sql.exec(
			"INSERT OR REPLACE INTO meta (key, value) VALUES ('workspace', ?), ('origin', ?)",
			link.workspaceId,
			link.origin,
		);
	}

	#meta(key: "workspace" | "origin"): string | null {
		return (
			this.ctx.storage.sql
				.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
				.toArray()[0]?.value ?? null
		);
	}

	/** When the soonest delivery still waiting is due, or null when none waits. */
	#soonestDue(): number | null {
		return this.ctx.storage.sql
			.exec<{ due: number | null }>(
				"SELECT min(next_attempt_at) AS due FROM delivery WHERE status = 'pending'",
			)
			.one().due;
	}

	/** Has the alarm run by then, unless it runs sooner anyway. */
	async #alarmBy(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}
}

/** The body of a `message.received` delivery: what a listing shows of it, marked untrusted. */
function received(
	event: MailEvent,
	workspace: { id: string; slug: string },
	mailboxId: string,
	mailboxName: string,
	origin: string,
): WebhookPayload {
	const message = event.message;
	const arrivedAt = new Date(message.arrivedAt).toISOString();
	const path = [workspace.slug, "mailboxes", mailboxId, "threads", message.threadId]
		.map(encodeURIComponent)
		.join("/");
	return {
		type: "message.received",
		timestamp: arrivedAt,
		data: {
			workspace,
			mailbox: { id: mailboxId, name: mailboxName },
			message: {
				id: message.id,
				threadId: message.threadId,
				arrivedAt,
				from: sender(message.from),
				subject: decoded(message.subject),
				date: message.date,
				cameTo: message.envelopeTo
					.split(",")
					.map((address) => address.trim().toLowerCase())
					.filter(Boolean),
				verifiedDomain: message.verifiedDomain,
				dmarc: message.dmarc,
				size: message.size,
				url: new URL(`/${path}`, origin).href,
			},
			untrusted: UNTRUSTED,
		},
	};
}

/** Why a webhook, as it is now, no longer wants a delivery it had yet to send; null when it does. */
function unwanted(
	webhook: Pick<WebhookRow, "active" | "events" | "mailboxIds">,
	delivery: { event: string; mailboxId: string | null },
): string | null {
	if (webhook.active !== 1) return "The webhook was paused.";
	// A test goes whatever the webhook listens to.
	if (delivery.event === WEBHOOK_TEST_EVENT) return null;
	if (!(JSON.parse(webhook.events) as string[]).includes(delivery.event)) {
		return "The webhook no longer listens to that event.";
	}
	if (
		delivery.mailboxId !== null &&
		webhook.mailboxIds !== null &&
		!(JSON.parse(webhook.mailboxIds) as string[]).includes(delivery.mailboxId)
	) {
		return "The webhook no longer hears that mailbox.";
	}
	return null;
}

function toWebhook(row: WebhookRow): Webhook {
	return {
		id: row.id,
		url: row.url,
		events: JSON.parse(row.events) as WebhookEventType[],
		mailboxIds: row.mailboxIds === null ? null : (JSON.parse(row.mailboxIds) as string[]),
		active: row.active === 1,
		secretStart: secretStart(row.secret),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
	return {
		...row,
		event: row.event as WebhookDelivery["event"],
		status: row.status as WebhookDelivery["status"],
	};
}
