/**
 * Checks a webhook delivery signed the way Svix signs them, which is how Resend's webhooks come.
 * The signed content is `<svix-id>.<svix-timestamp>.<body>`, its HMAC-SHA256 under the endpoint's
 * secret (`whsec_` and base64) goes in `svix-signature` as `v1,<base64>`, and a header may carry
 * several, space apart, while a secret is being rolled. See
 * https://docs.svix.com/receiving/verifying-payloads/how-manual.
 */

/** How far a delivery's timestamp may be from now, either way. Svix's own libraries allow 5 minutes. */
export const SVIX_TOLERANCE_MS = 5 * 60 * 1000;

const SECRET_PREFIX = "whsec_";

/** The most signatures one header may hold that are tried: a few, while a secret is rolled. */
const MAX_SIGNATURES = 5;

export interface SvixHeaders {
	id: string | null;
	timestamp: string | null;
	signature: string | null;
}

/** The three headers a signed delivery carries. */
export const svixHeaders = (headers: Headers): SvixHeaders => ({
	id: headers.get("svix-id"),
	timestamp: headers.get("svix-timestamp"),
	signature: headers.get("svix-signature"),
});

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	try {
		const binary = atob(text);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/** Whether a signing secret is one Svix would give. */
export function isSigningSecret(secret: string): boolean {
	return (
		secret.startsWith(SECRET_PREFIX) &&
		(fromBase64(secret.slice(SECRET_PREFIX.length))?.length ?? 0) >= 16
	);
}

/**
 * Whether a delivery was signed with this secret, recently. The body must be the raw text as it
 * came, since the signature is over its bytes. Comparing is left to `crypto.subtle.verify`, which
 * takes the same time whatever the signature holds.
 */
export async function verifySvix(
	secret: string,
	headers: SvixHeaders,
	body: string,
	now = Date.now(),
): Promise<boolean> {
	const { id, timestamp, signature } = headers;
	if (!id || !timestamp || !signature || !isSigningSecret(secret)) return false;
	if (!/^\d{1,12}$/.test(timestamp)) return false;
	if (Math.abs(now - Number(timestamp) * 1000) > SVIX_TOLERANCE_MS) return false;
	const keyBytes = fromBase64(secret.slice(SECRET_PREFIX.length));
	if (!keyBytes) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
	const candidates = signature
		.split(" ")
		.filter((part) => part.startsWith("v1,"))
		.slice(0, MAX_SIGNATURES);
	for (const candidate of candidates) {
		const bytes = fromBase64(candidate.slice(3));
		if (bytes?.length !== 32) continue;
		if (await crypto.subtle.verify("HMAC", key, bytes, signed)) return true;
	}
	return false;
}
