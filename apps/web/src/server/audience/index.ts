import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { ownObjects } from "../jurisdiction";

export { Audience, type Refused } from "./durable-object";

/** The workspace's audience object. Only the Worker reaches it, after checking who is asking. */
export function audienceStub(workspaceId: string) {
	return ownObjects(env.AUDIENCE).getByName(workspaceId);
}

async function destroyAudience(workspaceId: string): Promise<void> {
	await audienceStub(workspaceId).destroy();
}

/** Removes a deleted workspace's templates, and whatever else the object holds. */
export async function removeAudience(workspaceId: string): Promise<void> {
	try {
		await destroyAudience(workspaceId);
	} catch (error) {
		console.error("audience: removing a deleted workspace's failed; the daily run will", {
			name: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** How many audience removals one daily run finishes. The rest wait for the next. */
const AUDIENCE_REMOVALS_PER_RUN = 100;

/**
 * Empties the audience objects of workspaces that have gone, from D1's records, and forgets each
 * record only after the object answers. A failure keeps the row for the next run.
 */
export async function finishAudienceRemovals(db: Database): Promise<number> {
	const due = await db
		.select()
		.from(schema.audienceRemoval)
		.orderBy(asc(schema.audienceRemoval.attempts), asc(schema.audienceRemoval.removedAt))
		.limit(AUDIENCE_REMOVALS_PER_RUN)
		.all();
	let finished = 0;
	for (const removal of due) {
		try {
			await destroyAudience(removal.organizationId);
			await db
				.delete(schema.audienceRemoval)
				.where(eq(schema.audienceRemoval.organizationId, removal.organizationId))
				.run();
			finished++;
		} catch (error) {
			await db
				.update(schema.audienceRemoval)
				.set({ attempts: removal.attempts + 1 })
				.where(eq(schema.audienceRemoval.organizationId, removal.organizationId))
				.run();
			console.error("audience: finishing a removal failed; the next run will", {
				name: error instanceof Error ? error.name : "unknown",
			});
		}
	}
	return finished;
}
