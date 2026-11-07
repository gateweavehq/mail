const REFUSALS: Record<string, string> = {
	access_denied: "You chose not to sign in that way.",
	account_not_linked:
		"This address already has an account here, and we could not confirm it is yours. Sign in with your password. If you have not verified the address yet, do that first.",
	email_not_found: "We were not given an email address for you, and an account needs one.",
};

/**
 * What to tell someone whose sign-in through GitHub or another provider came back with this code.
 * Only ever words of ours, and never the `error_description` beside it: anyone can make a link, and
 * it would put their text on the sign-in page.
 */
export function signInRefusal(code: string | undefined): string | null {
	if (!code) return null;
	return Object.hasOwn(REFUSALS, code)
		? (REFUSALS[code] ?? null)
		: "That way of signing in did not work. Try again, or use your password.";
}
