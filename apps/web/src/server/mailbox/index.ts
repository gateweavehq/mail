import { env } from "cloudflare:workers";
import { asc, eq, lte } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import {
	cloudflareVerdict,
	deliveryKey,
	firstHeader,
	parseHeaders,
	readHeaderBlock,
	verifiedDomain,
} from "./headers";

export { Mailbox } from "./durable-object";

/** The mailbox's own instance. Only the Worker reaches it, after checking who is asking. */
export function mailboxStub(mailboxId: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

/** Where a mailbox's raw mail lives in R2. */
export const mailboxPrefix = (workspaceId: string, mailboxId: string) =>
	`${workspaceId}/${mailboxId}/`;

/** What `email()` gets from Cloudflare, as far as storing goes. */
export interface ArrivingMessage {
	readonly from: string;
	readonly to: string;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
}

/**
 * Stores a message for a mailbox the directory found. The header block is read from the start of
 * the raw mail, and the whole of it streams into R2 without being held in memory. Anything that
 * goes wrong throws, which tells the sender to try again.
 */
export async function storeMail(
	found: { workspaceId: string; mailboxId: string },
	message: ArrivingMessage,
): Promise<void> {
	const [forHeaders, forStoring] = message.raw.tee();
	const headers = parseHeaders(await readHeaderBlock(forHeaders));
	const verdict = cloudflareVerdict(headers);
	const mailbox = mailboxStub(found.mailboxId);
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
		dmarc: verdict?.dmarc ?? null,
		verifiedDomain: verifiedDomain(headers, verdict),
	});
	if (!begun.ok) {
		await forStoring.cancel();
		// Temporary on purpose: the mailbox may have room again by the time the sender retries.
		throw new Error("The mailbox is full");
	}
	// R2 needs the length up front to take a stream, and Cloudflare gives it.
	const sized = new FixedLengthStream(message.rawSize);
	const stored = env.RAW_MAIL.put(begun.object, sized.readable);
	await forStoring.pipeTo(sized.writable);
	await stored;
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
