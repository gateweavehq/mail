import { env } from "cloudflare:workers";

export { type Asker, type MailEvent, type Refused, Webhooks } from "./durable-object";

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
