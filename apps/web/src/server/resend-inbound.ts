import { env } from "cloudflare:workers";
import { and, eq, isNull, notExists } from "drizzle-orm";
import { z } from "zod";
import { RESEND_CODE, type ReceivesWith } from "../lib/providers";
import type { Database } from "./db";
import { schema } from "./db";
import { findAddress } from "./directory";
import { judgedByResend, MailboxFullError, storeMail } from "./mailbox";
import { openProviderKey } from "./providers/keys";
import {
	checkResendKey,
	createReceivingWebhook,
	deleteWebhook,
	enableWebhook,
	getReceivedEmail,
	RECEIVED_EVENT,
	RESEND_API,
	type ReceivedEmail,
	type ResendCallFailure,
	webhookState,
} from "./providers/resend";
import { svixHeaders, verifySvix } from "./providers/svix";
import { isSealer, sealerFor } from "./secrets";
import { readUpTo, streamOf, textOf } from "./streams";

/**
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

const api = () => env.RESEND_API_URL || RESEND_API;

const newChannel = () => crypto.randomUUID().replaceAll("-", "");

export type SetUp = { ok: true } | { ok: false; error: string; status: 409 | 502 };

const refuse = (error: string, status: 409 | 502 = 409): SetUp => ({ ok: false, error, status });

/**
 * Makes sure the workspace has its webhook in the Resend account of its key, made once and shared
 * by its domains, and that it is on. One that Resend no longer has, as after the key was replaced
 * with one from another account, is made again, and one Resend turned off after deliveries kept
 * failing is turned back on. The key needs full access, which reading received mail takes.
 */
export async function ensureReceivingWebhook(
	db: Database,
	workspaceId: string,
	origin: string,
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
	const check = await checkResendKey(api(), opened.key);
	if (!check.ok) return refuse(check.error, 502);
	if (check.access !== "full") {
		return refuse(
			"Receiving through Resend needs a key with full access, as a key that can only send can't read received mail. Add one, then choose Resend again.",
		);
	}

	const { resendInbound } = schema;
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
	if (!row) return refuse("Receiving was being turned off at the same moment. Try again.");

	if (row.webhookId) {
		const state = await webhookState(api(), opened.key, row.webhookId);
		if (!state.ok)
			return refuse(
				`Resend couldn't be asked about the webhook (${state.failure.code}). Try again.`,
				502,
			);
		if (state.value === "enabled") return { ok: true };
		if (state.value === "disabled") {
			const enabled = await enableWebhook(api(), opened.key, row.webhookId);
			if (enabled.ok) return { ok: true };
			return refuse(
				`Resend didn't turn the webhook back on (${enabled.failure.code}). Try again.`,
				502,
			);
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

	const made = await createReceivingWebhook(
		api(),
		opened.key,
		`${origin}${INBOUND_PATH}${row.channel}`,
	);
	if (!made.ok) {
		return refuse(`Resend didn't make the webhook (${made.failure.code}). Try again.`, 502);
	}
	const { meta } = await db
		.update(resendInbound)
		.set({
			webhookId: made.value.id,
			sealedSecret: await sealer.seal(SECRET_PLACE, made.value.secret),
		})
		.where(and(eq(resendInbound.organizationId, workspaceId), isNull(resendInbound.webhookId)))
		.run();
	if (!meta.changes) {
		// Another admin's webhook came first, or receiving was turned off meanwhile: this one goes.
		await deleteWebhook(api(), opened.key, made.value.id);
		const now = await db
			.select({ webhookId: resendInbound.webhookId })
			.from(resendInbound)
			.where(eq(resendInbound.organizationId, workspaceId))
			.get();
		if (!now?.webhookId)
			return refuse("Receiving was being turned off at the same moment. Try again.");
	}
	return { ok: true };
}

/**
 * Checks the workspace's webhook again from its Domains page, and mends it: made again when Resend
 * lost it, or on again when Resend turned it off.
 */
export async function mendReceiving(
	db: Database,
	workspaceId: string,
	origin: string,
): Promise<SetUp> {
	const { mailDomain } = schema;
	const used = await db
		.select({ id: mailDomain.id })
		.from(mailDomain)
		.where(and(eq(mailDomain.organizationId, workspaceId), eq(mailDomain.receivesWith, "resend")))
		.get();
	if (!used) return refuse("No domain receives with Resend.");
	return ensureReceivingWebhook(db, workspaceId, origin);
}

/**
 * Removes the workspace's webhook once none of its domains receives with Resend. Removing it from
 * Resend is a courtesy: one left there finds no channel here, and Resend turns it off.
 */
export async function dropUnusedReceivingWebhook(db: Database, workspaceId: string): Promise<void> {
	const { mailDomain, resendInbound } = schema;
	// One statement, so a domain switched to Resend at the same moment keeps the webhook.
	const [row] = await db
		.delete(resendInbound)
		.where(
			and(
				eq(resendInbound.organizationId, workspaceId),
				notExists(
					db
						.select({ id: mailDomain.id })
						.from(mailDomain)
						.where(
							and(
								eq(mailDomain.organizationId, workspaceId),
								eq(mailDomain.receivesWith, "resend"),
							),
						),
				),
			),
		)
		.returning({ webhookId: resendInbound.webhookId })
		.all();
	if (!row?.webhookId) return;
	const opened = await openProviderKey(db, env.SECRETS_KEY, workspaceId, "resend");
	if (opened.ok) await deleteWebhook(api(), opened.key, row.webhookId);
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
		await dropUnusedReceivingWebhook(db, workspaceId);
		return { ok: true };
	}
	const set = await ensureReceivingWebhook(db, workspaceId, origin);
	if (!set.ok && domain.was !== "resend") {
		await db.update(mailDomain).set({ receivesWith: "cloudflare" }).where(where).run();
		await dropUnusedReceivingWebhook(db, workspaceId);
	}
	return set;
}

const Event = z.object({
	type: z.string().max(100),
	data: z.object({ email_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).optional(),
});

const answer = (status: number) => new Response(null, { status });

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

	let event: z.infer<typeof Event>;
	try {
		event = Event.parse(JSON.parse(body));
	} catch {
		return answer(400);
	}
	// Only received mail is asked for. Anything else is acknowledged, so it isn't sent again.
	if (event.type !== RECEIVED_EVENT) return answer(204);
	if (!event.data) return answer(400);

	const outcome = await deliverReceived(db, row.organizationId, event.data.email_id, now);
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

/** Resend's codes for a key it didn't take, which an admin can mend by adding another. */
const KEY_TROUBLE = new Set(
	["missing_api_key", "invalid_api_key", "restricted_api_key", "401", "403"].map(
		(name) => `${RESEND_CODE}${name}`,
	),
);

/** What to tell Resend when its API didn't give the email. */
function notGiven(failure: ResendCallFailure): Outcome {
	// Resend failed, was busy or wasn't reached, or the key can't read mail, which may be mended in
	// time: Resend keeps trying.
	if (failure.later || KEY_TROUBLE.has(failure.code)) return later(failure.code);
	// Not in the key's account, or an answer Mail can't read: no later try changes that.
	return givenUp(failure.code);
}

/** `Name <a@b>` or `a@b` as a bare address in lower case, or null. */
function bareAddress(text: string): string | null {
	const inside = /<([^<>]*)>\s*$/.exec(text)?.[1] ?? text;
	const address = inside.trim().toLowerCase();
	return /^[^\s@<>]+@[^\s@<>]+$/.test(address) ? address : null;
}

/** Stores one email Resend received in each mailbox here that one of its addresses belongs to. */
async function deliverReceived(
	db: Database,
	workspaceId: string,
	emailId: string,
	now: number,
): Promise<Outcome> {
	const opened = await openProviderKey(db, env.SECRETS_KEY, workspaceId, "resend");
	if (!opened.ok) return later(opened.code);
	const got = await getReceivedEmail(api(), opened.key, emailId);
	if (!got.ok) return notGiven(got.failure);
	const email = got.value;

	// Only addresses on this workspace's domains that receive with Resend, before any are left out.
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
