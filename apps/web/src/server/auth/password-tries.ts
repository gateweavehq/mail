import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { Mailer } from "../email/mailer";
import { passwordTriesSpentEmail } from "../email/templates";
import { DELETE_ACCOUNT } from "./delete-account";

/** Where someone with a session shows a password, and what the request calls it. */
const PASSWORD_FIELDS: Record<string, string> = {
	[DELETE_ACCOUNT]: "password",
	"/change-password": "currentPassword",
};

const TOO_MANY_TRIES = {
	code: "TOO_MANY_PASSWORD_TRIES",
	message: "Too many tries at your password lately. Try again later.",
};

interface Person {
	id: string;
	email: string;
	emailVerified: boolean;
}

/**
 * Emails someone whose allowance has run out, which may be the first they hear of someone else
 * holding a copy of their session, and spending it keeps them from changing their password. Only at
 * an address they have shown is theirs, since anyone can sign up with a stranger's and have this
 * sent there. Resolves either way: the request is refused whatever becomes of the email.
 *
 * The day's email is counted before it is sent, so requests sent together send one, and one that
 * fails is not tried again until the next day. Counting after would let whoever holds the cookie use
 * up what an address may be sent, which a password reset needs.
 */
export async function tellOfSpentTries(
	{ id, email, emailVerified }: Person,
	mailer: Mailer | undefined,
	allowEmail: ((userId: string) => Promise<boolean>) | undefined,
) {
	if (!mailer || !allowEmail || !emailVerified) return;
	try {
		if (await allowEmail(id)) {
			await mailer.send({ to: email, ...passwordTriesSpentEmail({ email }) });
		}
	} catch (error) {
		const kind = error instanceof Error ? error.name : "unknown";
		console.warn(`could not send the email about spent password tries: ${kind}`);
	}
}

/**
 * Better Auth counts per client address, and a stolen cookie can be sent from many, so these paths
 * also share an allowance per person. It is spent before the password is checked, because spending
 * it after would let requests sent together all through.
 *
 * Only someone with a session for that account can spend it, so nobody can lock a person out with
 * their address alone, which is why signing in is not part of it. Whoever holds the cookie can spend
 * it, but a password reset asks for no session, and signing out everywhere asks for no password.
 */
export function passwordTries(
	allow: (userId: string) => Promise<boolean>,
	tell: (person: Person) => Promise<void>,
) {
	return {
		id: "password-tries",
		hooks: {
			before: [
				{
					matcher: ({ path = "" }) => path in PASSWORD_FIELDS,
					handler: createAuthMiddleware(async (ctx) => {
						const field = PASSWORD_FIELDS[ctx.path];
						// A request with no password to check is no guess at one.
						if (!field || typeof ctx.body?.[field] !== "string") return;
						// Someone with no session gets the route's answer.
						const session = await getSessionFromCtx(ctx);
						if (session && !(await allow(session.user.id))) {
							// The refusal does not wait, or how long it took would say whether an email went out.
							await ctx.context.runInBackgroundOrAwait(tell(session.user));
							throw APIError.from("TOO_MANY_REQUESTS", TOO_MANY_TRIES);
						}
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
