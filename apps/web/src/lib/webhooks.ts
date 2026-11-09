import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { DeliveryState } from "./delivery";
import type { Person } from "./mailbox";
import { isAdminRole } from "./roles";

/**
 * Webhooks tell other services, such as an agent's trigger, of mail as it comes and of what becomes
 * of mail the workspace sends. Each delivery is a POST signed per Standard Webhooks
 * (https://www.standardwebhooks.com): `webhook-id`, `webhook-timestamp` and `webhook-signature`
 * headers, with a `whsec_` secret.
 */
export const WEBHOOK_EVENTS = [
	"message.received",
	"message.held",
	"message.rejected",
	"message.sent",
	"message.delivered",
	"message.bounced",
	"message.complained",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** The events about mail the workspace sends, rather than mail that came to it. */
export type SentEventType = Exclude<WebhookEventType, "message.received">;

/** The events that tell of one recipient's server, from the provider's delivery events. */
export type DeliveryEventType = "message.delivered" | "message.bounced" | "message.complained";

/** Sent only when an admin asks for a test delivery, whatever the webhook subscribes to. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

/** The workspace's own, which owners and admins make. An agent's own don't count among them. */
export const MAX_WEBHOOKS = 10;

/** The most an agent may make for itself, through the agent API. */
export const MAX_AGENT_WEBHOOKS = 3;

/** The most mailboxes one webhook names; past that, it may as well hear of every mailbox. */
export const MAX_WEBHOOK_MAILBOXES = 50;

/**
 * A subscription to the workspace's events. Its secret is shown once, when it is made. An agent's
 * own hears only of mailboxes it may read, as it may when each event is queued and sent, and not
 * of what it did itself.
 */
export interface Webhook {
	id: string;
	url: string;
	events: WebhookEventType[];
	/**
	 * Only these mailboxes' mail, or every mailbox's when null, those made later too: for an
	 * agent's own, every mailbox it may read.
	 */
	mailboxIds: string[] | null;
	/** The agent that made it for itself, by membership; null for the workspace's own. */
	agentMemberId: string | null;
	/** For an agent's own, that an admin paused it, which only an admin undoes. */
	pausedByAdmin: boolean;
	/** A paused webhook queues nothing and drops what it had not delivered. */
	active: boolean;
	/** The secret's first characters, to tell secrets apart. */
	secretStart: string;
	createdAt: number;
	updatedAt: number;
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

/** One event on its way to one webhook. Its id is the `webhook-id` header, the same on retries. */
export interface WebhookDelivery {
	id: string;
	webhookId: string;
	event: WebhookEventType | typeof WEBHOOK_TEST_EVENT;
	status: WebhookDeliveryStatus;
	attempts: number;
	/** The last attempt's response status, or null if it got none (a network error or timeout). */
	responseStatus: number | null;
	error: string | null;
	/** When the next attempt is due, while the delivery is pending. */
	nextAttemptAt: number | null;
	createdAt: number;
	updatedAt: number;
}

const webhookUrl = z
	.url({ protocol: /^https?$/, error: "Enter an http or https URL." })
	.max(2048, "The URL is too long.");

const webhookEvents = z
	.array(z.enum(WEBHOOK_EVENTS))
	.min(1, "Choose at least one event.")
	.max(WEBHOOK_EVENTS.length * 2)
	.transform((events) => WEBHOOK_EVENTS.filter((event) => events.includes(event)));

const webhookMailboxes = z
	.array(z.string().min(1).max(64))
	.min(1, "Choose a mailbox, or every mailbox.")
	.max(
		MAX_WEBHOOK_MAILBOXES,
		`Choose at most ${MAX_WEBHOOK_MAILBOXES} mailboxes, or every mailbox.`,
	)
	.transform((ids) => [...new Set(ids)].sort())
	.nullable();

export const webhookInput = z.object({
	url: webhookUrl,
	events: webhookEvents,
	mailboxIds: webhookMailboxes,
});
export type WebhookInput = z.input<typeof webhookInput>;

export const webhookPatch = webhookInput.partial().extend({ active: z.boolean().optional() });
export type WebhookPatch = z.input<typeof webhookPatch>;

// Payloads. Every body is `{ type, timestamp, data }`, as Standard Webhooks recommends.

export interface WebhookWorkspace {
	id: string;
	/** The first segment of app URLs. */
	slug: string;
}

/** A message as the agent API's summaries give it, with its DMARC verdict and where to open it. */
export interface WebhookMessage {
	id: string;
	threadId: string;
	/** When it arrived, as an ISO 8601 date. */
	arrivedAt: string;
	from: Person | null;
	subject: string;
	/** The Date header, as sent. */
	date: string | null;
	/** The address it came to, lower case, as the envelope had it. */
	cameTo: string[];
	/** The From's domain, when DMARC proved that domain sent it; null when unproved. */
	verifiedDomain: string | null;
	dmarc: string | null;
	size: number;
	/** Where people open its thread. */
	url: string;
}

/** A member, as an event names them: who wrote, approved or rejected a message. */
export interface WebhookActor {
	/** Their membership's id. */
	id: string;
	/**
	 * Null once they have left the workspace, as `agent` is, and always for an agent's own webhook,
	 * as the agent API names no member.
	 */
	name: string | null;
	agent: boolean | null;
}

/** A message the workspace sent, or wrote to send, and where to open it. */
export interface WebhookSentMessage {
	id: string;
	threadId: string;
	/** When it was written, as an ISO 8601 date. */
	writtenAt: string;
	from: Person | null;
	to: string[];
	cc: string[];
	subject: string;
	/** Null for mail sent before Mail kept who wrote it. */
	writtenBy: WebhookActor | null;
	/** Who approved it, when it waited for approval. */
	approvedBy: WebhookActor | null;
	url: string;
}

/** What one recipient's server did with it, as the provider's delivery event said. */
export interface WebhookRecipient {
	/** Lower case. */
	address: string;
	state: DeliveryState;
	/** When it happened, by the provider's clock, as an ISO 8601 date. */
	at: string;
	/** What the receiving server or the provider said, cut short. */
	detail: string | null;
}

export type WebhookPayload =
	| {
			type: "message.received";
			/** When it arrived, as an ISO 8601 date. */
			timestamp: string;
			data: {
				workspace: WebhookWorkspace;
				mailbox: { id: string; name: string };
				message: WebhookMessage;
				/** How to read what the sender wrote. */
				untrusted: string;
			};
	  }
	| {
			type: SentEventType;
			/** When it happened, as an ISO 8601 date. */
			timestamp: string;
			data: {
				workspace: WebhookWorkspace;
				mailbox: { id: string; name: string };
				message: WebhookSentMessage;
				/** Who did what the event tells of; null for what a recipient's server did. */
				by: WebhookActor | null;
				/** For `message.delivered`, `.bounced` and `.complained`: the recipient it tells of. */
				recipient: WebhookRecipient | null;
				/** How to read the subject, and what a recipient's server said. */
				untrusted: string;
			};
	  }
	| {
			type: typeof WEBHOOK_TEST_EVENT;
			timestamp: string;
			data: { workspace: WebhookWorkspace; webhookId: string };
	  };

/** What the webhooks page shows an owner or admin. */
export interface WorkspaceWebhooks {
	webhooks: Webhook[];
	/** Each webhook's latest deliveries, newest first. */
	deliveries: WebhookDelivery[];
	/** The workspace's mailboxes, to choose from and to name those a webhook hears of. */
	mailboxes: { id: string; name: string }[];
	/** The agents that made webhooks of their own, by membership, to name them. */
	agents: { memberId: string; name: string }[];
}

/** A change, as the page sends it to `/api/webhooks/<workspace>`. */
export type WebhookAction =
	| { action: "create"; input: WebhookInput }
	| { action: "update"; id: string; patch: WebhookPatch }
	| { action: "delete"; id: string }
	| { action: "rotate"; id: string }
	| { action: "test"; id: string };

export type WebhookAnswer<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export const webhooksUrl = (slug: string) => `/api/webhooks/${encodeURIComponent(slug)}`;

/**
 * The workspace's webhooks and their latest deliveries, for owners and admins. `admin: false` for
 * other members, who don't see them; null if the caller is not a member.
 */
export const getWorkspaceWebhooks = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({
			data: slug,
		}): Promise<({ admin: true } & WorkspaceWebhooks) | { admin: false } | null> => {
			const { currentMember } = await import("#/server/access");
			const member = await currentMember(slug);
			if (!member) return null;
			if (!isAdminRole(member.membership.role)) return { admin: false };
			const { readWebhooks } = await import("#/server/webhooks/gateway");
			return { admin: true, ...(await readWebhooks(member.membership.workspaceId)) };
		},
	);
