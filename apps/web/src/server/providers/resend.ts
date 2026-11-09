import { z } from "zod";
import type { DeliveryState } from "../../lib/delivery";
import { RESEND_CODE, type ResendAccess } from "../../lib/providers";
import { readUpTo, textOf } from "../streams";

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

/**
 * The largest answer Mail reads from Resend's API. A received email's answer holds its text and
 * HTML, so a message of mostly text could make one large; the rest are small.
 */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/** Why a call to Resend's API didn't give what was asked: Mail's code, and whether to try later. */
export interface ResendCallFailure {
	/** Such as `resend:restricted_api_key`, or `resend:unreachable` when nothing came back. */
	code: string;
	/** Whether trying again later may work: Resend failed or was busy, or wasn't reached. */
	later: boolean;
	/** The answer's HTTP status, when one came. */
	status: number | null;
}

function callFailure(status: number, body: unknown): ResendCallFailure {
	const name = body && typeof body === "object" ? (body as { name?: unknown }).name : null;
	const known = typeof name === "string" && /^[a-z_]{1,64}$/.test(name);
	const code = `${RESEND_CODE}${known ? name : status}`;
	return { code, later: status >= 500 || status === 429, status };
}

const unreached = (): ResendCallFailure => ({
	code: `${RESEND_CODE}unreachable`,
	later: true,
	status: null,
});

/**
 * A success Mail can't read. One that isn't JSON at all came from something in the way, which may
 * pass; JSON of another shape would come again the same.
 */
const unreadable = (later: boolean): ResendCallFailure => ({
	code: `${RESEND_CODE}unreadable`,
	later,
	status: 200,
});
const tooLarge = (): ResendCallFailure => ({
	code: `${RESEND_CODE}too_large`,
	later: false,
	status: 200,
});

type Answer = { json: unknown } | "not_json" | "too_large";

/** An answer's JSON, read no further than `MAX_ANSWER_BYTES`. */
async function answerOf(response: Response): Promise<Answer> {
	if (Number(response.headers.get("content-length")) > MAX_ANSWER_BYTES) {
		await response.body?.cancel();
		return "too_large";
	}
	const read = await readUpTo(response.body, MAX_ANSWER_BYTES);
	if (!read) return "too_large";
	try {
		return { json: JSON.parse(textOf(read)) };
	} catch {
		return "not_json";
	}
}

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
	let answer: Answer;
	try {
		answer = await answerOf(response);
	} catch {
		return { ok: false, failure: unreached() };
	}
	const body = typeof answer === "object" ? answer.json : null;
	if (!response.ok) return { ok: false, failure: callFailure(response.status, body) };
	if (answer === "too_large") return { ok: false, failure: tooLarge() };
	if (answer === "not_json") return { ok: false, failure: unreadable(true) };
	const value = parse(body);
	return value === null ? { ok: false, failure: unreadable(false) } : { ok: true, value };
}

const MadeWebhook = z.object({ id: z.string().min(1).max(200), signing_secret: z.string().min(1) });

/** The event Resend sends when it received mail. */
export const RECEIVED_EVENT = "email.received";

/**
 * The events Resend sends about mail it sent, by what Mail records of each recipient. Resend sends
 * one for each recipient, Cc too, naming only that one (measured 2026-11-09).
 */
export const DELIVERY_EVENTS = {
	"email.delivered": "delivered",
	"email.delivery_delayed": "deferred",
	"email.bounced": "bounced",
	"email.complained": "complained",
	"email.failed": "failed",
	"email.suppressed": "rejected",
} as const satisfies Record<string, DeliveryState>;

export type DeliveryEventType = keyof typeof DELIVERY_EVENTS;

/** The event Resend sends when someone took an address off the account's suppression list. */
export const SUPPRESSION_REMOVED_EVENT = "suppression.removed";

/**
 * Every event the workspace's webhook asks for: received mail, what became of sent mail, and
 * removals from the account's suppression list.
 */
export const WEBHOOK_EVENTS: readonly string[] = [
	RECEIVED_EVENT,
	...Object.keys(DELIVERY_EVENTS),
	SUPPRESSION_REMOVED_EVENT,
];

/**
 * Makes a webhook in the key's Resend account that tells `endpoint` of each mail Resend receives,
 * and of what became of each it sent. The answer holds the webhook's id and the secret that signs
 * its deliveries, which Resend shows only now. Needs a key with full access.
 */
export function createWebhook(api: string, key: string, endpoint: string) {
	return call(
		api,
		key,
		"/webhooks",
		{ method: "POST", body: { endpoint, events: WEBHOOK_EVENTS } },
		(body) => {
			const made = MadeWebhook.safeParse(body);
			return made.success ? { id: made.data.id, secret: made.data.signing_secret } : null;
		},
	);
}

const WebhookState = z.object({
	status: z.string().max(100).nullish(),
	endpoint: z.string().max(2_000).nullish(),
	events: z.array(z.string().max(100)).max(100).nullish().catch(null),
});

/**
 * What Resend has of a webhook: whether it is on, where it sends, and whether it asks for every
 * event Mail needs, as one made before Mail recorded deliveries doesn't; or that it is gone.
 */
export type WebhookState = { on: boolean; endpoint: string | null; allEvents: boolean } | "gone";

/**
 * What the key's Resend account has of this webhook. Resend turns off one whose deliveries keep
 * failing.
 */
export async function webhookState(
	api: string,
	key: string,
	id: string,
): Promise<Called<WebhookState>> {
	const found = await call(
		api,
		key,
		`/webhooks/${encodeURIComponent(id)}`,
		{},
		(body): WebhookState | null => {
			const read = WebhookState.safeParse(body);
			if (!read.success) return null;
			const events = new Set(read.data.events ?? []);
			return {
				on: read.data.status !== "disabled",
				endpoint: read.data.endpoint ?? null,
				allEvents: WEBHOOK_EVENTS.every((event) => events.has(event)),
			};
		},
	);
	if (!found.ok && found.failure.code === `${RESEND_CODE}not_found`)
		return { ok: true, value: "gone" };
	return found;
}

/**
 * Points a webhook at `endpoint`, asks it for every event Mail needs, and turns it on, as Resend may
 * have turned it off.
 */
export function repairWebhook(api: string, key: string, id: string, endpoint: string) {
	return call(
		api,
		key,
		`/webhooks/${encodeURIComponent(id)}`,
		{ method: "PATCH", body: { endpoint, events: WEBHOOK_EVENTS, status: "enabled" } },
		() => true,
	);
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

/** What became of taking an address off the Resend account's list. */
export type ResendUnlisting = "removed" | "notListed" | "sendingOnly" | "failed";

/**
 * Takes an address off the key's Resend account's suppression list, which holds for every domain of
 * that account. Measured 2026-11-09: 200 when it was there, 404 `not_found` when it wasn't, and 401
 * `restricted_api_key` for a key that can only send, whether or not it was there.
 */
export async function removeResendSuppression(
	api: string,
	key: string,
	address: string,
): Promise<ResendUnlisting> {
	const done = await call(
		api,
		key,
		`/suppressions/${encodeURIComponent(address)}`,
		{ method: "DELETE" },
		() => true,
	);
	if (done.ok) return "removed";
	if (done.failure.code === `${RESEND_CODE}not_found`) return "notListed";
	if (done.failure.code === `${RESEND_CODE}restricted_api_key`) return "sendingOnly";
	return "failed";
}

/** A list of addresses, keeping only what can be one: an odd entry doesn't lose the others. */
const Addresses = z
	.array(z.unknown())
	.nullish()
	.transform((list) =>
		(list ?? []).filter((one): one is string => typeof one === "string" && one.length <= 1_000),
	);

const Verdict = z.enum(["pass", "fail", "gray", "processing_failed", "unknown"]).catch("unknown");

const ReceivedEmail = z.object({
	id: z.string().min(1).max(200),
	from: z.string().max(1_000).nullish().catch(null),
	to: Addresses,
	authentication: z
		.object({ spf: Verdict.optional(), dkim: Verdict.optional(), dmarc: Verdict.optional() })
		.nullish()
		.catch(null),
	raw: z
		.object({ download_url: z.url({ protocol: /^https$/ }).max(8_000) })
		.nullish()
		.catch(null),
});

/** What Mail reads of a received email: who it was for, Resend's checks, and where its raw mail is. */
export interface ReceivedEmail {
	id: string;
	/** The From header's bare address, as Resend read it. */
	from: string | null;
	/**
	 * Whom it was delivered to: its envelope's recipient. Resend keeps one email for each, and
	 * names that one in `to`, which isn't the To header (measured, MAIL-9). Its `cc` is the Cc
	 * header and `received_for` is read from `Received` headers, which the sender writes, so
	 * Mail takes neither.
	 */
	recipients: string[];
	/**
	 * Resend's DMARC result, computed by its MX when the mail came: `pass`, `fail`, `gray` (no
	 * policy, or `p=none`), `processing_failed` or `unknown`. Null for mail from before Resend kept it.
	 */
	dmarc: string | null;
	/** A signed address the raw mail can be downloaded from for about an hour, or null. */
	rawUrl: string | null;
}

const SentEmail = z.object({ from: z.string().max(1_000) });

/**
 * Who an email Resend sent was from, by its id, as its `from` says. Needs a key with full access.
 * The key's account may send for others too, so this tells whose an event about it is.
 */
export function getSentEmailSender(api: string, key: string, id: string) {
	return call(api, key, `/emails/${encodeURIComponent(id)}`, {}, (body) => {
		const read = SentEmail.safeParse(body);
		return read.success ? read.data.from : null;
	});
}

/** One email Resend received, by its id. Needs a key with full access. */
export function getReceivedEmail(api: string, key: string, id: string) {
	return call(
		api,
		key,
		// Inline images stay attachments, which keeps the answer the size of the text.
		`/emails/receiving/${encodeURIComponent(id)}?html_format=cid`,
		{},
		(body): ReceivedEmail | null => {
			const read = ReceivedEmail.safeParse(body);
			if (!read.success) return null;
			const email = read.data;
			return {
				id: email.id,
				from: email.from ?? null,
				recipients: email.to,
				dmarc: email.authentication ? (email.authentication.dmarc ?? "unknown") : null,
				rawUrl: email.raw?.download_url ?? null,
			};
		},
	);
}
