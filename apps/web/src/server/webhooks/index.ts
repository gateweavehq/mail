import { env } from "cloudflare:workers";
import { eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { keysDone } from "../reseal-state";
import { type SecretsKeySettings, secretsKeys } from "../secrets-key";

export { type Asker, type MailEvent, type Refused, Webhooks } from "./durable-object";

/** How many workspaces one daily run asks about webhook secrets under the previous key. */
export const RESEAL_WEBHOOKS_PER_RUN = 200;

/** The workspace's webhook object. Only the Worker reaches it, after checking who is asking. */
export function webhooksStub(workspaceId: string) {
	return env.WEBHOOKS.getByName(workspaceId);
}

/** Removes a deleted workspace's webhooks, with their secrets and what they had not delivered. */
export async function removeWebhooks(workspaceId: string): Promise<void> {
	try {
		await webhooksStub(workspaceId).destroy();
	} catch (error) {
		// The object also clears itself when it finds the workspace gone.
		console.error("webhooks: removing a deleted workspace's failed", {
			name: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** Removes the webhooks an agent made with a key that was revoked, and what they had not delivered. */
export async function removeKeyWebhooks(workspaceId: string, keyId: string): Promise<void> {
	try {
		await webhooksStub(workspaceId).removeKey(keyId);
	} catch (error) {
		// The object also removes them when it finds the key gone, as does the webhooks page.
		console.error("webhooks: removing a revoked key's failed", {
			name: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** Removes the webhooks a deleted agent made for itself, and what they had not delivered. */
export async function removeAgentWebhooks(workspaceId: string, memberId: string): Promise<void> {
	try {
		await webhooksStub(workspaceId).removeAgent(memberId);
	} catch (error) {
		// The object also removes them when it finds the agent's keys gone, as does the webhooks page.
		console.error("webhooks: removing a deleted agent's failed", {
			name: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** What one daily run found of webhook secrets after `SECRETS_KEY` changed. */
export interface WebhooksResealed {
	/** Workspaces whose webhooks object answered. */
	asked: number;
	/** Secrets they hold that open with neither key. */
	unopened: number;
	/** Workspaces whose webhooks may still need the previous key, after this run. */
	left: number;
}

/**
 * Asks workspaces' webhooks objects to seal their secrets under the current `SECRETS_KEY`, which
 * each also does as it wakes, and notes in D1 each that holds none that needs the previous key
 * (`webhooks_sealed`, see `keysDone`), so that the previous key may go once no workspace is left.
 * Null when the deployment has no previous key. Those asked are picked at random from the rest, so
 * that one that keeps failing doesn't keep others from their turn. Asking wakes the object, which
 * makes an empty one for a workspace that never had webhooks, as a backup's read does.
 */
export async function resealWebhooks(
	db: Database,
	settings: SecretsKeySettings,
): Promise<WebhooksResealed | null> {
	const { current, previous } = await secretsKeys(settings);
	if (!current || !previous) return null;
	const { organization, webhooksSealed } = schema;
	const doneWith = keysDone(current.id, previous.id);
	const notDone = or(isNull(webhooksSealed.sealedUnder), ne(webhooksSealed.sealedUnder, doneWith));
	const due = await db
		.select({ id: organization.id })
		.from(organization)
		.leftJoin(webhooksSealed, eq(webhooksSealed.organizationId, organization.id))
		.where(notDone)
		.orderBy(sql`random()`)
		.limit(RESEAL_WEBHOOKS_PER_RUN)
		.all();
	const done: WebhooksResealed = { asked: 0, unopened: 0, left: 0 };
	// A few at once: each is a call to the workspace's object.
	for (let at = 0; at < due.length; at += 10) {
		await Promise.all(
			due.slice(at, at + 10).map(async ({ id }) => {
				try {
					const status = await webhooksStub(id).secretsStatus();
					done.asked++;
					done.unopened += status.unopened;
					if (status.left === 0) {
						await db
							.insert(webhooksSealed)
							.values({ organizationId: id, sealedUnder: doneWith })
							.onConflictDoUpdate({
								target: webhooksSealed.organizationId,
								set: { sealedUnder: doneWith },
							})
							.run();
					}
				} catch (error) {
					console.error("webhooks: asking about secrets under the previous key failed", {
						name: error instanceof Error ? error.name : "unknown",
					});
				}
			}),
		);
	}
	const left = await db
		.select({ count: sql<number>`count(*)` })
		.from(organization)
		.leftJoin(webhooksSealed, eq(webhooksSealed.organizationId, organization.id))
		.where(notDone)
		.get();
	done.left = left?.count ?? 0;
	return done;
}
