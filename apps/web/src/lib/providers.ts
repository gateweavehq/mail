/**
 * How a domain's mail is sent: through Cloudflare Email Service's binding, which needs the domain
 * onboarded on this deployment's Cloudflare account, or through Resend with the workspace's own key,
 * for a domain that isn't.
 */
export const SENDS_WITH = ["cloudflare", "resend"] as const;

export type SendsWith = (typeof SENDS_WITH)[number];

/**
 * How a domain's mail reaches Mail: through Cloudflare Email Routing to the Worker's `email()`, or
 * through Resend, whose MX takes it and whose webhook says it came. Resend needs the workspace's key
 * with full access, since a sending-only key can't read received mail.
 */
export const RECEIVES_WITH = ["cloudflare", "resend"] as const;

export type ReceivesWith = (typeof RECEIVES_WITH)[number];

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

/**
 * Why mail that came through Resend wasn't stored, in words, from Mail's code. Resend keeps trying
 * for about a day after each failure that is Mail's or the key's, so mending it in time loses nothing.
 */
export function receivingTrouble(code: string): string {
	const name = code.startsWith(RESEND_CODE) ? code.slice(RESEND_CODE.length) : code;
	switch (name) {
		case "no_key":
			return "The workspace has no Resend key, so mail Resend received couldn't be fetched. Add a key with full access; Resend tries again for about a day.";
		case "key_unreadable":
			return "The workspace's Resend key can't be read on this server any more, so mail Resend received couldn't be fetched. Add it again.";
		case "restricted_api_key":
			return "The workspace's Resend key can only send, so mail Resend received couldn't be fetched. Add a key with full access; Resend tries again for about a day.";
		case "missing_api_key":
		case "invalid_api_key":
		case "401":
		case "403":
			return "Resend didn't take the workspace's key, so mail Resend received couldn't be fetched. Add a working key with full access; Resend tries again for about a day.";
		case "unreadable":
			return "Resend's answer about a message it received couldn't be read, so it wasn't stored. It is still in Resend.";
		case "not_found":
			return "Resend said the account behind the workspace's key doesn't have a message its webhook named, as when the key is from another Resend account.";
		case "too_large":
			return "A message Resend received was larger than Mail takes, so it wasn't stored. It is still in Resend.";
		case "mailbox_full":
			return "A mailbox was full, so a message Resend received wasn't stored yet. Resend tries again for about a day.";
		case "raw_unavailable":
			return "The message couldn't be downloaded from Resend. Resend tries again for about a day.";
		case "store_failed":
			return "Storing a message Resend received failed. Resend tries again for about a day.";
		case "unreachable":
			return "Resend couldn't be reached to fetch a message it received. Resend tries again for about a day.";
		default:
			return `Resend didn't give Mail a message it received (${name}).`;
	}
}
