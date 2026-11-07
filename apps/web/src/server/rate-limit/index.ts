import { env } from "cloudflare:workers";
import type { BetterAuthRateLimitOptions } from "better-auth";
import { DEFAULT_AUTH_LIMIT } from "../auth/config";
import type { Mailer } from "../email/mailer";
import { type Decision, LocalLimiter, type Rule } from "./gcra";

export { RateLimiter } from "./durable-object";

/**
 * Each auth rule also gets an hourly allowance of this many times its burst, so a client cannot
 * keep going by pacing itself to the short window: sign-in attempts are held to 60 an hour
 * instead of 3 every 10 seconds, which would be 1,080.
 */
export const HOURLY_MULTIPLE = 20;

/**
 * Emails one address can be sent, whatever they are: 5 at once, refilling over an hour, within
 * 10 that refill over a day.
 */
export const EMAILS_PER_RECIPIENT: Rule[] = [
	{ window: 60 * 60, max: 5 },
	{ window: 24 * 60 * 60, max: 10 },
];

/**
 * Passwords one person's sessions can offer, from however many addresses: 10 at once, refilling over
 * an hour, within 30 that refill over a day. Someone who has forgotten theirs will have gone for a
 * reset long before this.
 */
export const PASSWORD_TRIES_PER_PERSON: Rule[] = [
	{ window: 60 * 60, max: 10 },
	{ window: 24 * 60 * 60, max: 30 },
];

/** Whether someone signed in as this person may offer another password, wherever from. */
export async function allowPasswordTry(userId: string): Promise<boolean> {
	const { allowed } = await consumeDurably(`password-try:${userId}`, PASSWORD_TRIES_PER_PERSON);
	return allowed;
}

/** Emails one person gets about those tries running out: one a day, since each says the same. */
export const SPENT_TRIES_EMAILS_PER_PERSON: Rule[] = [{ window: 24 * 60 * 60, max: 1 }];

/** Whether this person may be emailed about those tries running out. Counts this one if so. */
export async function allowSpentTriesEmail(userId: string): Promise<boolean> {
	const { allowed } = await consumeDurably(
		`password-tries-told:${userId}`,
		SPENT_TRIES_EMAILS_PER_PERSON,
	);
	return allowed;
}

const local = new LocalLimiter();

/**
 * Better Auth's rate limit storage. Better Auth counts per client address and path. Paths with
 * a rule of their own (sign-in, sign-up, password reset, invitations, OAuth) are counted in a
 * Durable Object, so their limits hold across every isolate and location; in memory, each
 * isolate would give an attacker a fresh allowance. Everything else, mostly session checks,
 * keeps the default limit in this isolate, which costs nothing per request.
 */
export const authRateLimits: NonNullable<BetterAuthRateLimitOptions["customStorage"]> = {
	async consume(key, rule) {
		if (rule.window === DEFAULT_AUTH_LIMIT.window && rule.max === DEFAULT_AUTH_LIMIT.max) {
			return local.consume(key, [rule], Date.now());
		}
		return consumeDurably(`auth:${key}`, [
			rule,
			{ window: 60 * 60, max: rule.max * HOURLY_MULTIPLE },
		]);
	},
};

/**
 * Caps how many emails any one address gets, however many clients ask for them. Over the cap,
 * an email is dropped without telling the requester, as a reset for an unknown address is.
 */
export function limitRecipients(mailer: Mailer | undefined): Mailer | undefined {
	if (!mailer) return undefined;
	return {
		async send(email) {
			const { allowed } = await consumeDurably(
				`email:${email.to.trim().toLowerCase()}`,
				EMAILS_PER_RECIPIENT,
			);
			if (!allowed) {
				console.warn("email: not sent, this address got too many emails recently");
				return;
			}
			await mailer.send(email);
		},
	};
}

async function consumeDurably(key: string, rules: Rule[]): Promise<Decision> {
	try {
		// Keys hold addresses, so they are hashed before they become Durable Object names, which
		// the dashboard can show.
		return await env.RATE_LIMITER.getByName(await sha256(key)).consume(rules);
	} catch (error) {
		// Counting in this isolate alone is weaker, but better than refusing everyone or no one.
		console.error("rate limit: Durable Object unavailable, counting in this isolate", error);
		return local.consume(key, rules, Date.now());
	}
}

async function sha256(text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
