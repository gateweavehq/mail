import { RESEND_CODE, type ResendAccess } from "../../lib/providers";

/**
 * Sending through Resend's API with a workspace's own key, for a domain that isn't on this
 * deployment's Cloudflare account. Each message goes with an `Idempotency-Key`, which Resend keeps
 * for 24 hours: a repeat with the same key and body gets the first answer instead of a second
 * message. So unlike Email Service's binding, a try that may have gone can safely be tried again.
 */

export const RESEND_API = "https://api.resend.com";

/** Resend refuses a request without a User-Agent. */
const USER_AGENT = "Gateweave-Mail";

/** How long a request to Resend may take before it counts as lost. */
const TIMEOUT_MS = 20_000;

/** The most of Resend's own words about a refusal that Mail keeps. */
const MAX_DETAIL = 300;

/**
 * Why Resend didn't send a message, and what that means for trying again:
 * - `busy`: it was too busy, and nothing went. Try later.
 * - `daily`: the account's daily quota is used up, and nothing went. Try in hours.
 * - `unsure`: it may have gone, as when Resend failed or the answer was lost. Trying again with
 *   the same key is safe, and finds out.
 * - `refused`: trying again as it is won't help.
 */
export interface ResendFailure {
	kind: "busy" | "daily" | "unsure" | "refused";
	/** Mail's code, such as `resend:validation_error`. */
	code: string;
	/** Resend's own words, when it gave some. */
	detail: string | null;
	/**
	 * Whether Resend read the request and turned it down, so nothing went under its key and a
	 * later try needs a new one: Resend would only give it the same refusal again.
	 */
	answered: boolean;
}

export type ResendAnswer = { ok: true; id: string | null } | { ok: false; failure: ResendFailure };

/** What `send()` of Cloudflare's binding is given, which is what Mail keeps for each message. */
type Request = EmailMessageBuilder;

/** An address as a header has it: the name quoted when it needs to be. */
function mailbox(address: string | EmailAddress): string {
	if (typeof address === "string") return address;
	const name = address.name.trim();
	if (!name) return address.email;
	const plain = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(name);
	return plain
		? `${name} <${address.email}>`
		: `"${name.replace(/[\\"]/g, "\\$&")}" <${address.email}>`;
}

type Addresses = string | EmailAddress | (string | EmailAddress)[] | undefined;

const list = (value: Addresses) =>
	value === undefined ? undefined : (Array.isArray(value) ? value : [value]).map(mailbox);

/** The body of Resend's `POST /emails` for a message as Cloudflare's binding would be given it. */
export function resendBody(request: Request) {
	return {
		from: mailbox(request.from),
		...(request.to === undefined ? {} : { to: list(request.to) }),
		...(request.cc === undefined ? {} : { cc: list(request.cc) }),
		...(request.bcc === undefined ? {} : { bcc: list(request.bcc) }),
		...(request.replyTo === undefined ? {} : { reply_to: list(request.replyTo) }),
		subject: request.subject,
		...(request.text === undefined ? {} : { text: request.text }),
		...(request.html === undefined ? {} : { html: request.html }),
		...(request.headers ? { headers: request.headers } : {}),
	};
}

/** What one of Resend's error answers means. */
export function failureOf(status: number, body: unknown): ResendFailure {
	const said = (key: string) => {
		const value = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : null;
		return typeof value === "string" && value.trim() ? value.trim() : null;
	};
	const name = said("name");
	const message = said("message");
	const failure = (kind: ResendFailure["kind"], answered = false): ResendFailure => ({
		kind,
		code: `${RESEND_CODE}${name && /^[a-z_]{1,64}$/.test(name) ? name : status}`,
		detail: message ? message.slice(0, MAX_DETAIL) : null,
		answered,
	});
	if (status === 429) {
		if (name === "daily_quota_exceeded") return failure("daily");
		if (name === "monthly_quota_exceeded") return failure("refused");
		return failure("busy");
	}
	// The first request with this key is still going, and may yet send it.
	if (status === 409 && name === "concurrent_idempotent_requests") return failure("unsure");
	if (status === 409 && name === "resource_locked") return failure("busy");
	if (status >= 500) return failure("unsure");
	if (status >= 400) return failure("refused", true);
	// Anything else isn't an answer Resend gives, so nobody knows what happened.
	return failure("unsure");
}

const lost = (): ResendFailure => ({
	kind: "unsure",
	code: `${RESEND_CODE}unreachable`,
	detail: null,
	answered: false,
});

const headers = (key: string) => ({
	authorization: `Bearer ${key}`,
	"user-agent": USER_AGENT,
});

/** Sends one message through Resend. Never throws: a request that fails is an answer too. */
export async function sendWithResend({
	api,
	key,
	request,
	idempotencyKey,
}: {
	api: string;
	key: string;
	request: Request;
	idempotencyKey: string;
}): Promise<ResendAnswer> {
	let response: Response;
	try {
		response = await fetch(`${api}/emails`, {
			method: "POST",
			headers: {
				...headers(key),
				"content-type": "application/json",
				"idempotency-key": idempotencyKey,
			},
			body: JSON.stringify(resendBody(request)),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		return { ok: false, failure: lost() };
	}
	const body: unknown = await response.json().catch(() => null);
	if (response.ok) {
		const id = body && typeof body === "object" ? (body as { id?: unknown }).id : null;
		return { ok: true, id: typeof id === "string" ? id : null };
	}
	return { ok: false, failure: failureOf(response.status, body) };
}

export type KeyCheck = { ok: true; access: ResendAccess } | { ok: false; error: string };

/**
 * Whether Resend takes a key, asked by listing the account's domains. A key with full access
 * may; a sending-only key is turned away with `restricted_api_key`, which says it is real.
 */
export async function checkResendKey(api: string, key: string): Promise<KeyCheck> {
	let response: Response;
	try {
		response = await fetch(`${api}/domains`, {
			headers: headers(key),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		return { ok: false, error: "Resend couldn't be reached to check the key. Try again soon." };
	}
	if (response.ok) return { ok: true, access: "full" };
	const body: unknown = await response.json().catch(() => null);
	const name = body && typeof body === "object" ? (body as { name?: unknown }).name : null;
	// 403 with the same name means a key that isn't active.
	if (response.status === 401 && name === "restricted_api_key") {
		return { ok: true, access: "sending" };
	}
	if (response.status >= 500 || response.status === 429) {
		return { ok: false, error: "Resend couldn't check the key just now. Try again soon." };
	}
	return { ok: false, error: "Resend doesn't take this key. Check that it is whole and active." };
}
