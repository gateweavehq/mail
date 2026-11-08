import { env } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import {
	cloudflareDmarc,
	deliveryKey,
	firstHeader,
	parseHeaders,
	readHeaderBlock,
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
		dmarc: cloudflareDmarc(headers),
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
		throw new Error("The mailbox gave up on this delivery");
	}
}

/** Removes everything a mailbox held. Its row in D1 must be gone first, so no more mail arrives. */
export async function destroyMailbox(workspaceId: string, mailboxId: string): Promise<void> {
	await mailboxStub(mailboxId).destroy(mailboxPrefix(workspaceId, mailboxId));
}

/**
 * Removes the mail of mailboxes that have just been removed, one at a time. One that fails is left
 * for the daily sweep, and its error's name is all that is logged.
 */
export async function removeMailboxes(workspaceId: string, mailboxIds: string[]): Promise<void> {
	for (const mailboxId of mailboxIds) {
		try {
			await destroyMailbox(workspaceId, mailboxId);
		} catch (error) {
			console.error("mailbox: removing its mail failed; the daily sweep will", {
				name: error instanceof Error ? error.name : "unknown",
			});
		}
	}
}

/** How many mailboxes one sweep looks at, so the daily run stays short. */
const SWEEP_LIMIT = 500;

/** The workspaces' prefixes in R2, from `startAfter` on, or up to `upTo`. */
async function* workspacePrefixes(range: { startAfter?: string; upTo?: string }) {
	let cursor: string | undefined;
	do {
		const listed = await env.RAW_MAIL.list({
			delimiter: "/",
			cursor,
			...(cursor ? {} : { startAfter: range.startAfter }),
		});
		for (const prefix of listed.delimitedPrefixes) {
			if (range.upTo !== undefined && prefix > range.upTo) return;
			yield prefix;
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}

/**
 * Removes the mail of mailboxes that no longer exist. Removing a mailbox or a workspace does this
 * at once, and this is for when that failed part way: R2 is listed by workspace and mailbox, and
 * whatever D1 doesn't know any more goes. The mailbox's index goes with it. Each run starts at a
 * random place and goes round, so a server with more mailboxes than one run looks at is still
 * covered over a few days.
 */
export async function sweepRemovedMailboxes(db: Database): Promise<number> {
	const seen: { workspaceId: string; mailboxId: string }[] = [];
	const start = crypto.randomUUID();
	outer: for (const range of [{ startAfter: start }, { upTo: start }]) {
		for await (const workspacePrefix of workspacePrefixes(range)) {
			let cursor: string | undefined;
			do {
				const mailboxes = await env.RAW_MAIL.list({
					prefix: workspacePrefix,
					delimiter: "/",
					cursor,
				});
				for (const mailboxPrefix of mailboxes.delimitedPrefixes) {
					const [workspaceId, mailboxId] = mailboxPrefix.split("/");
					if (workspaceId && mailboxId) seen.push({ workspaceId, mailboxId });
					if (seen.length >= SWEEP_LIMIT) break outer;
				}
				cursor = mailboxes.truncated ? mailboxes.cursor : undefined;
			} while (cursor);
		}
	}

	let removed = 0;
	// D1 takes at most 100 bound parameters in one query.
	for (let at = 0; at < seen.length; at += 90) {
		const chunk = seen.slice(at, at + 90);
		const existing = new Set(
			(
				await db
					.select({ id: schema.mailbox.id })
					.from(schema.mailbox)
					.where(
						inArray(
							schema.mailbox.id,
							chunk.map((one) => one.mailboxId),
						),
					)
					.all()
			).map((row) => row.id),
		);
		for (const one of chunk) {
			if (existing.has(one.mailboxId)) continue;
			await destroyMailbox(one.workspaceId, one.mailboxId);
			removed++;
		}
	}
	return removed;
}
