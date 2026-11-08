import { and, eq } from "drizzle-orm";
import type { KeyedProvider, ProviderKeyInfo, SendsWith } from "../../lib/providers";
import type { Database } from "../db";
import { schema } from "../db";
import { isSealer, sealerFor } from "../secrets";

/**
 * A workspace's keys for mail providers, sealed in D1. Only the server opens one, when it sends; a
 * page sees who added it, when, and its last four characters.
 */

/** Where a provider's key is sealed, which its sealed value names so it opens nowhere else. */
const place = (provider: KeyedProvider) => `provider-keys/${provider}`;

/** What a page may know of a workspace's key for this provider, or null when it has none. */
export async function providerKeyInfo(
	db: Database,
	workspaceId: string,
	provider: KeyedProvider,
): Promise<ProviderKeyInfo | null> {
	const { providerKey, user } = schema;
	const row = await db
		.select({ hint: providerKey.hint, addedBy: user.name, addedAt: providerKey.addedAt })
		.from(providerKey)
		.leftJoin(user, eq(user.id, providerKey.addedBy))
		.where(and(eq(providerKey.organizationId, workspaceId), eq(providerKey.provider, provider)))
		.get();
	return row
		? { provider, hint: row.hint, addedBy: row.addedBy, addedAt: row.addedAt.getTime() }
		: null;
}

/** Seals a key and keeps it for the workspace, in place of any it had. */
export async function saveProviderKey(
	db: Database,
	secretsKey: string | undefined,
	{
		workspaceId,
		provider,
		key,
		addedBy,
	}: { workspaceId: string; provider: KeyedProvider; key: string; addedBy: string },
): Promise<{ ok: true; info: ProviderKeyInfo } | { ok: false; error: string }> {
	const sealer = await sealerFor(secretsKey, workspaceId);
	if (!isSealer(sealer)) return { ok: false, error: sealer.unavailable };
	const values = {
		sealed: await sealer.seal(place(provider), key),
		hint: key.slice(-4),
		addedBy,
		addedAt: new Date(),
	};
	await db
		.insert(schema.providerKey)
		.values({ organizationId: workspaceId, provider, ...values })
		.onConflictDoUpdate({
			target: [schema.providerKey.organizationId, schema.providerKey.provider],
			set: values,
		})
		.run();
	return { ok: true, info: (await providerKeyInfo(db, workspaceId, provider)) as ProviderKeyInfo };
}

export async function removeProviderKey(
	db: Database,
	workspaceId: string,
	provider: KeyedProvider,
): Promise<boolean> {
	const { providerKey } = schema;
	const removed = await db
		.delete(providerKey)
		.where(and(eq(providerKey.organizationId, workspaceId), eq(providerKey.provider, provider)))
		.returning({ provider: providerKey.provider })
		.all();
	return removed.length > 0;
}

export type OpenedKey =
	| { ok: true; key: string }
	/** `no_key`: the workspace has none. `key_unreadable`: it won't open with this deployment's `SECRETS_KEY`. */
	| { ok: false; code: "no_key" | "key_unreadable" };

/** A workspace's key, opened, for sending. */
export async function openProviderKey(
	db: Database,
	secretsKey: string | undefined,
	workspaceId: string,
	provider: KeyedProvider,
): Promise<OpenedKey> {
	const { providerKey } = schema;
	const row = await db
		.select({ sealed: providerKey.sealed })
		.from(providerKey)
		.where(and(eq(providerKey.organizationId, workspaceId), eq(providerKey.provider, provider)))
		.get();
	if (!row) return { ok: false, code: "no_key" };
	const sealer = await sealerFor(secretsKey, workspaceId);
	if (!isSealer(sealer)) return { ok: false, code: "key_unreadable" };
	try {
		return { ok: true, key: await sealer.open(place(provider), row.sealed) };
	} catch {
		return { ok: false, code: "key_unreadable" };
	}
}

/**
 * How mail from this address is sent: by its domain's setting, and whether the workspace has the
 * key that needs. Null when the address isn't on one of the workspace's domains.
 */
export async function sendingWith(
	db: Database,
	workspaceId: string,
	address: string,
): Promise<{ sendsWith: SendsWith; keyed: boolean } | null> {
	const { mailDomain, providerKey } = schema;
	const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
	const row = await db
		.select({ sendsWith: mailDomain.sendsWith, keyed: providerKey.provider })
		.from(mailDomain)
		.leftJoin(
			providerKey,
			and(
				eq(providerKey.organizationId, mailDomain.organizationId),
				eq(providerKey.provider, "resend"),
			),
		)
		.where(and(eq(mailDomain.organizationId, workspaceId), eq(mailDomain.name, domain)))
		.get();
	return row ? { sendsWith: row.sendsWith, keyed: row.keyed !== null } : null;
}
