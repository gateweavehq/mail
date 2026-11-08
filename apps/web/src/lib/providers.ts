/**
 * How a domain's mail is sent: through Cloudflare Email Service's binding, which needs the domain
 * onboarded on this deployment's Cloudflare account, or through Resend with the workspace's own key,
 * for a domain that isn't.
 */
export const SENDS_WITH = ["cloudflare", "resend"] as const;

export type SendsWith = (typeof SENDS_WITH)[number];

/** Providers a workspace keeps a key for. */
export const KEYED_PROVIDERS = ["resend"] as const;

export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

/** What a page may know of a workspace's key: never the key itself. */
export interface ProviderKeyInfo {
	provider: KeyedProvider;
	/** The key's last four characters, to tell keys apart. */
	hint: string;
	/** Who added it, by name, while they still have an account. */
	addedBy: string | null;
	addedAt: number;
}

/**
 * What Resend lets a key do, as its answer to listing domains says: everything, or only sending,
 * which is all Mail needs.
 */
export type ResendAccess = "full" | "sending";

/** The prefix of Mail's codes for Resend's answers, as `resend:validation_error`. */
export const RESEND_CODE = "resend:";

/** Why a message to go through Resend isn't sent, in words, from Mail's code and Resend's message. */
export function resendReason(code: string, detail: string | null): string {
	const name = code.slice(RESEND_CODE.length);
	const said = detail ? ` Resend said: “${detail}”` : "";
	switch (name) {
		case "no_key":
			return "Its domain sends through Resend, and this workspace has no Resend key. An admin can add one in Settings, under Domains.";
		case "key_unreadable":
			return "This workspace's Resend key can't be read on this server any more. An admin can add it again in Settings, under Domains.";
		case "rate_limit_exceeded":
		case "daily_quota_exceeded":
			return "Resend stayed busy or over its daily quota, so it wasn't sent.";
		case "monthly_quota_exceeded":
			return "The Resend account has used its monthly quota.";
		case "validation_error":
		case "missing_api_key":
		case "restricted_api_key":
		case "suspended_api_key":
			return `Resend refused it.${said}`;
		case "unreachable":
			return "Resend couldn't be reached, so nobody knows whether it went.";
		default:
			return `Resend refused it (${name}).${said}`;
	}
}
