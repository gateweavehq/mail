import { z } from "zod";
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

/** Why a call to Resend's API didn't give what was asked: Mail's code, and whether to try later. */
export interface ResendCallFailure {
	/** Such as `resend:restricted_api_key`, or `resend:unreachable` when nothing came back. */
	code: string;
	/** Whether trying again later may work: Resend failed or was busy, or wasn't reached. */
	later: boolean;
}

function callFailure(status: number, body: unknown): ResendCallFailure {
	const name = body && typeof body === "object" ? (body as { name?: unknown }).name : null;
	const known = typeof name === "string" && /^[a-z_]{1,64}$/.test(name);
	const code = `${RESEND_CODE}${known ? name : status}`;
	return { code, later: status >= 500 || status === 429 };
}

const unreached = (): ResendCallFailure => ({ code: `${RESEND_CODE}unreachable`, later: true });

type Called<T> = { ok: true; value: T } | { ok: false; failure: ResendCallFailure };

/** One call to Resend's API, whose answer, when it is a success, `parse` reads. Never throws. */
async function call<T>(
	api: string,
	key: string,
	path: string,
	init: { method?: string; body?: unknown },
	parse: (body: unknown) => T | null,
): Promise<Called<T>> {
	let response: Response;
	try {
		response = await fetch(`${api}${path}`, {
			method: init.method ?? "GET",
			headers: {
				...headers(key),
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		return { ok: false, failure: unreached() };
	}
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) return { ok: false, failure: callFailure(response.status, body) };
	const value = parse(body);
	// A success Mail can't read is Resend's trouble, which may pass.
	return value === null ? { ok: false, failure: callFailure(502, null) } : { ok: true, value };
}

const MadeWebhook = z.object({ id: z.string().min(1).max(200), signing_secret: z.string().min(1) });

/** The event Resend sends when it received mail, and the only one Mail asks for. */
export const RECEIVED_EVENT = "email.received";

/**
 * Makes a webhook in the key's Resend account that tells `endpoint` of each mail Resend receives.
 * The answer holds the webhook's id and the secret that signs its deliveries, which Resend shows
 * only now. Needs a key with full access.
 */
export function createReceivingWebhook(api: string, key: string, endpoint: string) {
	return call(
		api,
		key,
		"/webhooks",
		{ method: "POST", body: { endpoint, events: [RECEIVED_EVENT] } },
		(body) => {
			const made = MadeWebhook.safeParse(body);
			return made.success ? { id: made.data.id, secret: made.data.signing_secret } : null;
		},
	);
}

/** Whether the key's Resend account still has this webhook. */
export async function webhookExists(
	api: string,
	key: string,
	id: string,
): Promise<Called<boolean>> {
	const found = await call(api, key, `/webhooks/${encodeURIComponent(id)}`, {}, () => true);
	if (!found.ok && found.failure.code === `${RESEND_CODE}not_found`)
		return { ok: true, value: false };
	return found;
}

/** Removes a webhook Mail made. One that is already gone counts as removed. */
export async function deleteWebhook(api: string, key: string, id: string) {
	const done = await call(
		api,
		key,
		`/webhooks/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		() => true,
	);
	if (!done.ok && done.failure.code === `${RESEND_CODE}not_found`) return { ok: true } as const;
	return done;
}

const Addresses = z
	.array(z.string().max(1_000))
	.max(1_000)
	.nullish()
	.transform((list) => list ?? []);

const Verdict = z.enum(["pass", "fail", "gray", "processing_failed", "unknown"]).catch("unknown");

const ReceivedEmail = z.object({
	id: z.string().min(1).max(200),
	from: z.string().max(1_000).nullish(),
	to: Addresses,
	cc: Addresses,
	bcc: Addresses,
	received_for: Addresses,
	authentication: z
		.object({ spf: Verdict.optional(), dkim: Verdict.optional(), dmarc: Verdict.optional() })
		.nullish(),
	raw: z.object({ download_url: z.url({ protocol: /^https$/ }).max(8_000) }).nullish(),
});

/** What Mail reads of a received email: who it was for, Resend's checks, and where its raw mail is. */
export interface ReceivedEmail {
	id: string;
	/** The envelope's or From's bare address, as Resend gives it. */
	from: string | null;
	/** Every address Resend says it was for, as it gives them: To, Cc, Bcc and `received_for`. */
	recipients: string[];
	/**
	 * Resend's DMARC result, computed by its MX when the mail came: `pass`, `fail`, `gray` (no
	 * policy, or `p=none`), `processing_failed` or `unknown`. Null for mail from before Resend kept it.
	 */
	dmarc: string | null;
	/** A signed address the raw mail can be downloaded from for about an hour, or null. */
	rawUrl: string | null;
}

/** One email Resend received, by its id. Needs a key with full access. */
export function getReceivedEmail(api: string, key: string, id: string) {
	return call(
		api,
		key,
		`/emails/receiving/${encodeURIComponent(id)}`,
		{},
		(body): ReceivedEmail | null => {
			const read = ReceivedEmail.safeParse(body);
			if (!read.success) return null;
			const email = read.data;
			return {
				id: email.id,
				from: email.from ?? null,
				recipients: [...email.to, ...email.cc, ...email.bcc, ...email.received_for],
				dmarc: email.authentication ? (email.authentication.dmarc ?? "unknown") : null,
				rawUrl: email.raw?.download_url ?? null,
			};
		},
	);
}
