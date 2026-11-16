/**
 * Who may make an account, from the `SIGN_UP_ALLOW` setting: whole addresses (`ada@example.com`)
 * and domains with an `@` in front (`@example.com`), separated by commas or spaces. A domain
 * covers addresses at exactly that domain, never at its subdomains or at a name that only ends
 * or begins the same way.
 */
export interface AllowList {
	addresses: ReadonlySet<string>;
	domains: ReadonlySet<string>;
	/** How many entries were neither, for the one who runs the server to be told of. */
	ignored: number;
}

/** Whether a list names nobody at all, so that only invited addresses get in. */
export function namesNobody(list: AllowList): boolean {
	return list.addresses.size === 0 && list.domains.size === 0;
}

/**
 * What every refused address is told, on the sign-in page and by the server alike, so that the
 * words say nothing about any one address.
 */
export const SIGN_UP_CLOSED_MESSAGE =
	"This server takes new accounts by invitation. If you already have an account, sign in.";

const ADDRESS = /^[^@\s]+@[^@\s]+$/;
const DOMAIN = /^@[^@\s]+$/;

/**
 * The list a deployment set, or null when it set none and anyone may sign up. Only a setting that
 * is not there at all is none. One that is there with nothing usable in it, the empty text and
 * separators alone included, is a list of nobody: a setting someone emptied, or mistyped, must
 * not open the server.
 */
export function parseAllowList(setting: string | null | undefined): AllowList | null {
	if (setting === undefined || setting === null) return null;
	const entries = String(setting)
		.split(/[\s,]+/)
		.map((entry) => entry.toLowerCase())
		.filter(Boolean);
	const addresses = new Set<string>();
	const domains = new Set<string>();
	let ignored = 0;
	for (const entry of entries) {
		if (ADDRESS.test(entry)) addresses.add(entry);
		else if (DOMAIN.test(entry)) domains.add(entry.slice(1));
		else ignored += 1;
	}
	return { addresses, domains, ignored };
}

/**
 * Whether the list names this address, itself or by its domain. Both are compared whole and in
 * lowercase, which is also how an account's address is stored.
 */
export function isListed(list: AllowList, email: string): boolean {
	const address = email.toLowerCase();
	const at = address.lastIndexOf("@");
	if (at <= 0 || at === address.length - 1) return false;
	return list.addresses.has(address) || list.domains.has(address.slice(at + 1));
}
