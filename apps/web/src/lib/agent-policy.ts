import { z } from "zod";
import { isAddress } from "./outbox";

/** What an agent may send. Owners and admins set it on Settings → Agents. */
export interface AgentPolicy {
	/** Messages it may write a day, held for approval or not. Zero stops it sending. */
	sendPerDay: number;
	/**
	 * Where its mail goes without a person approving it: whole addresses, or domains written
	 * `@example.com`, lower case. Everything else waits.
	 */
	allowed: string[];
}

/** An agent's policy until someone sets one: a few messages a day, each approved by a person. */
export const DEFAULT_AGENT_POLICY: AgentPolicy = { sendPerDay: 20, allowed: [] };

/** The most messages an agent may be let write a day. */
export const MAX_AGENT_SEND_PER_DAY = 1000;

/** The most addresses and domains one agent may write to without approval. */
export const MAX_ALLOWED_ENTRIES = 100;

/** Whether this is a domain as an allowed entry names one, after its `@`. */
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** One allowed entry, as typed: an address, or `@` and a domain. Lower case once read. */
export const AllowedEntry = z
	.string()
	.trim()
	.toLowerCase()
	.max(254)
	.refine((entry) => (entry.startsWith("@") ? DOMAIN.test(entry.slice(1)) : isAddress(entry)));

export const AgentPolicyInput = z.object({
	sendPerDay: z.number().int().min(0).max(MAX_AGENT_SEND_PER_DAY),
	allowed: z.array(AllowedEntry).max(MAX_ALLOWED_ENTRIES),
});

/**
 * Whether an agent's message may go to this address without a person approving it: the address is
 * allowed, or its domain is. A domain covers itself, not its subdomains, so `@example.com` doesn't
 * let mail go to `someone@mail.example.com`.
 */
export function isAllowedRecipient(address: string, allowed: readonly string[]): boolean {
	const lower = address.toLowerCase();
	const at = lower.lastIndexOf("@");
	if (at < 1) return false;
	return allowed.includes(lower) || allowed.includes(lower.slice(at));
}

/** Whether a message to all of these may go without approval. */
export const goesWithoutApproval = (recipients: readonly string[], allowed: readonly string[]) =>
	recipients.length > 0 && recipients.every((address) => isAllowedRecipient(address, allowed));

/** A stored policy's `allowed`, which is JSON, read back; anything not a list of strings is none. */
export function readAllowed(stored: string): string[] {
	try {
		const parsed: unknown = JSON.parse(stored);
		return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

/** What an agent may send, in a sentence. */
export function policySummary(policy: AgentPolicy): string {
	if (policy.sendPerDay === 0) return "Can't send mail.";
	const day = `Writes up to ${policy.sendPerDay} ${policy.sendPerDay === 1 ? "message" : "messages"} a day`;
	if (policy.allowed.length === 0) return `${day}, each waiting for approval.`;
	const named = policy.allowed.slice(0, 2).join(", ");
	const others = policy.allowed.length - 2;
	return `${day}. To ${others > 0 ? `${named} and ${others} more` : named} it goes on its own; anything else waits for approval.`;
}

/** The addresses and domains typed into the dialog, one a line or apart by commas. */
export const typedAllowed = (typed: string) =>
	[...new Set(typed.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()))].filter(Boolean);
