import { z } from "zod";
import { toAscii } from "./addresses";
import { isAddress } from "./outbox";

export const MAX_AGENT_NAME = 80;

/**
 * Which of an agent's mail waits for a person to approve it: none of it (`never`), what goes to
 * anyone its list doesn't name (`unlisted`), or all of it (`always`).
 */
export const APPROVALS = ["never", "unlisted", "always"] as const;
export type Approval = (typeof APPROVALS)[number];

/** What an agent may send. Owners and admins set it on Settings → Agents. */
export interface AgentPolicy {
	/** Messages it may write a day, held for approval or not. Zero stops it sending. */
	sendPerDay: number;
	/** Which of its mail waits for a person. */
	approval: Approval;
	/** Whether the agent may choose arbitrary mail and webhook targets, including unproved Cc on replies. */
	anyRecipient: boolean;
	/**
	 * Mail targets the owner or admin allows.
	 */
	allowed: string[];
	webhookHosts: string[];
	webhookHostsPending?: boolean;
	/**
	 * Whether mail to its own workspace's addresses follows `approval` like any other. Only for a
	 * policy nobody has saved since such mail began to go on its own: an agent from before keeps
	 * exactly what it had until a person changes its policy.
	 */
	insideWaits: boolean;
}

/** How many messages a day an agent may write until someone says otherwise. */
export const DEFAULT_SEND_PER_DAY = 20;

/**
 * The policy of an agent that has none stored, which only an agent made before agents sent on
 * their own can be: a few messages a day, each approved by a person, as it was then.
 */
export const DEFAULT_AGENT_POLICY: AgentPolicy = {
	sendPerDay: DEFAULT_SEND_PER_DAY,
	approval: "always",
	anyRecipient: false,
	allowed: [],
	webhookHosts: [],
	insideWaits: true,
};

/** The policy an agent is made with: a few messages a day, each going on its own. */
export const NEW_AGENT_POLICY: AgentPolicy = {
	sendPerDay: DEFAULT_SEND_PER_DAY,
	approval: "never",
	anyRecipient: false,
	allowed: [],
	webhookHosts: [],
	insideWaits: false,
};

/** The most messages an agent may be let write a day. */
export const MAX_AGENT_SEND_PER_DAY = 1000;

/** The most addresses and domains one agent may write to without approval. */
export const MAX_ALLOWED_ENTRIES = 100;

/** A normalized mail target, or null when it cannot be a single address. */
export function normalTarget(value: string): string | null {
	const at = value.lastIndexOf("@");
	if (at < 1) return null;
	const domain = value
		.slice(at + 1)
		.toLowerCase()
		.replace(/\.$/, "");
	if (/[\s\\/%?#:@]/u.test(domain)) return null;
	const host = toAscii(domain);
	if (host === null) return null;
	const address = `${value.slice(0, at).toLowerCase()}@${host}`;
	return isAddress(address) ? address : null;
}

/** Whole hosts also serve webhooks on single-label names or IP literals. */
function normalizedHost(entry: string): string | null {
	const domain = entry.replace(/\.$/, "");
	if (!domain || /[\s\\/%?#@*]/u.test(domain)) return null;
	try {
		const ascii = toAscii(domain.toLowerCase());
		if (ascii && isAddress(`a@${ascii}`)) return ascii;
		const host = new URL(`https://${domain}`).hostname;
		if (domain.includes(":") && !(domain.startsWith("[") && domain.endsWith("]"))) return null;
		return host.length <= 253 &&
			(/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(host) || /^\[[a-f\d:]+\]$/i.test(host))
			? host
			: null;
	} catch {
		return null;
	}
}

/** One allowed entry, as typed: an address, or `@` and a domain. Lower case once read. */
export const AllowedEntry = z
	.string()
	.trim()
	.transform((entry, ctx) => {
		const host = entry.startsWith("@") ? normalizedHost(entry.slice(1)) : null;
		const target = host ? `@${host}` : normalTarget(entry);
		if (target !== null) return target;
		ctx.addIssue({ code: "custom", message: "Enter an address or @domain." });
		return z.NEVER;
	});

export const WebhookHost = z
	.string()
	.trim()
	.transform((entry, ctx) => {
		const host = normalizedHost(entry);
		if (host !== null) return host;
		ctx.addIssue({ code: "custom", message: "Enter a webhook host, such as hooks.example.com." });
		return z.NEVER;
	});

export const AgentPolicyInput = z.object({
	sendPerDay: z.number().int().min(0).max(MAX_AGENT_SEND_PER_DAY),
	allowed: z.array(AllowedEntry).max(MAX_ALLOWED_ENTRIES),
	/**
	 * Without it, what the list alone used to say: with entries, the rest waits; empty, everything
	 * does. So a page loaded before the choice existed still saves what it shows.
	 */
	approval: z.enum(APPROVALS).optional(),
	webhookHosts: z.array(WebhookHost).max(MAX_ALLOWED_ENTRIES).optional(),
	anyRecipient: z.boolean().optional(),
});

/** What a list alone says, as it did before there was a choice: empty, everything waits. */
export const approvalOfList = (allowed: readonly string[]): Approval =>
	allowed.length > 0 ? "unlisted" : "always";

/**
 * A stored policy, read back. A row from before the choice has no `approval`, and reads as it did:
 * by its list, with mail inside the workspace waiting like the rest. `unlisted` with nothing listed
 * is `always` by another name, and so is anything this version doesn't know.
 */
export function readPolicy(row: {
	sendPerDay: number;
	allowed: string;
	approval: string | null;
	webhookHosts?: string | null;
	anyRecipient?: boolean | null;
}): AgentPolicy {
	const allowed = readAllowed(row.allowed);
	const approval =
		row.approval === "never" || row.approval === "always" ? row.approval : approvalOfList(allowed);
	return {
		sendPerDay: row.sendPerDay,
		approval,
		allowed,
		webhookHosts: readAllowed(row.webhookHosts ?? "[]"),
		anyRecipient: row.anyRecipient === true,
		insideWaits: row.approval === null,
	};
}

/**
 * Whether an agent's message may go to this address without a person approving it: the address is
 * allowed, or its domain is. A domain covers itself, not its subdomains, so `@example.com` doesn't
 * let mail go to `someone@mail.example.com`.
 */
export function isAllowedRecipient(address: string, allowed: readonly string[]): boolean {
	const lower = normalTarget(address);
	if (!lower) return false;
	const at = lower.lastIndexOf("@");
	if (at < 1) return false;
	return allowed.includes(lower) || allowed.includes(lower.slice(at));
}

/** Whether a message to all of these may go without approval. */
export const goesWithoutApproval = (recipients: readonly string[], allowed: readonly string[]) =>
	recipients.length > 0 && recipients.every((address) => isAllowedRecipient(address, allowed));

/**
 * Whether a message to these waits for a person, by the policy alone. Mail that stays inside the
 * agent's workspace is asked about apart, where it is sent, as only the directory and DNS can say.
 */
export function waitsForApproval(
	policy: Pick<AgentPolicy, "approval" | "allowed">,
	recipients: readonly string[],
): boolean {
	if (policy.approval === "never") return false;
	if (policy.approval === "always") return true;
	return !goesWithoutApproval(recipients, policy.allowed);
}

/** A stored policy's `allowed`, which is JSON, read back; anything not a list of strings is none. */
export function readAllowed(stored: string): string[] {
	try {
		const parsed: unknown = JSON.parse(stored);
		return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

/**
 * What an agent may send, in a sentence, for the Agents page and the agent's log. Mail to the
 * workspace's own addresses goes on its own under every policy but one from before that was so
 * (`insideWaits`), so a sentence about what waits says so.
 */
export function policySummary(policy: AgentPolicy): string {
	if (policy.sendPerDay === 0) return "Can't send mail.";
	const day = `Writes up to ${policy.sendPerDay} ${policy.sendPerDay === 1 ? "message" : "messages"} a day`;
	if (policy.approval === "never") return `${day}, each going on its own.`;
	if (policy.approval === "always" || policy.allowed.length === 0) {
		return policy.insideWaits
			? `${day}, each waiting for approval.`
			: `${day}, each waiting for approval unless it goes only to this workspace's own addresses.`;
	}
	const named = policy.allowed.slice(0, 2).join(", ");
	const others = policy.allowed.length - 2;
	const listed = others > 0 ? `${named} and ${others} more` : named;
	return policy.insideWaits
		? `${day}. To ${listed} it goes on its own; anything else waits for approval.`
		: `${day}. To ${listed}, and to this workspace's own addresses alone, it goes on its own; anything else waits for approval.`;
}

/** The addresses and domains typed into the dialog, one a line or apart by commas. */
export const typedAllowed = (typed: string) =>
	[...new Set(typed.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()))].filter(Boolean);
