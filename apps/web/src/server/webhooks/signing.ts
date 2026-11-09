// Delivering a webhook as Standard Webhooks (https://www.standardwebhooks.com) has it, as Gateweave
// Track's webhooks are delivered.

/** How long a receiver has to answer. */
export const DELIVERY_TIMEOUT_MS = 10_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The waits before each retry: after the last, a delivery has failed. About a day in all. */
export const RETRY_DELAYS_MS = [5_000, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 5 * HOUR, 10 * HOUR];

/** How long finished deliveries are kept for the settings page to show. */
export const DELIVERY_RETENTION_MS = 7 * 24 * HOUR;

export const SECRET_PREFIX = "whsec_";

/** A new signing secret: 24 random bytes, as base64 after the prefix. */
export function newSecret(): string {
	return SECRET_PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(24)));
}

/** What a secret shows of itself, to tell secrets apart. */
export const secretStart = (secret: string) => secret.slice(0, SECRET_PREFIX.length + 4);

/** A Standard Webhooks signature: HMAC-SHA256 of `id.timestamp.body`, keyed by the secret. */
export async function sign(
	secret: string,
	id: string,
	timestamp: number,
	body: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		fromBase64(secret.slice(SECRET_PREFIX.length)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${id}.${timestamp}.${body}`),
	);
	return `v1,${toBase64(new Uint8Array(mac))}`;
}

export interface Attempt {
	/** The delivery's id, sent as `webhook-id`, the same on every retry. */
	id: string;
	url: string;
	secret: string;
	payload: string;
}

export type Outcome = { ok: boolean; responseStatus: number | null; error: string | null };

/** Posts one delivery, signed, and says how the receiver answered. Only a 2xx answer counts. */
export async function attempt(delivery: Attempt): Promise<Outcome> {
	const timestamp = Math.floor(Date.now() / 1000);
	try {
		const response = await fetch(delivery.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "Gateweave-Mail-Webhooks/1",
				"webhook-id": delivery.id,
				"webhook-timestamp": String(timestamp),
				"webhook-signature": await sign(delivery.secret, delivery.id, timestamp, delivery.payload),
			},
			body: delivery.payload,
			// A redirect could lead anywhere, so it counts as a failure.
			redirect: "manual",
			signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
		});
		await response.body?.cancel();
		return {
			ok: response.ok,
			responseStatus: response.status,
			error: response.ok ? null : `The receiver answered ${response.status}.`,
		};
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return {
			ok: false,
			responseStatus: null,
			error: timedOut
				? `No answer within ${DELIVERY_TIMEOUT_MS / 1000} seconds.`
				: `Couldn't reach the receiver: ${describe(error)}`,
		};
	}
}

/**
 * Where a webhook may point. Plain http only where the app itself runs on it, which is local
 * development. Never at the app's own host: a Worker can't fetch itself, and it is no receiver
 * anyway. Null when it may.
 */
export function urlRefusal(url: string, origin: string): string | null {
	const target = new URL(url);
	const app = new URL(origin);
	if (target.protocol !== "https:" && app.protocol === "https:") return "Use an https URL.";
	if (sameHost(target, app)) return "A webhook can't point at Mail itself.";
	if (target.username || target.password) {
		return "Leave the user name and password out of the URL.";
	}
	return null;
}

/** Whether two URLs name one host and port, as `mail.example.com.` and `mail.example.com` do. */
function sameHost(one: URL, other: URL): boolean {
	const host = (url: URL) => `${url.hostname.replace(/\.$/, "")}:${url.port}`;
	return host(one) === host(other);
}

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 200);
}
