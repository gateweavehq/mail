// Optional configuration. Required secrets are declared under `secrets.required` in
// wrangler.jsonc, which is what `wrangler types` generates the rest of `Cloudflare.Env` from.
declare namespace Cloudflare {
	interface Env {
		/** Public URL of the app. Inferred from the request when unset. */
		BETTER_AUTH_URL?: string;
		GITHUB_CLIENT_ID?: string;
		GITHUB_CLIENT_SECRET?: string;
		/**
		 * An OpenID Connect provider to sign in through: its issuer URL and this deployment's client
		 * id and secret there. Needs all three. See docs/self-hosting.md.
		 */
		OIDC_ISSUER?: string;
		OIDC_CLIENT_ID?: string;
		OIDC_CLIENT_SECRET?: string;
		/** What the sign-in button calls it, as in "Continue with Gateweave". */
		OIDC_PROVIDER_NAME?: string;
		/**
		 * Who email comes from, such as `Gateweave Mail <mail@example.com>`. The domain must be
		 * onboarded to Cloudflare Email Sending. Email is off when unset.
		 */
		EMAIL_FROM?: string;
		/**
		 * The DNS-over-HTTPS resolver that checks a domain's records, answering in JSON. Cloudflare's
		 * when unset. The browser tests point it at a stand-in.
		 */
		DNS_RESOLVER_URL?: string;
		/**
		 * How many bytes one mailbox may hold, as a whole number. 1 GiB when unset. A mailbox that is
		 * full tells senders to try again later.
		 */
		MAILBOX_BYTES?: string;
		/**
		 * How many messages one workspace may send a day, as a whole number. 200 when unset. The
		 * allowance comes back over the day.
		 */
		SEND_PER_DAY?: string;
		/**
		 * At least 32 random bytes, base64 (`openssl rand -base64 32`). Seals the keys workspaces keep
		 * here, such as a Resend key, which can't be added without it, and raw mail in R2. To change
		 * it, keep the old one as `SECRETS_KEY_PREVIOUS` until what it sealed is sealed again.
		 */
		SECRETS_KEY?: string;
		/**
		 * The `SECRETS_KEY` before the current one. It only opens what is still sealed under it, which
		 * the daily run and the mailboxes' alarms seal again under the current key. It can go once
		 * the daily run's `secrets:` and `raw mail:` lines both say none is left.
		 */
		SECRETS_KEY_PREVIOUS?: string;
		/** Resend's API. `https://api.resend.com` when unset. The browser tests point it at a stand-in. */
		RESEND_API_URL?: string;
		/**
		 * The account whose Email Service sends this deployment's mail, and an API token for it with
		 * Email Sending: Edit. With both, removing an address from a workspace's list also takes it
		 * off Email Service's own, for that workspace's domains. Without them it stays there.
		 */
		EMAIL_SENDING_ACCOUNT_ID?: string;
		EMAIL_SENDING_API_TOKEN?: string;
		/**
		 * The addresses of this deployment's legal pages, linked from the sign-in pages and the
		 * workspace menu. Each is left out when unset, or when it is not an http(s) address.
		 */
		LEGAL_NOTICE_URL?: string;
		PRIVACY_POLICY_URL?: string;
		TERMS_URL?: string;
	}
}
