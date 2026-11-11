import type { AgentAddressPolicy } from "../../lib/agent-addresses";
import type { AgentPolicy } from "../../lib/agent-policy";
import type {
	MailboxPage,
	MessageCursor,
	OpenedMessage,
	ThreadCursor,
	ThreadPage,
	ThreadsPage,
} from "../../lib/mailbox";
import type { Webhook, WebhookDelivery, WebhookEventType } from "../../lib/webhooks";
import type { AgentAddressAction } from "../directory/agent-addresses";
import type { SentFile } from "../mailbox/download";
import type { OutboxAction } from "../mailbox/send";

// What an agent's operations may do, whether they come over MCP or REST. They reach Mail only
// through MailAccess, which goes through the same functions as the agent's own routes, with its
// key: what an agent may read, send and make is decided there, once, and nothing here widens it.

/** A mailbox the agent may read. */
export interface AgentMailbox {
	id: string;
	name: string;
	/** Its live addresses on proved domains, lower case. */
	addresses: { id: string; address: string; expiresAt: number | null }[];
	/** Whether the agent was let send from it. */
	maySend: boolean;
}

/** A webhook of the agent's own, as it makes one. */
export interface AgentWebhookFields {
	url: string;
	events: WebhookEventType[];
	/** Mailboxes it may read, by id, sorted; null for every one it may read. */
	mailboxIds: string[] | null;
}

/** What it changes of one; what is left out stays as it is. */
export type AgentWebhookPatch = Partial<AgentWebhookFields> & { active?: boolean };

/** What a route answered, as its JSON. */
export interface Answer {
	status: number;
	body: Record<string, unknown>;
}

/** What the operations may do for one agent, in the one workspace its key was made for. */
export interface MailAccess {
	/** The mailboxes it may read. */
	mailboxes(): Promise<AgentMailbox[]>;
	/** Its limits: what it may send without a person, and what addresses it may make. */
	policies(): Promise<{ sending: AgentPolicy; addresses: AgentAddressPolicy }>;
	/**
	 * Whether it may start another wait for mail, counting it if so, and when it may if not, in
	 * seconds.
	 */
	startWait(): Promise<{ allowed: boolean; retryAfter: number | null }>;
	/** A page of a mailbox's messages, newest first; null once it may no longer read it. */
	messages(mailboxId: string, before: MessageCursor | null): Promise<MailboxPage | null>;
	threads(
		mailboxId: string,
		before: ThreadCursor | null,
		query: string | null,
	): Promise<ThreadsPage | null>;
	thread(
		mailboxId: string,
		threadId: string,
		before: MessageCursor | null,
	): Promise<ThreadPage | null>;
	/**
	 * Opens a message, and notes in the agent's log that it read it, or only a code in it, or with
	 * null nothing, as when Mail opens it only to address a reply.
	 */
	message(
		mailboxId: string,
		messageId: string,
		reading?: "message.read" | "code.read" | null,
	): Promise<OpenedMessage | null>;
	/**
	 * One of a message's attachments, by its place in the message's `attachments`, and notes in the
	 * agent's log that it took it; only its size when it is over `maxBytes`, and null when there is
	 * none it may read.
	 */
	attachment(
		mailboxId: string,
		messageId: string,
		index: number,
		maxBytes: number,
	): Promise<SentFile | { tooLarge: number } | null>;
	/** Lists the addresses it made in a mailbox, with `null`, or makes or ends one. */
	addresses(mailboxId: string, action: AgentAddressAction | null): Promise<Answer>;
	outbox(mailboxId: string, action: OutboxAction): Promise<Answer>;
	/**
	 * Its own webhooks, with each one's latest deliveries. The webhooks object decides as each
	 * event is queued, and again as it is sent, which mailboxes it may still hear of.
	 */
	webhooks(): Promise<{ webhooks: Webhook[]; deliveries: WebhookDelivery[] }>;
	/** Makes a webhook of its own, with a secret only this answer gives. */
	createWebhook(fields: AgentWebhookFields): Promise<{ webhook: Webhook; secret: string }>;
	/** Changes one of its webhooks, and with `renew` gives it a new secret, which only this answer gives. */
	updateWebhook(
		id: string,
		patch: AgentWebhookPatch,
		renew: boolean,
	): Promise<{ webhook: Webhook; secret: string | null }>;
	deleteWebhook(id: string): Promise<void>;
	/** Queues a `webhook.test` delivery to one of its webhooks. */
	testWebhook(id: string): Promise<void>;
}

/** The statuses a failure the caller can act on answers with, over REST. */
export type FailureStatus = 400 | 401 | 403 | 404 | 409 | 429;

/**
 * A failure the caller can act on: a tool error over MCP, an answer with its status over REST. Any
 * other error is Mail's own, and a 500.
 */
export class ApiError extends Error {
	readonly status: FailureStatus;
	/** For a 429, the seconds until a try may work. */
	readonly retryAfter: number | null;

	constructor(message: string, status: FailureStatus = 400, retryAfter: number | null = null) {
		super(message);
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

/**
 * A failure of Mail's own, in words Mail wrote, which may be logged as they are. Other errors may
 * carry what a message or a database said, so only their kind is.
 */
export class InternalFailure extends Error {}

/** What a transport tells the caller about a failure of Mail's own. */
export const INTERNAL_FAILURE = "Mail couldn't do that just now. Try again.";

/** Logs a failure of Mail's own in an operation, without a word of mail or a key. */
export function logFailure(operation: string, error: unknown): void {
	const said = error instanceof InternalFailure ? error.message : (error as Error)?.name;
	console.error(`agent api: ${operation} failed: ${said ?? "unknown"}`);
}

/**
 * The mailbox the agent means, by id, name or address, among those it may read. The same answer
 * for one that doesn't exist, so ids can't be probed.
 */
export async function findMailbox(access: MailAccess, wanted: string): Promise<AgentMailbox> {
	return pickMailbox(await access.mailboxes(), wanted);
}

/** As `findMailbox`, among the mailboxes the agent may read, as it gave them. */
export function pickMailbox(all: AgentMailbox[], wanted: string): AgentMailbox {
	const lower = wanted.toLowerCase();
	const byId = all.find((box) => box.id === wanted);
	if (byId) return byId;
	const byAddress = all.find((box) => box.addresses.some(({ address }) => address === lower));
	if (byAddress) return byAddress;
	const byName = all.filter((box) => box.name.toLowerCase() === lower);
	if (byName.length > 1) {
		throw new ApiError(`More than one mailbox is called "${wanted}". Use its id.`, 400);
	}
	const [named] = byName;
	if (!named) {
		throw new ApiError(`No mailbox "${wanted}" that you may read. See list_mailboxes.`, 404);
	}
	return named;
}

/** A listing, or the agent's word that it may no longer read the mailbox. */
export function gone<T>(page: T | null): T {
	if (!page) throw new ApiError("You may no longer read this mailbox. See list_mailboxes.", 404);
	return page;
}
