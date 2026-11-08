import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { db } from "./server/auth";
import { pruneExpired } from "./server/db/prune";
import { findAddress } from "./server/directory";
import { receiveMail } from "./server/inbound";
import { finishRemovals, storeMail } from "./server/mailbox";
import { newNonce, withSecurityHeaders } from "./server/security-headers";

export { Mailbox } from "./server/mailbox";
export { RateLimiter } from "./server/rate-limit";

/**
 * A branch's Preview gets none of the Worker's bindings or secrets, and accounts can't be run safely
 * without the database and the secret. So such a deployment serves nothing else.
 */
function notSetUp() {
	return new Response(
		"This deployment has no database or no BETTER_AUTH_SECRET, so it serves nothing. A Preview of a branch gets neither by itself: see Preview builds in docs/self-hosting.md.\n",
		{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
	);
}

function route(request: Request, nonce: string): Response | Promise<Response> {
	if (!env.DB || !env.BETTER_AUTH_SECRET) return notSetUp();
	return handler.fetch(request, { context: { nonce } });
}

export default {
	async fetch(request) {
		const nonce = newNonce();
		const response = await route(request, nonce);
		// Vite's dev server adds inline scripts of its own for hot reload, which have no nonce.
		if (import.meta.env.DEV) return response;
		return withSecurityHeaders(request, response, { nonce, oidcIssuer: env.OIDC_ISSUER });
	},
	// With no database this throws, and the sender tries again later: not knowing an address is our
	// trouble, not a refusal.
	async email(message) {
		await receiveMail(
			message,
			(recipient) => findAddress(db, recipient, new Date()),
			(found) => storeMail(found, message),
		);
	},
	// Clears what is past its time, once a day, and finishes the removal of mailboxes' mail.
	async scheduled() {
		await pruneExpired(db);
		await finishRemovals(db);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
