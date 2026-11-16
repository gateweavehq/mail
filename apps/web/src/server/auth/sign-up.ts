import { and, eq, gt } from "drizzle-orm";
import { type AllowList, isListed, SIGN_UP_CLOSED_MESSAGE } from "../../lib/sign-up-allow";
import type { Database } from "../db";
import { schema } from "../db";

// "Who may make an account" in docs/architecture.md. A deployment that sets `SIGN_UP_ALLOW` takes
// new accounts only for addresses a sign-in provider proved: the ones it lists, and the ones a
// workspace has invited.

/** The answer to every address that is refused, so that it says nothing about any one of them. */
export const SIGN_UP_CLOSED = { code: "SIGN_UP_CLOSED", message: SIGN_UP_CLOSED_MESSAGE };

/** An address that wants an account, and whether a sign-in provider says it is this person's. */
export interface NewAccount {
	email: string;
	/**
	 * True only for an address GitHub or the OpenID Connect provider reports as verified. One
	 * typed into the sign-up form proves nothing, whoever typed it.
	 */
	proved: boolean;
}

/**
 * Whether this address may have a new account. Without a list, any may. With one, only a proved
 * address may, and only one the list names or a workspace has a pending invitation for.
 *
 * A typed address never may, listed or invited: the account would exist, with a session, before
 * anything showed whose address it is. Whoever knew or guessed a listed or invited address, or
 * made one up at a listed domain, would get in ahead of its owner, and could then make a
 * workspace and invite the next address the same way.
 */
export async function mayMakeAccount(
	db: Database,
	list: AllowList | null,
	{ email, proved }: NewAccount,
): Promise<boolean> {
	if (!list) return true;
	if (!proved) return false;
	return isListed(list, email) || hasPendingInvitation(db, email);
}

/** The organization plugin stores an invitation's address in lowercase, as accounts' are. */
async function hasPendingInvitation(db: Database, email: string) {
	const { invitation } = schema;
	const pending = await db
		.select({ id: invitation.id })
		.from(invitation)
		.where(
			and(
				eq(invitation.email, email.toLowerCase()),
				eq(invitation.status, "pending"),
				gt(invitation.expiresAt, new Date()),
			),
		)
		.get();
	return pending !== undefined;
}
