import { and, desc, eq, gt, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { SendsWith } from "../../lib/providers";
import {
	SUPPRESSION_RANK,
	type Suppression,
	type SuppressionReason,
	type SuppressionsPage,
} from "../../lib/suppressions";
import type { Database } from "../db";
import { schema } from "../db";

/**
 * Each workspace's suppression list in D1: the addresses its mail won't go to, from what the
 * providers' delivery events said. The queue's handler adds to it, sending checks it, and owners and
 * admins list and remove entries.
 */

const { mailSuppression } = schema;

/** How many entries one page lists. */
export const SUPPRESSIONS_PAGE = 50;

/**
 * How long a removed entry is remembered, so that an event from before it was removed doesn't put it
 * back. Longer than a queue keeps a message (14 days at most), so no such event is still to come.
 */
export const REMOVED_KEPT_DAYS = 15;

/**
 * Deletes entries nothing needs any more: ended ones, unless removed less than `REMOVED_KEPT_DAYS`
 * ago, and removed ones not said again since, once that time has passed. A batch at a time, as D1
 * runs one query at a time.
 */
export async function pruneSuppressions(db: Database, now: number, batch: number) {
	const kept = new Date(now - REMOVED_KEPT_DAYS * 24 * 60 * 60 * 1000);
	const removedLongAgo = lt(mailSuppression.removedAt, kept);
	const unneeded = or(
		and(
			lt(mailSuppression.expiresAt, new Date(now)),
			or(isNull(mailSuppression.removedAt), removedLongAgo),
		),
		and(removedLongAgo, sql`${mailSuppression.lastAt} <= ${mailSuppression.removedAt}`),
	);
	for (;;) {
		const ids = db
			.select({ id: mailSuppression.id })
			.from(mailSuppression)
			.where(unneeded)
			.limit(batch);
		const { meta } = await db.delete(mailSuppression).where(inArray(mailSuppression.id, ids)).run();
		if (meta.changes < batch) return;
	}
}

/** What an event says about sending to an address again, for `suppress`. */
export interface NewSuppression {
	workspaceId: string;
	/** Lower case. */
	address: string;
	reason: SuppressionReason;
	provider: SendsWith;
	detail: string | null;
	/** When the event happened. */
	at: number;
	/** Null for one that lasts until someone removes it. */
	expiresAt: number | null;
}

/** A reason's rank in SQL, from `SUPPRESSION_RANK`. */
const rank = (column: string) =>
	sql.raw(
		`CASE ${column} ${Object.entries(SUPPRESSION_RANK)
			.map(([reason, value]) => `WHEN '${reason}' THEN ${value}`)
			.join(" ")} END`,
	);

/** Whether the entry is on the list: never removed, or said again since it was. */
const listed = or(
	isNull(mailSuppression.removedAt),
	gt(mailSuppression.lastAt, mailSuppression.removedAt),
) as SQL;

/** Whether the entry is still in force at `now`: on the list, and not ended. */
const inForce = (now: number) =>
	and(
		listed,
		or(isNull(mailSuppression.expiresAt), gt(mailSuppression.expiresAt, new Date(now))),
	) as SQL;

/**
 * Adds addresses to their workspaces' lists, or brings an entry up to date: a stronger reason
 * replaces a weaker one, with its provider and words, as a newer event of the same reason does, and
 * an entry ends at the later of the two times, or not at all when either doesn't. One that had
 * ended starts again. One that someone removed starts again only for an event after that: one from
 * before, which a queue may hand over again, changes nothing, then or after the entry started
 * again, as when it was removed is kept. So events that come twice or out of order end the same.
 * An entry that has already ended adds nothing.
 */
export async function suppress(db: Database, entries: NewSuppression[], now: number) {
	const live = entries.filter(({ expiresAt }) => expiresAt === null || expiresAt > now);
	const [first, ...rest] = live.map((entry) => {
		// In an upsert's SET, a bare column is the stored row's, and `excluded.` the new one's.
		const stale = sql`(removed_at IS NOT NULL AND excluded.last_at <= removed_at)`;
		const removed = sql`(removed_at IS NOT NULL AND last_at <= removed_at)`;
		const fresh = sql`(${removed} OR (expires_at IS NOT NULL AND expires_at <= ${now}))`;
		const takes = sql`(${rank("excluded.reason")} > ${rank("reason")}
			OR (${rank("excluded.reason")} = ${rank("reason")} AND excluded.last_at >= last_at))`;
		const pick = (column: string) => {
			const stored = sql.raw(column);
			const incoming = sql.raw(`excluded.${column}`);
			return sql`CASE WHEN ${stale} THEN ${stored} WHEN ${fresh} THEN ${incoming}
				WHEN ${takes} THEN ${incoming} ELSE ${stored} END`;
		};
		return db
			.insert(mailSuppression)
			.values({
				id: crypto.randomUUID(),
				organizationId: entry.workspaceId,
				address: entry.address,
				reason: entry.reason,
				provider: entry.provider,
				detail: entry.detail,
				firstAt: new Date(entry.at),
				lastAt: new Date(entry.at),
				expiresAt: entry.expiresAt === null ? null : new Date(entry.expiresAt),
			})
			.onConflictDoUpdate({
				target: [mailSuppression.organizationId, mailSuppression.address],
				set: {
					reason: pick("reason"),
					provider: pick("provider"),
					detail: pick("detail"),
					firstAt: sql`CASE WHEN ${stale} THEN first_at WHEN ${fresh} THEN excluded.first_at
						ELSE min(first_at, excluded.first_at) END`,
					lastAt: sql`CASE WHEN ${stale} THEN last_at WHEN ${fresh} THEN excluded.last_at
						ELSE max(last_at, excluded.last_at) END`,
					expiresAt: sql`CASE WHEN ${stale} THEN expires_at WHEN ${fresh} THEN excluded.expires_at
						WHEN expires_at IS NULL OR excluded.expires_at IS NULL THEN NULL
						ELSE max(expires_at, excluded.expires_at) END`,
				},
			});
	});
	if (!first) return;
	await db.batch([first, ...rest]);
}

type Row = typeof mailSuppression.$inferSelect;

const shown = (row: Row): Suppression => ({
	id: row.id,
	address: row.address,
	reason: row.reason,
	provider: row.provider,
	detail: row.detail,
	firstAt: row.firstAt.getTime(),
	lastAt: row.lastAt.getTime(),
	expiresAt: row.expiresAt?.getTime() ?? null,
});

/** Those of these addresses the workspace's mail won't go to, now. */
export async function suppressedAmong(
	db: Database,
	workspaceId: string,
	addresses: string[],
	now: number,
): Promise<Suppression[]> {
	const lower = [...new Set(addresses.map((address) => address.trim().toLowerCase()))];
	if (lower.length === 0) return [];
	const rows = await db
		.select()
		.from(mailSuppression)
		.where(
			and(
				eq(mailSuppression.organizationId, workspaceId),
				inArray(mailSuppression.address, lower),
				inForce(now),
			),
		)
		.all();
	// In the order they were written to.
	return lower.flatMap((address) => {
		const row = rows.find((one) => one.address === address);
		return row ? [shown(row)] : [];
	});
}

/** Where a page of the list starts: after the entry last listed. */
export interface SuppressionCursor {
	lastAt: number;
	id: string;
}

const CURSOR = /^(\d{1,15}):([0-9a-f-]{36})$/;

export const cursorText = ({ lastAt, id }: SuppressionCursor) => `${lastAt}:${id}`;

/** A cursor as `cursorText` wrote it, or null for anything else. */
export function readCursor(text: string | null): SuppressionCursor | null {
	const match = CURSOR.exec(text ?? "");
	return match?.[1] && match[2] ? { lastAt: Number(match[1]), id: match[2] } : null;
}

/**
 * A page of the workspace's entries in force, the most recent first, those whose address holds
 * `query` when there is one.
 */
export async function listSuppressions(
	db: Database,
	workspaceId: string,
	{ query, before }: { query: string | null; before: SuppressionCursor | null },
	now: number,
): Promise<SuppressionsPage> {
	const rows = await db
		.select()
		.from(mailSuppression)
		.where(
			and(
				eq(mailSuppression.organizationId, workspaceId),
				inForce(now),
				// `instr`, not `LIKE`: D1 refuses a pattern over 50 bytes, and an address may be longer.
				query ? sql`instr(${mailSuppression.address}, ${query.toLowerCase()}) > 0` : undefined,
				before
					? or(
							lt(mailSuppression.lastAt, new Date(before.lastAt)),
							and(
								eq(mailSuppression.lastAt, new Date(before.lastAt)),
								lt(mailSuppression.id, before.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(mailSuppression.lastAt), desc(mailSuppression.id))
		.limit(SUPPRESSIONS_PAGE + 1)
		.all();
	const page = rows.slice(0, SUPPRESSIONS_PAGE).map(shown);
	const last = page.at(-1);
	return {
		suppressions: page,
		next: rows.length > SUPPRESSIONS_PAGE && last ? cursorText(last) : null,
	};
}

/**
 * Takes an entry off the workspace's list, now. The row stays, removed, for `REMOVED_KEPT_DAYS`, so
 * that `suppress` knows an event from before then. Never before its last event, even one whose
 * clock ran ahead, so that event can't count as newer. The entry's address, or null when the list
 * has no such entry.
 */
export async function removeSuppression(
	db: Database,
	workspaceId: string,
	id: string,
	now: number,
): Promise<string | null> {
	const [removed] = await db
		.update(mailSuppression)
		.set({ removedAt: sql`max(${now}, ${mailSuppression.lastAt})` })
		.where(and(eq(mailSuppression.id, id), eq(mailSuppression.organizationId, workspaceId), listed))
		.returning({ address: mailSuppression.address })
		.all();
	return removed?.address ?? null;
}

/** What `removeProviderListed` notes: the provider took the address off its own list. */
export interface ProviderRemoval {
	workspaceId: string;
	/** Lower case. */
	address: string;
	provider: SendsWith;
	/** What had put it on the provider's list, should the event that says so come only after. */
	reason: SuppressionReason;
	at: number;
}

/**
 * Notes that the provider took the address off its own list at `at`, as when someone removed it in
 * Resend's dashboard, for an entry that provider's events made: it comes off unless an event said
 * it since, and an event from before then, which may still come, counts as older than a removal,
 * as for `removeSuppression`. A removal noted already that is later stays; one that is earlier,
 * of an entry already off, moves on to this one, as the events between are older than it too.
 * With no entry yet, as when the event that would make it is still to come again, a removed one is
 * kept for it, which no list shows and pruning drops with the others.
 */
export async function removeProviderListed(
	db: Database,
	{ workspaceId, address, provider, reason, at }: ProviderRemoval,
) {
	await db
		.insert(mailSuppression)
		.values({
			id: crypto.randomUUID(),
			organizationId: workspaceId,
			address,
			reason,
			provider,
			detail: null,
			firstAt: new Date(at),
			lastAt: new Date(at),
			expiresAt: null,
			removedAt: new Date(at),
		})
		.onConflictDoUpdate({
			target: [mailSuppression.organizationId, mailSuppression.address],
			// In an upsert's SET, a bare column is the stored row's.
			set: { removedAt: sql`max(coalesce(removed_at, 0), ${at})` },
			setWhere: eq(mailSuppression.provider, provider),
		})
		.run();
}
