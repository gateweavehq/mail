import { env } from "cloudflare:workers";

/**
 * Where someone can ask whoever runs the server for an account, from `SIGN_UP_REQUEST_URL`. Only
 * an https address counts: the sign-in page links to it, and anything else is left out rather
 * than linked.
 */
export function signUpRequestUrl(): string | null {
	const value = env.SIGN_UP_REQUEST_URL?.trim();
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}
