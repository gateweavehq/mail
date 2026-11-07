import { APIError } from "better-auth/api";
import { z } from "zod";
import type { Mailer } from "../email/mailer";
import { passwordChangedEmail } from "../email/templates";

// The account page changes a name and a password through Better Auth's own routes, and what stands
// behind each may be a stolen cookie. See "Changing a name or password" in docs/architecture.md.

const name = z.string().trim().min(1).max(100);

const INVALID_NAME = {
	code: "INVALID_NAME",
	message: "Enter a name of at most 100 characters.",
};

/** A name as Mail keeps it. Refuses one nobody could show beside what they do. */
export function validName(value: unknown): string {
	const parsed = name.safeParse(value);
	if (!parsed.success) throw APIError.from("BAD_REQUEST", INVALID_NAME);
	return parsed.data;
}

const rename = z.strictObject({ name });

/**
 * What `/update-user` may do. It would also set a picture, whose address everyone in someone's
 * workspaces fetches, so whoever chose it would learn who is looking and from where.
 */
export function validRename(body: unknown): { name: string } {
	const parsed = rename.safeParse(body);
	if (!parsed.success) throw APIError.from("BAD_REQUEST", INVALID_NAME);
	return parsed.data;
}

/** What `/change-password` answers with once it has worked, and an error is not. */
const passwordChanged = z.object({ user: z.object({ email: z.string() }) });

/**
 * Emails the person about a password that has just changed, which may be the first they hear of
 * someone else holding it. Resolves either way: the password has changed by now, so a failed email
 * must not say otherwise.
 */
export async function tellOfChangedPassword(returned: unknown, mailer: Mailer | undefined) {
	const changed = passwordChanged.safeParse(returned);
	if (!changed.success || !mailer) return;
	const { email } = changed.data.user;
	await mailer.send({ to: email, ...passwordChangedEmail({ email }) }).catch((error: unknown) => {
		const kind = error instanceof Error ? error.name : "unknown";
		console.warn(`could not send the email about a changed password: ${kind}`);
	});
}
