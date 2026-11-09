import { env } from "cloudflare:workers";

export { type MailEvent, Webhooks } from "./durable-object";

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
