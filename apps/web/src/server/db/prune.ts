import { type Column, inArray, lt } from "drizzle-orm";
import { ENDED_ADDRESS_KEPT_DAYS } from "../directory";
import type { Database } from "./index";
import { schema } from "./index";

/** D1 runs one query at a time, so one long delete would hold up everyone signing in. */
const BATCH = 1000;

async function pruneOlder(
	db: Database,
	table:
		| typeof schema.session
		| typeof schema.verification
		| typeof schema.invitation
		| typeof schema.mailAddress
		| typeof schema.mailSuppression,
	column: Column,
	before: Date,
) {
	for (;;) {
		const expired = db.select({ id: table.id }).from(table).where(lt(column, before)).limit(BATCH);
		const { meta } = await db.delete(table).where(inArray(table.id, expired)).run();
		if (meta.changes < BATCH) return;
	}
}

/**
 * Deletes what is past its time. Better Auth removes a session or a verification only when something
 * looks it up, so those nobody comes back for would otherwise stay forever: a session holds the
 * address and browser it came from, a verification an abandoned sign-up's code, and an invitation an
 * address that may never have had anything to do with this deployment. The privacy policy states
 * these, so a change here is a change to it. An address that has ended waits a while first, so that
 * its name doesn't pass to someone else while what it signed up for still writes to it. A
 * suppression that has ended goes at once: it names someone the workspace wrote to, and no longer
 * stops anything.
 */
export async function pruneExpired(db: Database): Promise<void> {
	const now = new Date();
	await pruneOlder(db, schema.session, schema.session.expiresAt, now);
	await pruneOlder(db, schema.verification, schema.verification.expiresAt, now);
	await pruneOlder(db, schema.invitation, schema.invitation.expiresAt, now);
	await pruneOlder(
		db,
		schema.mailAddress,
		schema.mailAddress.expiresAt,
		new Date(now.getTime() - ENDED_ADDRESS_KEPT_DAYS * 24 * 60 * 60 * 1000),
	);
	await pruneOlder(db, schema.mailSuppression, schema.mailSuppression.expiresAt, now);
}
