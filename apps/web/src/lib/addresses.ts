/** A DNS label: letters, digits and inner hyphens. An internationalized name is kept as `xn--`. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** `bücher.example` as DNS knows it, `xn--bcher-kva.example`. A URL's rules do the conversion. */
function toAscii(name: string): string | null {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the whole ASCII range.
	if (/^[\x00-\x7f]*$/.test(name)) return name;
	if (/[\s/:?#@\\[\]]/.test(name)) return null;
	try {
		return new URL(`http://${name}`).hostname;
	} catch {
		return null;
	}
}

/** A domain's name as stored, or null when it isn't one. Takes what someone would paste. */
export function parseDomainName(input: string): string | null {
	const name = toAscii(input.trim().toLowerCase().replace(/\.$/, ""));
	if (name === null || name.length > 253) return null;
	const labels = name.split(".");
	if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
	// All digits at the end is an IP address, and no top-level domain looks like that.
	return /^\d+$/.test(labels[labels.length - 1] ?? "") ? null : name;
}

/**
 * The part before the `@` as stored, or null when it isn't one we make. `+` is left out because
 * nothing reads it as a tag yet, so an address with one would only be refused later.
 */
export function parseLocalPart(input: string): string | null {
	const part = input.trim().toLowerCase();
	return LOCAL_PART.test(part) && !part.includes("..") ? part : null;
}

/** Splits the address a message was sent to, for looking it up. It need not be one we'd make. */
export function splitRecipient(recipient: string): { localPart: string; domain: string } | null {
	const address = recipient.trim().toLowerCase();
	const at = address.lastIndexOf("@");
	if (at <= 0 || at === address.length - 1) return null;
	return { localPart: address.slice(0, at), domain: address.slice(at + 1) };
}
