import { z } from "zod";
import { parseDomainName, parseLocalPart } from "./addresses";

/** What addresses an agent may make for itself. Owners and admins set it on Settings → Agents. */
export interface AgentAddressPolicy {
	/** How many live addresses it may hold at once, and make in a day. Zero stops it making any. */
	maxLive: number;
	/** The longest any of them may last, in days. Every address an agent makes ends. */
	maxDays: number;
	/** The proved domains it may make them on, by name, lower case. */
	domains: string[];
}

/** An agent's address policy until someone sets one: it makes none. */
export const DEFAULT_AGENT_ADDRESS_POLICY: AgentAddressPolicy = {
	maxLive: 0,
	maxDays: 7,
	domains: [],
};

/** The most live addresses one agent may be let hold. */
export const MAX_AGENT_LIVE_ADDRESSES = 500;

/** The longest an agent's address may be let last, as for any temporary address. */
export const MAX_AGENT_ADDRESS_DAYS = 365;

/** The most domains one agent may be given, as many as a workspace may have. */
export const MAX_AGENT_ADDRESS_DOMAINS = 20;

/** How long a local part Mail picks for an agent is. 36¹² is about 5 × 10¹⁸. */
export const RANDOM_LOCAL_PART_LENGTH = 12;

/**
 * Names an agent may not choose. Mail sent to them can prove who controls a domain: a certificate
 * authority writes to the first five to check a domain before it issues a certificate for it
 * (CA/Browser Forum Baseline Requirements, 3.2.2.4.4). The rest are where a domain's reports and
 * complaints go (RFC 2142), or a mail system's own. An admin can still add any of them by hand.
 */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
	"admin",
	"administrator",
	"webmaster",
	"hostmaster",
	"postmaster",
	"abuse",
	"security",
	"noc",
	"info",
	"marketing",
	"sales",
	"support",
	"usenet",
	"news",
	"www",
	"uucp",
	"ftp",
	"root",
	"mailer-daemon",
	"ssladmin",
	"ssl-admin",
	"ssladministrator",
	"sslwebmaster",
	"sysadmin",
]);

/** A domain, as an admin picks it for an agent: its name, lower case. */
const DomainName = z
	.string()
	.max(300)
	.transform((name, context) => {
		const parsed = parseDomainName(name);
		if (!parsed) context.addIssue({ code: "custom", message: "That isn't a domain name." });
		return parsed ?? z.NEVER;
	});

export const AgentAddressPolicyInput = z.object({
	maxLive: z.number().int().min(0).max(MAX_AGENT_LIVE_ADDRESSES),
	maxDays: z.number().int().min(1).max(MAX_AGENT_ADDRESS_DAYS),
	domains: z.array(DomainName).max(MAX_AGENT_ADDRESS_DOMAINS),
});

/**
 * A local part an agent chose, as stored, or why it can't have it. Reserved names are refused
 * however they are written, so `Admin` and ` admin ` are `admin` too.
 */
export function agentLocalPart(
	input: string,
): { ok: true; localPart: string } | { ok: false; error: string } {
	const localPart = parseLocalPart(input);
	if (!localPart) {
		return {
			ok: false,
			error:
				"An address can have letters, digits, dots, hyphens and underscores, and starts and ends with a letter or digit.",
		};
	}
	if (RESERVED_LOCAL_PARTS.has(localPart)) {
		return { ok: false, error: `An agent can't take ${localPart}@: ask an admin to add it.` };
	}
	return { ok: true, localPart };
}

/** A local part Mail picks for an agent: lower-case letters and digits, never a reserved name. */
export function randomLocalPart(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	// 252 is the largest multiple of 36 under 256, so every character is as likely as the others.
	let part = "";
	while (part.length < RANDOM_LOCAL_PART_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(RANDOM_LOCAL_PART_LENGTH))) {
			if (byte < 252 && part.length < RANDOM_LOCAL_PART_LENGTH) part += alphabet[byte % 36];
		}
	}
	return part;
}

/** A stored policy's `domains`, which is JSON, read back; anything not a list of strings is none. */
export function readDomains(stored: string): string[] {
	try {
		const parsed: unknown = JSON.parse(stored);
		return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

/** What an agent may make, in a sentence. */
export function addressPolicySummary(policy: AgentAddressPolicy): string {
	if (policy.maxLive === 0 || policy.domains.length === 0) return "Can't make addresses.";
	const count = `${policy.maxLive} ${policy.maxLive === 1 ? "address" : "addresses"}`;
	const days = `${policy.maxDays} ${policy.maxDays === 1 ? "day" : "days"}`;
	const named = policy.domains.slice(0, 2).join(", ");
	const others = policy.domains.length - 2;
	const on = others > 0 ? `${named} and ${others} more` : named;
	return `Makes up to ${count} at once on ${on}, each lasting up to ${days}.`;
}
