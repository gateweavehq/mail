import { eq } from "drizzle-orm";
import type { Database } from "./db";
import { schema } from "./db";

/**
 * What D1 knows of each mailbox's mail after `SECRETS_KEY` changed (`mailbox.sealed_under`): the
 * current and previous keys' ids with which the mailbox last said it held nothing that needs the
 * previous key. Naming both means that setting another `SECRETS_KEY_PREVIOUS`, as after a wrong
 * one, has every mailbox asked again.
 */
export const keysDone = (current: string, previous: string) => `${current}.${previous}`;

/** Notes that a mailbox holds mail under another key than the current one, so it is asked again. */
export async function sealedUnderUnknown(db: Database, mailboxId: string): Promise<void> {
	await db
		.update(schema.mailbox)
		.set({ sealedUnder: null })
		.where(eq(schema.mailbox.id, mailboxId))
		.run();
}
