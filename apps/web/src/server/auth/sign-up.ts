import { and, eq, gt } from "drizzle-orm";
import { type AllowList, isListed, SIGN_UP_CLOSED_MESSAGE } from "../../lib/sign-up-allow";
import type { Database } from "../db";
import { schema } from "../db";

// "Who may make an account" in docs/architecture.md. A deployment that sets `SIGN_UP_ALLOW` takes
// new accounts only for the addresses it lists and the ones a workspace has invited.

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
 * Whether this address may have a new account. Without a list, any may. With one, the list counts
 * only for a proved address: a typed one would let anyone who knows or guesses a listed address,
 * or makes one up at a listed domain, in ahead of its owner. A pending invitation to a workspace
 * lets its address in either way, as it did before there was a list: an admin named that one
 * address, and joining still wants it verified wherever email is on.
 *
 * It says nothing about an address that has an account already, so what asks before Better Auth
 * has looked must ask that itself (`mayTypeAccount`).
 */
export async function mayMakeAccount(
	db: Database,
	list: AllowList | null,
	{ email, proved }: NewAccount,
): Promise<boolean> {
	if (!list) return true;
	if (proved && isListed(list, email)) return true;
	return hasPendingInvitation(db, email);
}

/**
 * Whether the sign-up form may make an account for this address on a server with a list: only an
 * invited one that has none. An address with an account gets the answer of one that was never
 * invited, so that the form cannot be used to ask who is here.
 */
export async function mayTypeAccount(db: Database, list: AllowList, email: string) {
	if (!(await mayMakeAccount(db, list, { email, proved: false }))) return false;
	const taken = await db
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, email.toLowerCase()))
		.get();
	return !taken;
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
