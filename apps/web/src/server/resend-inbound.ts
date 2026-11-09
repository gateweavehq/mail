import { env } from "cloudflare:workers";
import { type AnyColumn, and, eq, exists, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { RESEND_CODE, type ReceivesWith, type SendsWith } from "../lib/providers";
import type { Database } from "./db";
import { schema } from "./db";
import { directoryIn } from "./delivery-events";
import { findAddress, setDomainSending } from "./directory";
import { judgedByResend, MailboxFullError, mailboxStub, storeMail } from "./mailbox";
import { openProviderKey } from "./providers/keys";
import {
	checkResendKey,
	createWebhook,
	deleteWebhook,
	getReceivedEmail,
	RECEIVED_EVENT,
	RESEND_API,
	type ReceivedEmail,
	type ResendCallFailure,
	repairWebhook,
	SUPPRESSION_REMOVED_EVENT,
	webhookState,
} from "./providers/resend";
import { svixHeaders, verifySvix } from "./providers/svix";
import { bareAddress, isDeliveryEvent, readResendEvent, recordResendEvent } from "./resend-events";
import { isSealer, sealerFor } from "./secrets";
import { readUpTo, streamOf, textOf } from "./streams";
import { removeProviderListed } from "./suppressions";

/**
 * The workspace's webhook in the Resend account of its key, made once and shared by its domains:
 * it tells Mail of mail Resend received, here, and of what became of mail it sent, which
 * `resend-events.ts` records.
 *
 * Mail for a domain whose MX is Resend's. Resend takes it, and its webhook tells Mail it came:
 * only the id, as the webhook carries no content. Mail then asks Resend's API for the email with the
 * workspace's key, which says whom it was delivered to and what Resend's MX found of its sender,
 * downloads the raw mail, and stores it as `email()` does (`mailbox/`).
 *
 * The rules this keeps, beside those of `inbound.ts`:
 *
 * - A delivery counts only when it is signed with the workspace's webhook secret (Svix's scheme),
 *   and only for its workspace: the channel in the address finds the workspace, and mail is stored
 *   only for addresses on that workspace's proved domains that are set to receive with Resend.
 * - Mail goes only to the envelope's recipient, as with `email()`, never to an address that is
 *   only in its headers: those are the sender's to write, and a copy for a Bcc keeps them.
 * - Who sent it is proved only by the DMARC result Resend's API gives. The raw mail is the sender's
 *   to write, and could begin with a copy of Cloudflare's headers.
 * - Mail answers with a success only once the mail is stored, or once trying again can't help.
 *   Otherwise it answers 503, and Resend tries again, eight times over about a day. A retry, or a
 *   copy that came twice, is told apart as in `email()`, by the delivery key and the body.
 * - What went wrong last stays on the workspace's row, for its Domains page, as Resend turns off a
 *   webhook that keeps failing.
 */

export const INBOUND_PATH = "/api/inbound/resend/";

/** Where the webhook's signing secret is sealed, which its sealed value names. */
const SECRET_PLACE = "resend-inbound/signing-secret";

/** The largest webhook body read: the event carries addresses and a subject, never content. */
const MAX_EVENT_BYTES = 256 * 1024;

/** The most of the workspace's addresses one received email is stored for. */
const MAX_RECIPIENTS = 50;

/** The largest raw mail Mail takes from Resend, which is as much as Resend sends. */
export const MAX_RESEND_RAW_BYTES = 40 * 1024 * 1024;

/** How long downloading the raw mail may take. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * How long the webhook stays once no domain sends or receives with Resend: what became of mail sent
 * before can still come, as a complaint days later or a bounce after the receiving server kept
 * trying, and a complaint missed is mail to someone who asked not to get it.
 */
export const UNUSED_WEBHOOK_DAYS = 14;

const api = () => env.RESEND_API_URL || RESEND_API;

const newChannel = () => crypto.randomUUID().replaceAll("-", "");

export type SetUp = { ok: true } | { ok: false; error: string; status: 409 | 502 };

const refuse = (error: string, status: 409 | 502 = 409): SetUp => ({ ok: false, error, status });

/** What the webhook is wanted for, which says what a key that can only send can't do. */
type Purpose = "receiving" | "sending";

const NEEDS_FULL_ACCESS: Record<Purpose, string> = {
	receiving:
		"Receiving through Resend needs a key with full access, as a key that can only send can't read received mail. Add one, then choose Resend again.",
	sending:
		"Mail can't learn what became of mail sent through Resend, or stop writing to addresses that bounce, as a key that can only send can't make the webhook that tells it. Add a key with full access, then check the webhook.",
};

/** For a webhook that is made: it still tells Mail, but a key that can only send can't look at it. */
const CANT_CHECK =
	"A key that can only send can't check Resend's webhook, which stays as it was: if it is on, Mail still learns what became of the mail. Add a key with full access to check it.";

/**
 * Makes sure the workspace has its webhook in the Resend account of its key, made once and shared
 * by its domains, that it is on, asks for every event Mail needs and points at the workspace's
 * channel on this server. One that Resend no longer has, as after the key was replaced with one
 * from another account, is made again; one Resend turned off after deliveries kept failing, one
 * made before Mail recorded deliveries, or one that points elsewhere, as after the server's address
 * changed, is mended. Making one needs a key with full access.
 */
export async function ensureWebhook(
	db: Database,
	workspaceId: string,
	origin: string,
	purpose: Purpose,
): Promise<SetUp> {
	const opened = await openProviderKey(db, env.SECRETS_KEY, workspaceId, "resend");
	if (!opened.ok) {
		return refuse(
			opened.code === "no_key"
				? "Add the workspace's Resend key first."
				: "The workspace's Resend key can't be read on this server any more. Add it again.",
		);
	}
	const sealer = await sealerFor(env.SECRETS_KEY, workspaceId);
	if (!isSealer(sealer)) return refuse(sealer.unavailable);
	const { resendInbound } = schema;
	const check = await checkResendKey(api(), opened.key);
	if (!check.ok) return refuse(check.error, 502);
	if (check.access !== "full") {
		// Receiving reads each email with the key, so it can't work at all with one that only sends.
		if (purpose === "sending") {
			const made = await db
				.select({ webhookId: resendInbound.webhookId })
				.from(resendInbound)
				.where(eq(resendInbound.organizationId, workspaceId))
				.get();
			if (made?.webhookId) return refuse(CANT_CHECK);
		}
		return refuse(NEEDS_FULL_ACCESS[purpose]);
	}

	// One row per workspace, made before the webhook, so two admins at once share one channel.
	await db
		.insert(resendInbound)
		.values({ organizationId: workspaceId, channel: newChannel() })
		.onConflictDoNothing()
		.run();
	const row = await db
		.select()
		.from(resendInbound)
		.where(eq(resendInbound.organizationId, workspaceId))
		.get();
	if (!row) return refuse("The webhook was being removed at the same moment. Try again.");
	const endpoint = `${origin}${INBOUND_PATH}${row.channel}`;

	if (row.webhookId) {
		const state = await webhookState(api(), opened.key, row.webhookId);
		if (!state.ok)
			return refuse(
				`Resend couldn't be asked about the webhook (${state.failure.code}). Try again.`,
				502,
			);
		if (state.value !== "gone") {
			if (state.value.on && state.value.endpoint === endpoint && state.value.allEvents) {
				return { ok: true };
			}
			const mended = await repairWebhook(api(), opened.key, row.webhookId, endpoint);
			if (mended.ok) return { ok: true };
			return refuse(`Resend didn't mend the webhook (${mended.failure.code}). Try again.`, 502);
		}
		await db
			.update(resendInbound)
			.set({ webhookId: null, sealedSecret: null })
			.where(
				and(
					eq(resendInbound.organizationId, workspaceId),
					eq(resendInbound.webhookId, row.webhookId),
				),
			)
			.run();
	}

	const made = await createWebhook(api(), opened.key, endpoint);
	if (!made.ok) {
		return refuse(`Resend didn't make the webhook (${made.failure.code}). Try again.`, 502);
	}
	const { meta } = await db
		.update(resendInbound)
		.set({
			webhookId: made.value.id,
			sealedSecret: await sealer.seal(SECRET_PLACE, made.value.secret),
		})
		// The row it was made for: one made anew after receiving was turned off and on meanwhile has
		// another channel, which this webhook doesn't point at.
		.where(
			and(
				eq(resendInbound.organizationId, workspaceId),
				eq(resendInbound.channel, row.channel),
				isNull(resendInbound.webhookId),
			),
		)
		.run();
	if (!meta.changes) {
		// Another admin's webhook came first, or the row went meanwhile: this one goes.
		await deleteWebhook(api(), opened.key, made.value.id);
		const now = await db
			.select({ webhookId: resendInbound.webhookId })
			.from(resendInbound)
			.where(eq(resendInbound.organizationId, workspaceId))
			.get();
		if (!now?.webhookId)
			return refuse("The webhook was being removed at the same moment. Try again.");
	}
	return { ok: true };
}

/** The domains that use Resend, to receive or to send, of a workspace or of the row's. */
const usingResend = (workspaceId: string | AnyColumn) =>
	and(
		eq(schema.mailDomain.organizationId, workspaceId),
		or(eq(schema.mailDomain.receivesWith, "resend"), eq(schema.mailDomain.sendsWith, "resend")),
	);

/** What the workspace's webhook is wanted for now, or null when no domain uses Resend. */
async function purposeOf(db: Database, workspaceId: string): Promise<Purpose | null> {
	const { mailDomain } = schema;
	const used = await db
		.select({ receivesWith: mailDomain.receivesWith })
		.from(mailDomain)
		.where(usingResend(workspaceId))
		.all();
	if (used.length === 0) return null;
	return used.some((domain) => domain.receivesWith === "resend") ? "receiving" : "sending";
}

/**
 * Checks the workspace's webhook again from its Domains page, and mends it: made again when Resend
 * lost it, or on again when Resend turned it off, with every event Mail needs.
 */
export async function mendWebhook(
	db: Database,
	workspaceId: string,
	origin: string,
): Promise<SetUp> {
	const purpose = await purposeOf(db, workspaceId);
	if (!purpose) return refuse("No domain sends or receives with Resend.");
	return ensureWebhook(db, workspaceId, origin, purpose);
}

/**
 * Sees to the webhook once the workspace has a new key, which may be from another Resend account:
 * there it is made again. What Mail can't do with the key, or null when the webhook is ready or no
 * domain uses Resend.
 */
export async function webhookForNewKey(
	db: Database,
	workspaceId: string,
	origin: string,
): Promise<string | null> {
	const purpose = await purposeOf(db, workspaceId);
	if (!purpose) return null;
	const set = await ensureWebhook(db, workspaceId, origin, purpose);
	return set.ok ? null : set.error;
}

/**
 * Notes whether any of the workspace's domains still sends or receives with Resend, after one
 * changed. When none does, the webhook stays `UNUSED_WEBHOOK_DAYS`, then the daily run removes it.
 * It is one statement that reads the domains as they are, so of two changes at once, the one that
 * notes last sees both.
 */
export async function noteWebhookUse(
	db: Database,
	workspaceId: string,
	now = Date.now(),
): Promise<void> {
	const { mailDomain, resendInbound } = schema;
	const used = db.select({ id: mailDomain.id }).from(mailDomain).where(usingResend(workspaceId));
	await db
		.update(resendInbound)
		.set({
			unusedSince: sql`CASE WHEN ${exists(used)} THEN NULL ELSE coalesce(${resendInbound.unusedSince}, ${now}) END`,
		})
		.where(eq(resendInbound.organizationId, workspaceId))
		.run();
}

/**
 * Removes the webhooks no domain has used for `UNUSED_WEBHOOK_DAYS`, from the daily run. Removing
 * one from Resend is a courtesy: one left there finds no channel here, and Resend turns it off.
 */
export async function dropUnusedWebhooks(db: Database, now = Date.now()): Promise<number> {
	const { mailDomain, resendInbound } = schema;
	// One statement, so a domain switched to Resend at the same moment keeps its workspace's webhook.
	const dropped = await db
		.delete(resendInbound)
		.where(
			and(
				lt(resendInbound.unusedSince, new Date(now - UNUSED_WEBHOOK_DAYS * 24 * 60 * 60 * 1000)),
				notExists(
					db
						.select({ id: mailDomain.id })
						.from(mailDomain)
						.where(usingResend(resendInbound.organizationId)),
				),
			),
		)
		.returning({ workspaceId: resendInbound.organizationId, webhookId: resendInbound.webhookId })
		.all();
	for (const { workspaceId, webhookId } of dropped) {
		if (!webhookId) continue;
		const opened = await openProviderKey(db, env.SECRETS_KEY, workspaceId, "resend");
		if (opened.ok) await deleteWebhook(api(), opened.key, webhookId);
	}
	return dropped.length;
}

/**
 * How a domain's mail arrives from now on. For Resend the domain is set first and the webhook made
 * after, so a domain switched off at the same moment can't take the webhook away from it; when the
 * webhook can't be made, the domain goes back to Cloudflare. Choosing Resend again makes it again
 * if it went, which mends a webhook lost to a replaced key.
 */
export async function setDomainReceiving(
	db: Database,
	workspaceId: string,
	id: string,
	receivesWith: ReceivesWith,
	origin: string,
): Promise<SetUp | { ok: false; error: string; status: 404 }> {
	const { mailDomain } = schema;
	const where = and(eq(mailDomain.id, id), eq(mailDomain.organizationId, workspaceId));
	const domain = await db
		.select({ was: mailDomain.receivesWith })
		.from(mailDomain)
		.where(where)
		.get();
	if (!domain) return { ok: false, error: "Not found", status: 404 };
	await db.update(mailDomain).set({ receivesWith }).where(where).run();
	if (receivesWith === "cloudflare") {
		await noteWebhookUse(db, workspaceId);
		return { ok: true };
	}
	const set = await ensureWebhook(db, workspaceId, origin, "receiving");
	if (!set.ok && domain.was !== "resend") {
		await db.update(mailDomain).set({ receivesWith: "cloudflare" }).where(where).run();
	}
	await noteWebhookUse(db, workspaceId);
	return set;
}

/**
 * How a domain's mail is sent from now on. With Resend, the webhook is made too, which tells what
 * became of the mail. Sending doesn't wait for it: a key that can only send sends, and the answer
 * says what Mail won't learn, in `note`.
 */
export async function setDomainSendingWith(
	db: Database,
	workspaceId: string,
	id: string,
	sendsWith: SendsWith,
	origin: string,
) {
	const set = await setDomainSending(db, workspaceId, id, sendsWith);
	if (!set.ok) return set;
	if (sendsWith === "cloudflare") {
		await noteWebhookUse(db, workspaceId);
		return { ok: true as const };
	}
	const made = await ensureWebhook(db, workspaceId, origin, "sending");
	await noteWebhookUse(db, workspaceId);
	return made.ok ? { ok: true as const } : { ok: true as const, note: made.error };
}

const Event = z.object({ type: z.string().max(100) });

const Received = z.object({
	data: z.object({ email_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }),
});

const SuppressionRemoved = z.object({
	created_at: z.string().max(64).optional().catch(undefined),
	data: z.object({ email: z.string().max(1_000) }),
});

const answer = (status: number) => new Response(null, { status });

/**
 * Takes an address off the workspace's list once someone took it off Resend's own, as in Resend's
 * dashboard: an entry Resend's events made, unless an event said so again since. One Mail can't
 * read is acknowledged, as it would only come again the same. The log never names the address.
 */
async function unlistRemoved(
	db: Database,
	workspaceId: string,
	json: unknown,
	now: number,
): Promise<Response> {
	const parsed = SuppressionRemoved.safeParse(json);
	const address = parsed.success ? bareAddress(parsed.data.data.email) : null;
	if (!parsed.success || address === null) {
		console.warn("resend-events: unreadable");
		return answer(204);
	}
	const time = Date.parse(parsed.data.created_at ?? "");
	// Never after now, so that an event that comes meanwhile still counts as newer.
	const at = Number.isFinite(time) ? Math.min(time, now) : now;
	try {
		await removeProviderListed(db, workspaceId, address, "resend", at);
	} catch {
		console.error("resend-events: suppression not removed");
		return answer(503);
	}
	return answer(204);
}

/**
 * A delivery of Resend's webhook, at `INBOUND_PATH` and the workspace's channel. A channel nobody
 * has gets the same 404 as any other missing page.
 */
export async function receiveFromResend(
	db: Database,
	request: Request,
	channel: string,
	now = Date.now(),
): Promise<Response> {
	if (!/^[a-f0-9]{32}$/.test(channel)) return answer(404);
	const { resendInbound } = schema;
	const row = await db.select().from(resendInbound).where(eq(resendInbound.channel, channel)).get();
	if (!row?.sealedSecret) return answer(404);
	const read = await readUpTo(request.body, MAX_EVENT_BYTES);
	if (read === null) return answer(413);
	const body = textOf(read);

	const sealer = await sealerFor(env.SECRETS_KEY, row.organizationId);
	let secret: string;
	try {
		if (!isSealer(sealer)) throw new Error(sealer.unavailable);
		secret = await sealer.open(SECRET_PLACE, row.sealedSecret);
	} catch {
		// Nothing here can tell Resend's deliveries from anyone's until the secret opens again.
		console.error("resend-inbound: the webhook's secret can't be opened");
		return answer(503);
	}
	if (!(await verifySvix(secret, svixHeaders(request.headers), body, now))) return answer(401);

	let json: unknown;
	let type: string;
	try {
		json = JSON.parse(body);
		type = Event.parse(json).type;
	} catch {
		return answer(400);
	}
	if (isDeliveryEvent(type)) return recordDelivery(db, row.organizationId, json, now);
	if (type === SUPPRESSION_REMOVED_EVENT) return unlistRemoved(db, row.organizationId, json, now);
	// Anything else Mail didn't ask for is acknowledged, so it isn't sent again.
	if (type !== RECEIVED_EVENT) return answer(204);
	const received = Received.safeParse(json);
	if (!received.success) return answer(400);

	const outcome = await deliverReceived(db, row.organizationId, received.data.data.email_id, now);
	// Mail for nobody here says nothing of whether receiving works, so the last trouble stays.
	const noted = {
		...(outcome.stored ? { receivedAt: new Date(now) } : {}),
		...(outcome.trouble !== null
			? { trouble: outcome.trouble, troubleAt: new Date(now) }
			: outcome.stored
				? { trouble: null, troubleAt: null }
				: {}),
	};
	if (Object.keys(noted).length > 0) {
		await db
			.update(resendInbound)
			.set(noted)
			.where(eq(resendInbound.organizationId, row.organizationId))
			.run();
	}
	if (outcome.trouble) console.error("resend-inbound: not stored", { trouble: outcome.trouble });
	return answer(outcome.status);
}

/**
 * Records what became of mail the workspace sent through Resend. An event Mail can't read is
 * acknowledged, as it would only come again the same. The log has the outcome and what failed,
 * never addresses.
 */
async function recordDelivery(
	db: Database,
	workspaceId: string,
	json: unknown,
	now: number,
): Promise<Response> {
	const read = readResendEvent(json, now);
	if (!read) {
		console.warn("resend-events: unreadable");
		return answer(204);
	}
	const recorded = await recordResendEvent(read, workspaceId, directoryIn(db), mailboxStub, now);
	if (recorded.outcome === "failed") {
		console.error("resend-events: not recorded", { failure: recorded.failure });
	} else {
		console.log("resend-events", { outcome: recorded.outcome, suppressed: recorded.suppressed });
	}
	return answer(recorded.status === 200 ? 204 : 503);
}

/** What became of one received email: the answer for Resend, and what went wrong, if anything. */
interface Outcome {
	status: 200 | 503;
	trouble: string | null;
	/** Whether it was stored in a mailbox, a copy before it too. */
	stored: boolean;
}

const stored: Outcome = { status: 200, trouble: null, stored: true };
/** For nobody here, which can't be refused any more, as Resend took it. */
const nobody: Outcome = { status: 200, trouble: null, stored: false };
/** Trying again can't help, so Resend is told it is done. The mail stays in Resend. */
const givenUp = (trouble: string): Outcome => ({ status: 200, trouble, stored: false });
/** It may work later, so Resend tries again. */
const later = (trouble: string): Outcome => ({ status: 503, trouble, stored: false });

/** How bad an outcome is, so the worst of several is the answer. */
const badness = (outcome: Outcome) => (outcome.status === 503 ? 2 : outcome.trouble ? 1 : 0);

/** What to tell Resend when its API didn't give the email. */
function notGiven(failure: ResendCallFailure): Outcome {
	// Resend failed, was busy or wasn't reached. Or the key can't read it, or its account doesn't
	// have it yet, which an admin can mend with another key, or which may pass: Resend keeps trying.
	if (
		failure.later ||
		failure.status === 401 ||
		failure.status === 403 ||
		failure.code === `${RESEND_CODE}not_found`
	) {
		return later(failure.code);
	}
	// A request Resend calls wrong, or an answer Mail can't read: no later try changes that.
	return givenUp(failure.code);
}

/** Stores one email Resend received in each mailbox here that one of its addresses belongs to. */
async function deliverReceived(
	db: Database,
	workspaceId: string,
	emailId: string,
	now: number,
): Promise<Outcome> {
	// Only addresses on this workspace's domains that receive with Resend, before any are left out.
	// The webhook also tells of mail the Resend account receives for others, which costs no call to
	// Resend while no domain here receives with it.
	const { mailDomain } = schema;
	const domains = new Set(
		(
			await db
				.select({ name: mailDomain.name })
				.from(mailDomain)
				.where(
					and(eq(mailDomain.organizationId, workspaceId), eq(mailDomain.receivesWith, "resend")),
				)
				.all()
		).map((domain) => domain.name.toLowerCase()),
	);
	if (domains.size === 0) return nobody;
	const opened = await openProviderKey(db, env.SECRETS_KEY, workspaceId, "resend");
	if (!opened.ok) return later(opened.code);
	const got = await getReceivedEmail(api(), opened.key, emailId);
	if (!got.ok) return notGiven(got.failure);
	const email = got.value;
	const addresses = [
		...new Set(email.recipients.map(bareAddress).filter((address) => address !== null)),
	].filter((address) => domains.has(address.slice(address.lastIndexOf("@") + 1)));

	const mailboxes = new Map<string, string>();
	for (const address of addresses.slice(0, MAX_RECIPIENTS)) {
		const found = await findAddress(db, address, new Date(now));
		if (found?.workspaceId !== workspaceId || found.receivesWith !== "resend") continue;
		if (!mailboxes.has(found.mailboxId)) mailboxes.set(found.mailboxId, address);
	}
	if (mailboxes.size === 0) return nobody;
	if (!email.rawUrl) return later("raw_unavailable");

	// Each mailbox is tried, so one that is full doesn't keep the mail from the others.
	let worst = stored;
	let some = false;
	for (const [mailboxId, address] of mailboxes) {
		const outcome = await storeReceived(email, { workspaceId, mailboxId }, address);
		some ||= outcome.stored;
		if (badness(outcome) > badness(worst)) worst = outcome;
	}
	return { ...worst, stored: some };
}

async function storeReceived(
	email: ReceivedEmail,
	found: { workspaceId: string; mailboxId: string },
	to: string,
): Promise<Outcome> {
	let response: Response;
	try {
		response = await fetch(email.rawUrl ?? "", {
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
	} catch {
		return later("raw_unavailable");
	}
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		return later("raw_unavailable");
	}
	// A compressed answer is unpacked on the way in, so its length isn't the mail's.
	const encoding = response.headers.get("content-encoding");
	const length =
		encoding && encoding !== "identity"
			? Number.NaN
			: Number(response.headers.get("content-length") ?? Number.NaN);
	let raw: ReadableStream<Uint8Array>;
	let rawSize: number;
	if (Number.isSafeInteger(length) && length >= 0) {
		if (length > MAX_RESEND_RAW_BYTES) {
			await response.body.cancel();
			return givenUp("too_large");
		}
		raw = response.body;
		rawSize = length;
	} else {
		// R2 needs the length before it takes a stream, so mail sent without one is read first.
		let read: Awaited<ReturnType<typeof readUpTo>>;
		try {
			read = await readUpTo(response.body, MAX_RESEND_RAW_BYTES);
		} catch {
			return later("raw_unavailable");
		}
		if (!read) return givenUp("too_large");
		rawSize = read.size;
		raw = streamOf(read);
	}
	try {
		await storeMail(
			found,
			// Resend gives the From it read, not the envelope's sender, which it doesn't name.
			{ from: email.from ?? "", to, raw, rawSize },
			judgedByResend(email.dmarc, email.from),
		);
		return stored;
	} catch (error) {
		return later(error instanceof MailboxFullError ? "mailbox_full" : "store_failed");
	}
}
