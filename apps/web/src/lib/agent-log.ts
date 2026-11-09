// What an agent's log holds and how its page says it. No server code: the page imports it too.

/** How long the log keeps what happened, in days. The daily run lets older entries go. */
export const AGENT_LOG_DAYS = 90;

/** How many entries one page of the log shows: the newest, or those before a cursor. */
export const AGENT_LOG_PAGE = 50;

/** The longest subject an entry keeps, the start of a longer one. */
export const MAX_LOGGED_SUBJECT = 200;

/** The longest detail an entry keeps, such as what a policy became. */
export const MAX_LOGGED_DETAIL = 300;

/**
 * What can happen, by kind. The agent does the first four with its key; people do the last to it.
 * An entry names what it was done to, by id, and a message's subject at most, never what it says.
 */
export const AGENT_LOG_KINDS = {
	reads: ["message.read", "code.read", "mail.searched"],
	mail: ["message.sent", "message.held", "message.approved", "message.rejected"],
	addresses: ["address.made", "address.ended"],
	webhooks: ["webhook.made", "webhook.changed", "webhook.deleted", "webhook.tested"],
	people: [
		"agent.made",
		"agent.renamed",
		"key.made",
		"key.revoked",
		"policy.changed",
		"address-policy.changed",
		"agent.paused",
		"agent.resumed",
		"access.changed",
	],
} as const;

export type AgentLogKind = keyof typeof AGENT_LOG_KINDS;

export type AgentLogAction = (typeof AGENT_LOG_KINDS)[AgentLogKind][number];

export const AGENT_LOG_ACTIONS: readonly AgentLogAction[] = Object.values(AGENT_LOG_KINDS).flat();

export const isAgentLogKind = (kind: unknown): kind is AgentLogKind =>
	typeof kind === "string" && Object.hasOwn(AGENT_LOG_KINDS, kind);

/** What the page calls each kind, for its filter. */
export const AGENT_LOG_KIND_NAMES: Record<AgentLogKind, string> = {
	reads: "Reads",
	mail: "Mail",
	addresses: "Addresses",
	webhooks: "Webhooks",
	people: "Changes by people",
};

/** One entry of an agent's log, as its page shows it. */
export interface AgentLogEntry {
	id: string;
	at: number;
	action: AgentLogAction;
	/** Who did it: the agent, with its key, or a person, named while their account lasts. */
	by: { agent: true } | { agent: false; name: string | null };
	/** The mailbox it was in, named while it lasts. */
	mailbox: { id: string; name: string | null } | null;
	/** What it was done to, by id: a message, a thread, an address, a webhook or a key. */
	target: string | null;
	/** For a message, its subject, cut to `MAX_LOGGED_SUBJECT`. */
	subject: string | null;
	/** A few words more, such as the address it made or what a policy became. */
	detail: string | null;
	/** For a message, the thread it is in, so the page can open it. */
	thread: string | null;
}

/** A page of the log, with where the next older one starts. */
export interface AgentLogPage {
	entries: AgentLogEntry[];
	next: { at: number; id: string } | null;
}

/** What an entry says happened, in a few words, after who did it. */
export function agentLogVerb(entry: Pick<AgentLogEntry, "action" | "detail">): string {
	switch (entry.action) {
		case "message.read":
			return "read a message";
		case "code.read":
			return "read a code in a message";
		case "mail.searched":
			return "searched a mailbox";
		case "message.sent":
			return "sent a message";
		case "message.held":
			return "wrote a message that waits for approval";
		case "message.approved":
			return "approved its message";
		case "message.rejected":
			return "rejected its message";
		case "address.made":
			return "made an address";
		case "address.ended":
			return "ended an address";
		case "webhook.made":
			return "made a webhook";
		case "webhook.changed":
			return "changed a webhook";
		case "webhook.deleted":
			return "deleted a webhook";
		case "webhook.tested":
			return "tested a webhook";
		case "agent.made":
			return "made the agent";
		case "agent.renamed":
			return "renamed the agent";
		case "key.made":
			return "made a key";
		case "key.revoked":
			return "revoked a key";
		case "policy.changed":
			return "changed what it may send";
		case "address-policy.changed":
			return "changed what addresses it may make";
		case "agent.paused":
			return "paused the agent";
		case "agent.resumed":
			return "resumed the agent";
		case "access.changed":
			return "changed its access to a mailbox";
	}
}
