import { env } from "cloudflare:workers";
import { asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { keysDone } from "../reseal-state";
import { type SecretsKeySettings, secretsKeys } from "../secrets-key";
import {
	cloudflareVerdict,
	deliveryKey,
	firstHeader,
	type Header,
	parseHeaders,
	readHeaderBlock,
	resendVerifiedDomain,
	verifiedDomain,
} from "./headers";
import { rawMail } from "./sealed";
import { ownId, referencedIds } from "./thread";

export { Mailbox } from "./durable-object";

/** The mailbox's own instance. Only the Worker reaches it, after checking who is asking. */
export function mailboxStub(mailboxId: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

/** Where a mailbox's raw mail lives in R2. */
export const mailboxPrefix = (workspaceId: string, mailboxId: string) =>
	`${workspaceId}/${mailboxId}/`;

/** What `email()` gets from Cloudflare, or a delivery from Resend, as far as storing goes. */
export interface ArrivingMessage {
	readonly from: string;
	readonly to: string;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
}

/** What proves who sent a message: a DMARC result, and the domain it proves the mail came from. */
export type Judge = (headers: Header[]) => { dmarc: string | null; verifiedDomain: string | null };

/** For mail from Email Routing: Cloudflare's own `Authentication-Results`, in its own place. */
export const judgedByCloudflare: Judge = (headers) => {
	const verdict = cloudflareVerdict(headers);
	return { dmarc: verdict?.dmarc ?? null, verifiedDomain: verifiedDomain(headers, verdict) };
};

/**
 * For mail that came through Resend: the DMARC result its API gives, which its MX computed, for
 * the From it read (`from`). Nothing in the mail itself counts, as a sender can write anything
 * there, Cloudflare's headers too.
 */
export const judgedByResend =
	(dmarc: string | null, from: string | null): Judge =>
	(headers) => ({ dmarc, verifiedDomain: resendVerifiedDomain(headers, dmarc, from) });

/** The mailbox has no room for the message, which may change by the time the sender tries again. */
export class MailboxFullError extends Error {
	override name = "MailboxFullError";
	constructor() {
		super("The mailbox is full");
	}
}

/**
 * Stores a message for a mailbox the directory found. The header block is read from the start of
 * the raw mail, and the whole of it streams into R2, sealed when the deployment has a
 * `SECRETS_KEY`, without being held in memory. Anything that goes wrong throws, which tells the
 * sender to try again.
 */
export async function storeMail(
	found: { workspaceId: string; mailboxId: string; agentMemberId?: string | null },
	message: ArrivingMessage,
	judge: Judge = judgedByCloudflare,
): Promise<void> {
	const [forHeaders, forStoring] = message.raw.tee();
	const headers = parseHeaders(await readHeaderBlock(forHeaders));
	const judged = judge(headers);
	const mailbox = mailboxStub(found.mailboxId);
	const raw = rawMail(env);
	const begun = await mailbox.begin({
		workspaceId: found.workspaceId,
		mailboxId: found.mailboxId,
		key: await deliveryKey(found.mailboxId, headers),
		size: message.rawSize,
		envelopeFrom: message.from,
		envelopeTo: message.to,
		from: firstHeader(headers, "from"),
		subject: firstHeader(headers, "subject"),
		date: firstHeader(headers, "date"),
		messageId: firstHeader(headers, "message-id"),
		ownId: ownId(headers),
		references: referencedIds(headers),
		dmarc: judged.dmarc,
		verifiedDomain: judged.verifiedDomain,
		cameFor: found.agentMemberId ?? null,
		seal: await raw.newSeal(),
	});
	if (!begun.ok) {
		await forStoring.cancel();
		// Temporary on purpose: the mailbox may have room again by the time the sender retries.
		throw new MailboxFullError();
	}
	// Sealed as the mailbox kept it: an object older than sealing keeps no seal, and says none.
	await raw.put(
		{ object: begun.object, size: message.rawSize, seal: begun.seal ?? null },
		forStoring,
	);
	if ((await mailbox.finish(begun.id)) === "gone") {
		// The alarm or a removal let this delivery go while it was on its way, and nothing knows its
		// mail now. The sender tries again.
		await env.RAW_MAIL.delete(begun.object).catch(() => {});
		throw new Error("The mailbox gave up on this delivery");
	}
}

/** Removes everything a mailbox held. Its row in D1 must be gone first, so no more mail arrives. */
export async function destroyMailbox(workspaceId: string, mailboxId: string): Promise<void> {
	await mailboxStub(mailboxId).destroy(mailboxPrefix(workspaceId, mailboxId));
}

/**
 * Removes the mail of mailboxes that have just been removed, one at a time. D1 has a record of
 * each removal, which the daily run finishes, so one that fails here is only logged, by its
 * error's name.
 */
export async function removeMailboxes(workspaceId: string, mailboxIds: string[]): Promise<void> {
	for (const mailboxId of mailboxIds) {
		try {
			await destroyMailbox(workspaceId, mailboxId);
		} catch (error) {
			console.error("mailbox: removing its mail failed; the daily run will", {
				name: error instanceof Error ? error.name : "unknown",
			});
		}
	}
}

/**
 * How long after a removal the daily run finishes it. A delivery that found the mailbox just
 * before it went can land a few minutes later, and by then none can.
 */
export const REMOVAL_SETTLES_MS = 60 * 60 * 1000;

/** How many removals one daily run finishes. The rest wait for the next. */
const REMOVALS_PER_RUN = 500;

/** How many mailboxes one daily run asks about their mail under the previous key. */
export const RESEAL_MAILBOXES_PER_RUN = 200;

/** What the daily run learned of mail under the previous `SECRETS_KEY`. */
export interface MailboxesResealed {
	/** Mailboxes asked in this run. */
	asked: number;
	/** Messages they hold under the previous key, which their alarms seal again from now on. */
	messages: number;
	/** Messages they hold that open with neither key. */
	unopened: number;
	/** Mailboxes that may still hold mail under the previous key, after this run. */
	left: number;
}

/**
 * Asks mailboxes about their mail under the key before the current `SECRETS_KEY`, which wakes
 * each to seal it again, and notes in D1 each that has none left (`mailbox.sealed_under`, see
 * `keysDone`), so that the previous key may go once no mailbox is left. A mailbox that stores mail
 * under another key later, as from a Worker of the version before, takes its note back. Null when the deployment has no previous
 * key. Those asked are picked at random from the rest, so that one that never finishes, as with
 * mail R2 keeps failing on, doesn't keep others from their turn.
 */
export async function resealMailboxes(
	db: Database,
	settings: SecretsKeySettings,
): Promise<MailboxesResealed | null> {
	const { current, previous } = await secretsKeys(settings);
	if (!current || !previous) return null;
	const { mailbox } = schema;
	const doneWith = keysDone(current.id, previous.id);
	const notDone = or(isNull(mailbox.sealedUnder), ne(mailbox.sealedUnder, doneWith));
	const due = await db
		.select({ id: mailbox.id })
		.from(mailbox)
		.where(notDone)
		.orderBy(sql`random()`)
		.limit(RESEAL_MAILBOXES_PER_RUN)
		.all();
	const done: MailboxesResealed = { asked: 0, messages: 0, unopened: 0, left: 0 };
	// A few at once: each is a call to its mailbox's object.
	for (let at = 0; at < due.length; at += 10) {
		await Promise.all(
			due.slice(at, at + 10).map(async ({ id }) => {
				try {
					const status = await mailboxStub(id).resealStatus();
					if (!status) return;
					done.asked++;
					done.messages += status.left;
					done.unopened += status.unopened;
					if (status.left === 0) {
						await db.update(mailbox).set({ sealedUnder: doneWith }).where(eq(mailbox.id, id)).run();
					}
				} catch (error) {
					console.error("mailbox: asking about mail under the previous key failed", {
						name: error instanceof Error ? error.name : "unknown",
					});
				}
			}),
		);
	}
	const left = await db.select({ count: sql<number>`count(*)` }).from(mailbox).where(notDone).get();
	done.left = left?.count ?? 0;
	return done;
}

/**
 * Removes again what removed mailboxes held, from D1's records of their removal, and forgets the
 * records. Only those mailboxes' prefixes are touched, so the bucket may hold other things.
 */
export async function finishRemovals(db: Database, now = Date.now()): Promise<number> {
	const due = await db
		.select()
		.from(schema.mailboxRemoval)
		.where(lte(schema.mailboxRemoval.removedAt, new Date(now - REMOVAL_SETTLES_MS)))
		.orderBy(asc(schema.mailboxRemoval.removedAt))
		.limit(REMOVALS_PER_RUN)
		.all();
	let finished = 0;
	// A few at once: each is a call to its mailbox's object and a listing of R2.
	for (let at = 0; at < due.length; at += 10) {
		await Promise.all(
			due.slice(at, at + 10).map(async (removal) => {
				try {
					await destroyMailbox(removal.organizationId, removal.mailboxId);
					await db
						.delete(schema.mailboxRemoval)
						.where(eq(schema.mailboxRemoval.mailboxId, removal.mailboxId))
						.run();
					finished++;
				} catch (error) {
					console.error("mailbox: finishing a removal failed; the next run will", {
						name: error instanceof Error ? error.name : "unknown",
					});
				}
			}),
		);
	}
	return finished;
}
