import { asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { schema } from "../db";
import { keysDone } from "../reseal-state";
import { type SecretsKeySettings, secretsKeys } from "../secrets-key";
import { mailboxStub } from "./store";

export { Mailbox } from "./durable-object";
export {
	type ArrivingMessage,
	type Judge,
	judgedByCloudflare,
	judgedByResend,
	MailboxFullError,
	mailboxStub,
	storeMail,
} from "./store";

/** Where a mailbox's raw mail lives in R2. */
export const mailboxPrefix = (workspaceId: string, mailboxId: string) =>
	`${workspaceId}/${mailboxId}/`;

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
