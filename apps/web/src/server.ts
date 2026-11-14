import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { db } from "./server/auth";
import { pruneExpired } from "./server/db/prune";
import { directoryIn, receiveDeliveryEvents } from "./server/delivery-events";
import { findAddress } from "./server/directory";
import { receiveMail } from "./server/inbound";
import { finishRemovals, mailboxStub, resealMailboxes, storeMail } from "./server/mailbox";
import { resealSecrets } from "./server/reseal-secrets";
import { dropUnusedWebhooks } from "./server/resend-inbound";
import { newNonce, withSecurityHeaders } from "./server/security-headers";

export { Backup } from "./server/backup";
export { Mailbox } from "./server/mailbox";
export { RateLimiter } from "./server/rate-limit";
export { Webhooks } from "./server/webhooks";

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
	// Email Service's delivery events, from the queue each sending domain's subscription publishes to.
	// The log has counts, and what failed without addresses: the events name people's addresses.
	async queue(batch) {
		if (!env.DB) {
			batch.retryAll();
			return;
		}
		const handled = await receiveDeliveryEvents(batch, directoryIn(db), mailboxStub);
		(handled.failed ? console.error : console.log)(`delivery events: ${JSON.stringify(handled)}`);
	},
	// Clears what is past its time, once a day, finishes the removal of mailboxes' mail, and, after
	// SECRETS_KEY changed, seals workspaces' secrets again under it and wakes mailboxes to do the
	// same with their mail.
	async scheduled() {
		await pruneExpired(db);
		await finishRemovals(db);
		await dropUnusedWebhooks(db);
		const secrets = await resealSecrets(db, env);
		// Counts only. While either `left` isn't 0, SECRETS_KEY_PREVIOUS is still needed.
		if (secrets && (secrets.resealed > 0 || secrets.left > 0)) {
			(secrets.unopened > 0 ? console.error : console.log)(`secrets: ${JSON.stringify(secrets)}`);
		}
		const mail = await resealMailboxes(db, env);
		if (mail)
			(mail.unopened > 0 ? console.error : console.log)(`raw mail: ${JSON.stringify(mail)}`);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
