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

/** Mail's code for tries stopped because the workspace's Resend key changed after one may have gone. */
export const KEY_CHANGED = `${RESEND_CODE}key_changed`;

/** Resend's answers, and Mail's, that leave it unknown whether a message went. */
const MAYBE_WENT = new Set([
	"unreachable",
	"application_error",
	"internal_server_error",
	"service_unavailable",
	"concurrent_idempotent_requests",
]);

/** Whether a try that ended with this code may have sent the message. */
export function resendMaybeWent(code: string): boolean {
	const name = code.slice(RESEND_CODE.length);
	return MAYBE_WENT.has(name) || /^5\d\d$/.test(name);
}

/** Why a message to go through Resend isn't sent, in words, from Mail's code and Resend's message. */
export function resendReason(code: string, detail: string | null): string {
	const name = code.slice(RESEND_CODE.length);
	const said = detail ? ` Resend said: “${detail}”` : "";
	switch (name) {
		case "no_key":
			return "Its domain sends through Resend, and this workspace has no Resend key. An admin can add one in Settings, under Domains.";
		case "key_unreadable":
			return "This workspace's Resend key can't be read on this server any more. An admin can add it again in Settings, under Domains.";
		case "key_unavailable":
			return "The workspace's Resend key couldn't be read when Mail last tried.";
		case "rate_limit_exceeded":
		case "daily_quota_exceeded":
			return "Resend stayed busy or over its daily quota until Mail's tries ran out.";
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
