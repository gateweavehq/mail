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

/** Whether the entry is still in force at `now`. */
const inForce = (now: number) =>
	or(isNull(mailSuppression.expiresAt), gt(mailSuppression.expiresAt, new Date(now))) as SQL;

/**
 * Adds addresses to their workspaces' lists, or brings an entry up to date: a stronger reason
 * replaces a weaker one, with its provider and words, and an entry ends at the later of the two
 * times, or not at all when either doesn't. One that had ended starts again. So events that come
 * twice or out of order end the same.
 */
export async function suppress(db: Database, entries: NewSuppression[], now: number) {
	const [first, ...rest] = entries.map((entry) => {
		// In an upsert's SET, a bare column is the stored row's, and `excluded.` the new one's.
		const ended = sql`(expires_at IS NOT NULL AND expires_at <= ${now})`;
		const takes = sql`(${ended} OR ${rank("excluded.reason")} >= ${rank("reason")})`;
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
					reason: sql`CASE WHEN ${takes} THEN excluded.reason ELSE reason END`,
					provider: sql`CASE WHEN ${takes} THEN excluded.provider ELSE provider END`,
					detail: sql`CASE WHEN ${takes} THEN excluded.detail ELSE detail END`,
					firstAt: sql`CASE WHEN ${ended} THEN excluded.first_at ELSE min(first_at, excluded.first_at) END`,
					lastAt: sql`CASE WHEN ${ended} THEN excluded.last_at ELSE max(last_at, excluded.last_at) END`,
					expiresAt: sql`CASE WHEN ${ended} THEN excluded.expires_at
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

/** `LIKE`'s own characters, taken as they are. */
const literal = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

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
				query
					? sql`${mailSuppression.address} LIKE ${`%${literal(query.toLowerCase())}%`} ESCAPE '\\'`
					: undefined,
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

/** Takes an entry off the workspace's list. False when the workspace has no such entry. */
export async function removeSuppression(
	db: Database,
	workspaceId: string,
	id: string,
): Promise<boolean> {
	const { meta } = await db
		.delete(mailSuppression)
		.where(and(eq(mailSuppression.id, id), eq(mailSuppression.organizationId, workspaceId)))
		.run();
	return meta.changes > 0;
}
