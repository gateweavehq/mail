import { env } from "cloudflare:workers";

export { Audience, type Refused } from "./durable-object";

/** The workspace's audience object. Only the Worker reaches it, after checking who is asking. */
export function audienceStub(workspaceId: string) {
	return env.AUDIENCE.getByName(workspaceId);
}

/** Removes a deleted workspace's templates, and whatever else the object holds. */
export async function removeAudience(workspaceId: string): Promise<void> {
	try {
		await audienceStub(workspaceId).destroy();
	} catch (error) {
		console.error("audience: removing a deleted workspace's failed", {
			name: error instanceof Error ? error.name : "unknown",
		});
	}
}
