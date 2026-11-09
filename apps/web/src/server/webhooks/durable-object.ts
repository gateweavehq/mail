import { DurableObject } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { canReadMailbox } from "../../lib/roles";
import {
	MAX_AGENT_WEBHOOKS,
	MAX_WEBHOOKS,
	type SentEventType,
	WEBHOOK_TEST_EVENT,
	type Webhook,
	type WebhookActor,
	type WebhookDelivery,
	type WebhookEventType,
	type WebhookPayload,
	type webhookInput,
	type webhookPatch,
} from "../../lib/webhooks";
import { SENT_UNTRUSTED, UNTRUSTED } from "../agent-api/untrusted";
import { isAgentMembership, pausedAmong } from "../auth/agents";
import { createDb, schema } from "../db";
import type { SentFacts } from "../mailbox/events";
import { decoded, sender } from "../mailbox/people";
import { toRole } from "../workspaces";
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

/**
 * What a mailbox hands over of mail it stored, or of mail it sends. Header values are as written,
 * not decoded. Each has its own id: the same each time the mailbox hands it over, so it is queued
 * once.
 */
export type MailEvent = ReceivedEvent | SentEvent;

export interface ReceivedEvent {
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

export interface SentEvent {
	id: string;
	type: SentEventType;
	/** When it happened. */
	at: number;
	sent: SentFacts;
}

/** A member as the workspace has them now, for naming who wrote, approved or rejected mail. */
type Known = { name: string; agent: boolean };

/** D1 binds at most 100 values in a statement; a few are the workspace's. */
const IDS_AT_ONCE = 90;

/** What the gateway knows of the workspace a change is for, and where people reach the app. */
export interface WebhookLink {
	workspaceId: string;
	slug: string;
	origin: string;
}

export type Refused = { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Who asks: an owner or admin, for every webhook of the workspace, or an agent, for its own, with
 * the key it asks with.
 */
export type Asker = { admin: true } | { agent: string; key: string };

const agentOf = (asker: Asker): string | null => ("agent" in asker ? asker.agent : null);

/** What an admin may not do to a webhook an agent made for itself. */
const AGENTS_OWN =
	"Only the agent that made this webhook can change where it goes and what it hears. You can pause, test or delete it.";
const AGENTS_SECRET = "Only the agent that made this webhook can give it a new secret.";
const ADMINS_PAUSE = "An admin paused this webhook, so only an admin can resume it.";
/** Why an agent's own delivery goes no further. */
const KEY_GONE = "The key that made the webhook was revoked.";
const PAUSED = "The agent was paused.";
const UNREAD = "The agent may no longer read that mailbox.";
/** How long what D1 said of agents' keys and mailboxes counts, while a round of deliveries goes. */
const READERS_FRESH_MS = 10_000;

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
	agentMemberId: string | null;
	agentKeyId: string | null;
	pausedByAdmin: number;
	createdAt: number;
	updatedAt: number;
};

/** An active webhook, as `accept` reads it. */
type Listening = {
	id: string;
	events: WebhookEventType[];
	agent: string | null;
	key: string | null;
};

/**
 * Of some agents' keys, those that still work; of some agents and mailboxes, as `pair` names them,
 * where the agent may read the mailbox now; and of those agents, the ones paused.
 */
type Readers = { keys: Set<string>; reading: Set<string>; paused: Set<string> };

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

type Claim = {
	id: string;
	attempts: number;
	mailboxId: string | null;
	agent: string | null;
	key: string | null;
};

const WEBHOOK_COLUMNS = `id, url, events, mailbox_ids AS mailboxIds, active, secret,
	agent_member_id AS agentMemberId, agent_key_id AS agentKeyId, paused_by_admin AS pausedByAdmin,
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
 * it: the gateway, after checking that an owner or admin asks; the agent API, for an agent's own,
 * with the agent's key; and the workspace's mailboxes.
 */
export class Webhooks extends DurableObject<Cloudflare.Env> {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		migrate(ctx.storage);
	}

	/** The webhooks the asker may see, oldest first, with each one's latest deliveries. */
	list(asker: Asker): { webhooks: Webhook[]; deliveries: WebhookDelivery[] } {
		const sql = this.ctx.storage.sql;
		const agent = agentOf(asker);
		const rows = (
			agent === null
				? sql.exec<WebhookRow>(`SELECT ${WEBHOOK_COLUMNS} FROM webhook ORDER BY created_at, id`)
				: sql.exec<WebhookRow>(
						`SELECT ${WEBHOOK_COLUMNS} FROM webhook WHERE agent_member_id = ?
						ORDER BY created_at, id`,
						agent,
					)
		).toArray();
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

	/**
	 * Adds a webhook, with a new secret that only this answer gives: the workspace's own for an
	 * admin, the agent's own for an agent, which lasts as long as the key it was made with. Each kind
	 * counts against its own limit.
	 */
	create(
		link: WebhookLink,
		fields: Fields,
		asker: Asker,
	): { ok: true; webhook: Webhook; secret: string } | Refused {
		const refusal = this.#urlRefusal(fields.url, link, asker);
		if (refusal) return refused(400, refusal);
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const id = crypto.randomUUID();
		const secret = newSecret();
		const agent = agentOf(asker);
		const key = "key" in asker ? asker.key : null;
		return this.ctx.storage.transactionSync(() => {
			const { n } = sql
				.exec<{ n: number }>("SELECT count(*) AS n FROM webhook WHERE agent_member_id IS ?", agent)
				.one();
			if (agent === null && n >= MAX_WEBHOOKS) {
				return refused(409, `A workspace can have at most ${MAX_WEBHOOKS} webhooks.`);
			}
			if (agent !== null && n >= MAX_AGENT_WEBHOOKS) {
				return refused(409, `An agent can have at most ${MAX_AGENT_WEBHOOKS} webhooks of its own.`);
			}
			this.#remember(link, asker);
			sql.exec(
				`INSERT INTO webhook (id, url, events, mailbox_ids, active, secret, agent_member_id,
					agent_key_id, created_at, updated_at)
				VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
				id,
				fields.url,
				JSON.stringify(fields.events),
				fields.mailboxIds === null ? null : JSON.stringify(fields.mailboxIds),
				secret,
				agent,
				key,
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
	 * the rest. With `renew`, it gets a new secret too, which only this answer gives. An admin only
	 * pauses, resumes or tests one an agent made for itself, and the agent can't resume what an
	 * admin paused.
	 */
	update(
		link: WebhookLink,
		id: string,
		patch: Patch,
		asker: Asker,
		renew = false,
	): { ok: true; webhook: Webhook; secret: string | null } | Refused {
		if (patch.url !== undefined) {
			const refusal = this.#urlRefusal(patch.url, link, asker);
			if (refusal) return refused(400, refusal);
		}
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const secret = renew ? newSecret() : null;
		return this.ctx.storage.transactionSync(() => {
			const row = this.#row(id, asker);
			if (!row) return refused(404, "No such webhook.");
			const agents = row.agentMemberId !== null;
			const redirects =
				patch.url !== undefined || patch.events !== undefined || patch.mailboxIds !== undefined;
			if ("admin" in asker && agents && redirects) return refused(409, AGENTS_OWN);
			if ("admin" in asker && agents && renew) return refused(409, AGENTS_SECRET);
			if ("agent" in asker && row.pausedByAdmin === 1 && patch.active === true) {
				return refused(409, ADMINS_PAUSE);
			}
			this.#remember(link, asker);
			const mailboxIds =
				patch.mailboxIds === undefined
					? row.mailboxIds
					: patch.mailboxIds === null
						? null
						: JSON.stringify(patch.mailboxIds);
			// An admin's pause of an agent's own holds until an admin resumes it.
			const pausedByAdmin =
				"admin" in asker && agents && patch.active !== undefined
					? patch.active
						? 0
						: 1
					: row.pausedByAdmin;
			sql.exec(
				`UPDATE webhook SET url = ?, events = ?, mailbox_ids = ?, active = ?, secret = ?,
					paused_by_admin = ?, updated_at = ?
				WHERE id = ?`,
				patch.url ?? row.url,
				patch.events ? JSON.stringify(patch.events) : row.events,
				mailboxIds,
				patch.active === undefined ? row.active : patch.active ? 1 : 0,
				secret ?? row.secret,
				pausedByAdmin,
				now,
				id,
			);
			this.#dropUnwanted(id, now);
			const changed = this.#row(id);
			if (!changed) throw new Error("The webhook just changed isn't there");
			return { ok: true as const, webhook: toWebhook(changed), secret };
		});
	}

	/** Deletes a webhook and what it had not delivered. */
	remove(id: string, asker: Asker): { ok: true } | Refused {
		const sql = this.ctx.storage.sql;
		return this.ctx.storage.transactionSync(() => {
			if (!this.#row(id, asker)) return refused(404, "No such webhook.");
			sql.exec("DELETE FROM delivery WHERE webhook_id = ?", id);
			sql.exec("DELETE FROM webhook WHERE id = ?", id);
			return { ok: true as const };
		});
	}

	/** Replaces a webhook's secret. Deliveries fail until the receiver has the new one. */
	rotate(id: string, asker: Asker): { ok: true; webhook: Webhook; secret: string } | Refused {
		const sql = this.ctx.storage.sql;
		const secret = newSecret();
		return this.ctx.storage.transactionSync(() => {
			const row = this.#row(id, asker);
			if (!row) return refused(404, "No such webhook.");
			// The agent couldn't learn it, and would no longer know its deliveries for Mail's.
			if ("admin" in asker && row.agentMemberId !== null) return refused(409, AGENTS_SECRET);
			sql.exec(
				"UPDATE webhook SET secret = ?, updated_at = ? WHERE id = ?",
				secret,
				Date.now(),
				id,
			);
			const changed = this.#row(id);
			if (!changed) throw new Error("The webhook just changed isn't there");
			return { ok: true as const, webhook: toWebhook(changed), secret };
		});
	}

	/** Queues a `webhook.test` delivery, whatever the webhook listens to, one at a time. */
	async test(link: WebhookLink, id: string, asker: Asker): Promise<{ ok: true } | Refused> {
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const queued = this.ctx.storage.transactionSync(() => {
			const row = this.#row(id, asker);
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
			this.#remember(link, asker);
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

	/** Removes the webhooks an agent made for itself, and what they had not delivered. */
	removeAgent(memberId: string): void {
		this.ctx.storage.transactionSync(() => this.#forget("agent_member_id", memberId));
	}

	/** Removes the webhooks an agent made with this key, as when the key is revoked. */
	removeKey(keyId: string): void {
		this.ctx.storage.transactionSync(() => this.#forget("agent_key_id", keyId));
	}

	/**
	 * Removes the webhooks of agents' keys that no longer work, as the page does before it lists
	 * them, should removing them when the key went have failed.
	 */
	async prune(): Promise<void> {
		const keys = this.ctx.storage.sql
			.exec<{ key: string }>(
				"SELECT DISTINCT agent_key_id AS key FROM webhook WHERE agent_key_id IS NOT NULL",
			)
			.toArray()
			.map((row) => row.key);
		if (keys.length === 0) return;
		const working = await this.#workingKeys(keys);
		this.ctx.storage.transactionSync(() => {
			for (const key of keys) if (!working.has(key)) this.#forget("agent_key_id", key);
		});
	}

	/**
	 * Takes what a mailbox of the workspace stored, and queues a delivery of each event for every
	 * webhook that listens to it there: of an agent's own, only those whose key still works, of an
	 * agent that may read the mailbox now, and not of what it did itself. An event handed over again
	 * is queued once. Throws when it can't tell, which has the mailbox hand the events over again
	 * later.
	 */
	async accept(workspaceId: string, mailboxId: string, events: MailEvent[]): Promise<void> {
		const listening = this.#listening(mailboxId);
		if (listening.length === 0) return;
		const origin = this.#meta("origin");
		if (!origin) return;
		// Only the people of events some webhook will be told of are looked up.
		const named = events.filter(
			(event) =>
				event.type !== "message.received" &&
				listening.some((hook) => hook.events.includes(event.type)) &&
				this.ctx.storage.sql.exec("SELECT 1 FROM seen_event WHERE id = ?", event.id).toArray()
					.length === 0,
		);
		const agents = [...new Set(listening.flatMap((hook) => hook.agent ?? []))];
		const keys = [...new Set(listening.flatMap((hook) => hook.key ?? []))];
		// Named as they are now, and only while they are there: a deleted workspace sends nothing.
		const db = createDb(this.env.DB);
		const [workspace, mailbox, members, readers] = await Promise.all([
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
			this.#members(workspaceId, named),
			this.#readers(
				workspaceId,
				keys,
				agents.map((agent) => ({ agent, mailboxId })),
				agents,
			),
		]);
		if (!workspace) {
			await this.destroy();
			return;
		}
		if (!mailbox) return;
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const queued = this.ctx.storage.transactionSync(() => {
			// A key revoked, or gone with its agent, takes the webhooks made with it.
			for (const key of keys) if (!readers.keys.has(key)) this.#forget("agent_key_id", key);
			let any = false;
			for (const event of events) {
				if (sql.exec("SELECT 1 FROM seen_event WHERE id = ?", event.id).toArray().length > 0) {
					continue;
				}
				// As the webhooks are now: one may have changed while the names were looked up, and an
				// agent's made meanwhile isn't known to hear the mailbox.
				const hooks = this.#listening(mailboxId).filter(
					(hook) => hook.events.includes(event.type) && hears(hook, event, mailboxId, readers),
				);
				if (hooks.length === 0) continue;
				sql.exec("INSERT INTO seen_event (id, at) VALUES (?, ?)", event.id, now);
				const where = {
					workspace: { id: workspaceId, slug: workspace.slug },
					mailbox: { id: mailboxId, name: mailbox.name },
					origin,
				};
				const body = (named: boolean) =>
					JSON.stringify(
						event.type === "message.received"
							? received(event, where)
							: sentPayload(event, where, members, named),
					);
				// An agent's own names no one, as the agent API names no member.
				const told = body(true);
				const unnamed = hooks.some((hook) => hook.agent !== null) ? body(false) : told;
				for (const hook of hooks) {
					const payload = hook.agent === null ? told : unnamed;
					this.#queue(hook.id, event.type, mailboxId, payload, now);
				}
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
					`SELECT delivery.id, delivery.attempts + 1 AS attempts, delivery.mailbox_id AS mailboxId,
						webhook.agent_member_id AS agent, webhook.agent_key_id AS key
					FROM delivery LEFT JOIN webhook ON webhook.id = delivery.webhook_id
					WHERE delivery.status = 'pending' AND delivery.next_attempt_at <= ?
					ORDER BY delivery.next_attempt_at LIMIT ?`,
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
		// Asked again as the round goes on, since slow receivers can make it long.
		let readers: { at: number; known: Promise<Readers | null> } | null = null;
		const readersNow = () => {
			if (!readers || Date.now() - readers.at > READERS_FRESH_MS) {
				readers = { at: Date.now(), known: this.#readersOf(claims) };
			}
			return readers.known;
		};
		let next = 0;
		const worker = async () => {
			while (next < claims.length) {
				const claim = claims[next++];
				if (!claim) break;
				// An agent's own goes only while its key works, and only of a mailbox it may still read.
				if (claim.agent !== null) {
					const known = await readersNow();
					// Not known now: tried again once its claim runs out.
					if (!known) continue;
					const why =
						claim.key === null || !known.keys.has(claim.key)
							? KEY_GONE
							: known.paused.has(claim.agent)
								? PAUSED
								: claim.mailboxId !== null && !known.reading.has(pair(claim.agent, claim.mailboxId))
									? UNREAD
									: null;
					if (why) {
						this.#failOne(claim.id, why, Date.now());
						continue;
					}
				}
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

	/**
	 * Which keys of agents' own webhooks still work, and which agents may still read what their
	 * claimed deliveries tell of; null when D1 didn't say.
	 */
	async #readersOf(claims: Claim[]): Promise<Readers | null> {
		const keys = [...new Set(claims.flatMap((claim) => claim.key ?? []))];
		const pairs = claims.flatMap((claim) =>
			claim.agent !== null && claim.mailboxId !== null
				? [{ agent: claim.agent, mailboxId: claim.mailboxId }]
				: [],
		);
		const agents = [...new Set(claims.flatMap((claim) => claim.agent ?? []))];
		const workspaceId = this.#meta("workspace");
		if (!workspaceId) return null;
		try {
			return await this.#readers(workspaceId, keys, pairs, agents);
		} catch (error) {
			console.error("webhooks: D1 didn't answer; an agent's deliveries wait", {
				name: error instanceof Error ? error.name : "unknown",
			});
			return null;
		}
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

	/**
	 * The active webhooks that hear of this mailbox's mail, with what they listen to and the agent
	 * that made each for itself, with its key.
	 */
	#listening(mailboxId: string): Listening[] {
		return this.ctx.storage.sql
			.exec<{
				id: string;
				events: string;
				mailboxIds: string | null;
				agent: string | null;
				key: string | null;
			}>(
				`SELECT id, events, mailbox_ids AS mailboxIds, agent_member_id AS agent,
					agent_key_id AS key
				FROM webhook WHERE active = 1`,
			)
			.toArray()
			.filter(
				(row) =>
					row.mailboxIds === null || (JSON.parse(row.mailboxIds) as string[]).includes(mailboxId),
			)
			.map((row) => ({
				id: row.id,
				events: JSON.parse(row.events) as WebhookEventType[],
				agent: row.agent,
				key: row.key,
			}));
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

	/** A webhook, if there is one with this id that the asker, when named, may see. */
	#row(id: string, asker?: Asker): WebhookRow | null {
		const row = this.ctx.storage.sql
			.exec<WebhookRow>(`SELECT ${WEBHOOK_COLUMNS} FROM webhook WHERE id = ?`, id)
			.toArray()[0];
		if (!row) return null;
		const agent = asker ? agentOf(asker) : null;
		return agent === null || row.agentMemberId === agent ? row : null;
	}

	/** Removes agents' own webhooks, by the agent or the key that made them, and their deliveries. */
	#forget(column: "agent_member_id" | "agent_key_id", value: string): void {
		const sql = this.ctx.storage.sql;
		sql.exec(
			`DELETE FROM delivery WHERE webhook_id IN (SELECT id FROM webhook WHERE ${column} = ?)`,
			value,
		);
		sql.exec(`DELETE FROM webhook WHERE ${column} = ?`, value);
	}

	/**
	 * Keeps which workspace this is and where the app is, as the gateway last said. An agent's
	 * request only says so when nobody has: where it came in is the agent's to choose.
	 */
	#remember(link: WebhookLink, asker: Asker): void {
		const sql = this.ctx.storage.sql;
		sql.exec(
			`INSERT OR ${"admin" in asker ? "REPLACE" : "IGNORE"} INTO meta (key, value)
			VALUES ('workspace', ?), ('origin', ?)`,
			link.workspaceId,
			link.origin,
		);
	}

	/**
	 * Why a webhook can't point at this URL: never at Mail itself, as the app's origin is known; for
	 * an agent's own, only over https.
	 */
	#urlRefusal(url: string, link: WebhookLink, asker: Asker): string | null {
		if ("admin" in asker) return urlRefusal(url, link.origin);
		if (new URL(url).protocol !== "https:") return "Use an https URL.";
		return urlRefusal(url, this.#meta("origin") ?? link.origin);
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

	/** The members events about sent mail name, by membership, as the workspace has them now. */
	async #members(workspaceId: string, events: MailEvent[]): Promise<Map<string, Known>> {
		const ids = [
			...new Set(
				events.flatMap((event) =>
					event.type === "message.received"
						? []
						: [event.sent.message.writtenBy, event.sent.message.approvedBy, event.sent.by],
				),
			),
		].filter((id) => id !== null);
		const db = createDb(this.env.DB);
		const { member, user } = schema;
		const rows = await inChunks(ids, (some) =>
			db
				.select({ id: member.id, name: user.name, role: member.role })
				.from(member)
				.innerJoin(user, eq(member.userId, user.id))
				.where(and(eq(member.organizationId, workspaceId), inArray(member.id, some)))
				.all(),
		);
		// As stored, not as `toRole` reads a role it doesn't know, which is for what they may do.
		return new Map(
			rows.map((row) => [row.id, { name: row.name, agent: isAgentMembership(row.role) }]),
		);
	}

	/** Which of these agents' keys still work: one revoked, or gone with its agent, doesn't. */
	async #workingKeys(keys: string[]): Promise<Set<string>> {
		const db = createDb(this.env.DB);
		const { agentKey } = schema;
		const rows = await inChunks(keys, (some) =>
			db.select({ id: agentKey.id }).from(agentKey).where(inArray(agentKey.id, some)).all(),
		);
		return new Set(rows.map((row) => row.id));
	}

	/**
	 * Of these agents' keys, those that still work; of each agent and mailbox, whether the agent may
	 * read that mailbox now, as `canReadMailbox` decides for its routes; and of these agents and
	 * those, which are paused.
	 */
	async #readers(
		workspaceId: string,
		keys: string[],
		pairs: { agent: string; mailboxId: string }[],
		others: string[] = [],
	): Promise<Readers> {
		const reading = new Set<string>();
		const agents = [...new Set([...pairs.map((one) => one.agent), ...others])];
		if (keys.length === 0 && agents.length === 0) {
			return { keys: new Set(), reading, paused: new Set() };
		}
		const mailboxIds = [...new Set(pairs.map((one) => one.mailboxId))];
		const db = createDb(this.env.DB);
		const { mailbox, mailboxAccess, member } = schema;
		const [working, roles, grants, boxes, paused] = await Promise.all([
			this.#workingKeys(keys),
			inChunks(agents, (some) =>
				db
					.select({ id: member.id, role: member.role })
					.from(member)
					.where(and(eq(member.organizationId, workspaceId), inArray(member.id, some)))
					.all(),
			),
			inChunks(agents, (some) =>
				db
					.select({ memberId: mailboxAccess.memberId, mailboxId: mailboxAccess.mailboxId })
					.from(mailboxAccess)
					.where(inArray(mailboxAccess.memberId, some))
					.all(),
			),
			inChunks(mailboxIds, (some) =>
				db
					.select({ id: mailbox.id, everyone: mailbox.everyone })
					.from(mailbox)
					.where(and(eq(mailbox.organizationId, workspaceId), inArray(mailbox.id, some)))
					.all(),
			),
			inChunks(agents, async (some) => [...(await pausedAmong(db, some))]),
		]);
		const roleOf = new Map(roles.map((row) => [row.id, toRole(row.role)]));
		const granted = new Set(grants.map((row) => pair(row.memberId, row.mailboxId)));
		const everyone = new Map(boxes.map((row) => [row.id, row.everyone]));
		for (const { agent, mailboxId } of pairs) {
			const role = roleOf.get(agent);
			const open = everyone.get(mailboxId);
			if (role === undefined || open === undefined) continue;
			const readable = canReadMailbox(role, {
				everyone: open,
				granted: granted.has(pair(agent, mailboxId)),
			});
			if (readable) reading.add(pair(agent, mailboxId));
		}
		return { keys: working, reading, paused: new Set(paused) };
	}

	/** Has the alarm run by then, unless it runs sooner anyway. */
	async #alarmBy(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}
}

/** An agent and a mailbox, as `Readers` keeps them. Both are UUIDs. */
const pair = (agent: string, mailboxId: string) => `${agent}/${mailboxId}`;

/**
 * Whether a webhook that listens to an event's type hears of this one: an agent's own only while
 * its key works, of a mailbox the agent may read, and not of what it did itself, such as holding
 * mail it wrote or sending what needed no approval.
 */
function hears(hook: Listening, event: MailEvent, mailboxId: string, readers: Readers): boolean {
	if (hook.agent === null) return true;
	if (hook.key === null || !readers.keys.has(hook.key)) return false;
	if (readers.paused.has(hook.agent)) return false;
	if (!readers.reading.has(pair(hook.agent, mailboxId))) return false;
	return event.type === "message.received" || event.sent.by !== hook.agent;
}

/** Reads ids a statement at a time, as D1 binds at most 100 values in one. */
async function inChunks<T>(ids: string[], read: (some: string[]) => Promise<T[]>): Promise<T[]> {
	const all: T[] = [];
	for (let at = 0; at < ids.length; at += IDS_AT_ONCE) {
		all.push(...(await read(ids.slice(at, at + IDS_AT_ONCE))));
	}
	return all;
}

/** Where an event happened, and where people reach the app. */
interface Where {
	workspace: { id: string; slug: string };
	mailbox: { id: string; name: string };
	origin: string;
}

/** Where to open a thread in the app. */
function threadUrl(where: Where, threadId: string): string {
	const path = [where.workspace.slug, "mailboxes", where.mailbox.id, "threads", threadId]
		.map(encodeURIComponent)
		.join("/");
	return new URL(`/${path}`, where.origin).href;
}

/** The body of a `message.received` delivery: what a listing shows of it, marked untrusted. */
function received(event: ReceivedEvent, where: Where): WebhookPayload {
	const message = event.message;
	const arrivedAt = new Date(message.arrivedAt).toISOString();
	return {
		type: "message.received",
		timestamp: arrivedAt,
		data: {
			workspace: where.workspace,
			mailbox: where.mailbox,
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
				url: threadUrl(where, message.threadId),
			},
			untrusted: UNTRUSTED,
		},
	};
}

/**
 * The body of a delivery about mail the workspace sends: the message as it was then, who did what
 * the event tells of, and for a recipient's server, what it did. Without `named`, members are
 * given by id, and whether they are an agent, but not by name.
 */
function sentPayload(
	event: SentEvent,
	where: Where,
	members: Map<string, Known>,
	named: boolean,
): WebhookPayload {
	const { message, by, recipient } = event.sent;
	const actor = (id: string | null): WebhookActor | null => {
		if (id === null) return null;
		const known = members.get(id);
		return { id, name: (named && known?.name) || null, agent: known?.agent ?? null };
	};
	return {
		type: event.type,
		timestamp: new Date(event.at).toISOString(),
		data: {
			workspace: where.workspace,
			mailbox: where.mailbox,
			message: {
				id: message.id,
				threadId: message.threadId,
				writtenAt: new Date(message.writtenAt).toISOString(),
				from: sender(message.from),
				to: message.to.map((address) => address.trim().toLowerCase()),
				cc: message.cc.map((address) => address.trim().toLowerCase()),
				subject: decoded(message.subject),
				writtenBy: actor(message.writtenBy),
				approvedBy: actor(message.approvedBy),
				url: threadUrl(where, message.threadId),
			},
			by: actor(by),
			recipient: recipient && { ...recipient, at: new Date(recipient.at).toISOString() },
			untrusted: SENT_UNTRUSTED,
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
		agentMemberId: row.agentMemberId,
		pausedByAdmin: row.pausedByAdmin === 1,
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
