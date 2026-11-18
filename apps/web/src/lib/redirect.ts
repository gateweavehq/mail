const BASE = "http://mail.invalid";

/**
 * A same-origin path to go to after signing in, or null if `value` is not one. Absolute and
 * protocol-relative URLs are refused, so the login page cannot send people to another site.
 */
export function safeRedirect(value: string | null | undefined): string | null {
	if (!value?.startsWith("/")) return null;
	try {
		const url = new URL(value, BASE);
		if (url.origin !== BASE) return null;
		// Dot segments are resolved after the origin check: "/.//example.com" is on this origin, but
		// its path is "//example.com", which a browser reads as another site.
		const path = url.pathname + url.search + url.hash;
		return path.startsWith("//") || path.startsWith("/\\") ? null : path;
	} catch {
		return null;
	}
}
