import { and, eq, gt, isNotNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";
import { place, sealedDigest } from "./providers/keys";
import { SECRET_PLACE } from "./resend-inbound";
import { isSealer, type Sealer, sealerFor } from "./secrets";
import { type SecretsKeySettings, secretsKeys } from "./secrets-key";

/**
 * Seals workspaces' secrets in D1 again under the current `SECRETS_KEY`, from the daily run: after
 * the key changed, with the old one kept as `SECRETS_KEY_PREVIOUS`, and for values sealed before
 * keys had ids. Each value is opened, sealed under the current key and written back only if it is
 * still the one that was read, so a key saved or removed meanwhile is left as it now is. A
 * provider key keeps its version, so a send that may have gone is still tried again with it.
 */

/** How many values one run seals again, at most. The next run takes the rest. */
export const RESEAL_SECRETS_BATCH = 500;
/** How many rows are read at a time. */
const PAGE = 100;

export interface SecretsResealed {
	/** Sealed again under the current key. */
	resealed: number;
	/** Open with neither key, so left as they are. */
	unopened: number;
	/** Still under another key after this run, those that don't open among them. */
	left: number;
}

/** What this run did, or null when the deployment has no current key to seal with. */
export async function resealSecrets(
	db: Database,
	settings: SecretsKeySettings,
): Promise<SecretsResealed | null> {
	const keys = await secretsKeys(settings);
	if (!keys.current) return null;
	const prefix = `v2.${keys.current.id}.`;
	// Not LIKE: a key id may hold `_`, which LIKE takes for any character.
	const notCurrent = (column: SQLWrapper): SQL =>
		sql`substr(${column}, 1, ${prefix.length}) <> ${prefix}`;
	const sealers = new Map<string, Promise<Sealer | null>>();
	const sealerOf = (workspaceId: string) => {
		let made = sealers.get(workspaceId);
		if (!made) {
			made = sealerFor(settings, workspaceId).then((one) => (isSealer(one) ? one : null));
			sealers.set(workspaceId, made);
		}
		return made;
	};
	const done: SecretsResealed = { resealed: 0, unopened: 0, left: 0 };
	/** Opens and seals one value again, or says it doesn't open. */
	const again = async (workspaceId: string, where: string, sealed: string) => {
		const sealer = await sealerOf(workspaceId);
		if (!sealer) return null;
		try {
			return await sealer.seal(where, await sealer.open(where, sealed));
		} catch {
			done.unopened++;
			return null;
		}
	};

	const { providerKey, resendInbound } = schema;
	// Read in pages after the last row seen, so values that don't open never hold up the rest.
	// `as`, so that the loop's own assignments are what TypeScript goes by.
	let after = null as { workspaceId: string; provider: string } | null;
	while (done.resealed < RESEAL_SECRETS_BATCH) {
		const cursor = after;
		const rows = await db
			.select({
				workspaceId: providerKey.organizationId,
				provider: providerKey.provider,
				sealed: providerKey.sealed,
				version: providerKey.version,
			})
			.from(providerKey)
			.where(
				and(
					notCurrent(providerKey.sealed),
					cursor
						? sql`(${providerKey.organizationId}, ${providerKey.provider}) > (${cursor.workspaceId}, ${cursor.provider})`
						: undefined,
				),
			)
			.orderBy(providerKey.organizationId, providerKey.provider)
			.limit(PAGE)
			.all();
		for (const row of rows) {
			if (done.resealed >= RESEAL_SECRETS_BATCH) break;
			after = row;
			const sealed = await again(row.workspaceId, place(row.provider), row.sealed);
			if (sealed === null) continue;
			const written = await db
				.update(providerKey)
				.set({ sealed, version: row.version ?? (await sealedDigest(row.sealed)) })
				.where(
					and(
						eq(providerKey.organizationId, row.workspaceId),
						eq(providerKey.provider, row.provider),
						eq(providerKey.sealed, row.sealed),
					),
				)
				.returning({ provider: providerKey.provider })
				.all();
			done.resealed += written.length;
		}
		if (rows.length < PAGE) break;
	}

	let afterWorkspace = null as string | null;
	while (done.resealed < RESEAL_SECRETS_BATCH) {
		const cursor = afterWorkspace;
		const rows = await db
			.select({ workspaceId: resendInbound.organizationId, sealed: resendInbound.sealedSecret })
			.from(resendInbound)
			.where(
				and(
					isNotNull(resendInbound.sealedSecret),
					notCurrent(resendInbound.sealedSecret),
					cursor === null ? undefined : gt(resendInbound.organizationId, cursor),
				),
			)
			.orderBy(resendInbound.organizationId)
			.limit(PAGE)
			.all();
		for (const row of rows) {
			if (done.resealed >= RESEAL_SECRETS_BATCH) break;
			afterWorkspace = row.workspaceId;
			if (row.sealed === null) continue;
			const sealed = await again(row.workspaceId, SECRET_PLACE, row.sealed);
			if (sealed === null) continue;
			const written = await db
				.update(resendInbound)
				.set({ sealedSecret: sealed })
				.where(
					and(
						eq(resendInbound.organizationId, row.workspaceId),
						eq(resendInbound.sealedSecret, row.sealed),
					),
				)
				.returning({ workspaceId: resendInbound.organizationId })
				.all();
			done.resealed += written.length;
		}
		if (rows.length < PAGE) break;
	}

	const [keysLeft, inboundLeft] = await Promise.all([
		db
			.select({ count: sql<number>`count(*)` })
			.from(providerKey)
			.where(notCurrent(providerKey.sealed))
			.get(),
		db
			.select({ count: sql<number>`count(*)` })
			.from(resendInbound)
			.where(and(isNotNull(resendInbound.sealedSecret), notCurrent(resendInbound.sealedSecret)))
			.get(),
	]);
	done.left = (keysLeft?.count ?? 0) + (inboundLeft?.count ?? 0);
	return done;
}
