import type { QueuedMessage } from "./mail-worker";

/** The queue Email Sending's events come on, as `wrangler.jsonc` names it. */
export const SENDING_EVENTS = "gateweave-mail-events";

let queued = 0;

/** An Email Sending event on the queue, as the staging measurement saw them. */
export function sendingEvent(
	type: string,
	{
		messageId,
		sender,
		recipient,
		domain = sender.slice(sender.indexOf("@") + 1),
		at = Date.now(),
		payload = {},
	}: {
		messageId: string;
		sender: string;
		recipient: string;
		domain?: string;
		at?: number;
		payload?: Record<string, unknown>;
	},
): QueuedMessage {
	return {
		id: `queued-${++queued}`,
		timestamp: new Date(),
		attempts: 1,
		body: {
			type: `cf.email.sending.message.${type}`,
			source: { zoneId: "zone", domain, type: "email.sending" },
			metadata: {
				accountId: "account",
				eventSubscriptionId: "subscription",
				eventSchemaVersion: 1,
				eventTimestamp: new Date(at).toISOString(),
			},
			payload: {
				eventId: crypto.randomUUID(),
				messageId,
				sender,
				recipient,
				subject: "Hello",
				terminal: type !== "deferred",
				delivery: { status: type, provider: "external_smtp" },
				...payload,
			},
		},
	};
}
