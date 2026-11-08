// Ported from Gateweave Agents (packages/registry/src/secrets.ts), with Mail's own salt.

/**
 * Secrets Mail keeps for a workspace, such as its Resend key. Each is encrypted with AES-256-GCM
 * under a key that HKDF derives from the deployment's `SECRETS_KEY` and the workspace's id, so one
 * workspace's rows cannot be opened with another's key. The additional data names the secret's
 * place, so a sealed value copied into another row does not open there.
 *
 * Secrets sealed with a `SECRETS_KEY` are lost if it changes. Sealed values start with a version,
 * so a later scheme (or a second key, for rotation) can sit beside this one.
 */

export interface Sealer {
	seal(place: string, plaintext: string): Promise<string>;
	/** Throws when the value was sealed elsewhere, under another key, or was changed. */
	open(place: string, sealed: string): Promise<string>;
}

const VERSION = "v1";
const SALT = new TextEncoder().encode("gateweave-mail/secrets/v1");
const MIN_KEY_BYTES = 32;

/** A sealer for one workspace, or why this deployment cannot keep secrets. */
export async function sealerFor(
	secretsKey: string | undefined,
	scope: string,
): Promise<Sealer | { unavailable: string }> {
	const secret = secretsKey ? fromBase64(secretsKey) : null;
	if (!secret) return { unavailable: "This server has no SECRETS_KEY, so it can't keep keys." };
	if (secret.length < MIN_KEY_BYTES) {
		return { unavailable: `This server's SECRETS_KEY is shorter than ${MIN_KEY_BYTES} bytes.` };
	}
	const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
	const key = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(scope) },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
	return {
		async seal(place, plaintext) {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const sealed = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(place) },
				key,
				new TextEncoder().encode(plaintext),
			);
			return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
		},
		async open(place, sealed) {
			const [version, iv, data] = sealed.split(".");
			const ivBytes = iv ? fromBase64(iv) : null;
			const dataBytes = data ? fromBase64(data) : null;
			if (version !== VERSION || !ivBytes || !dataBytes) throw new Error("Not a sealed secret");
			try {
				const plaintext = await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv: ivBytes, additionalData: new TextEncoder().encode(place) },
					key,
					dataBytes,
				);
				return new TextDecoder().decode(plaintext);
			} catch {
				// WebCrypto's own error says nothing useful, and nothing about the secret should leak.
				throw new Error("A secret could not be opened");
			}
		},
	};
}

/** Whether this is a sealer rather than the reason there is none. */
export const isSealer = (value: Sealer | { unavailable: string }): value is Sealer =>
	!("unavailable" in value);

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Standard or URL-safe base64, padded or not; null when it is not base64. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	const standard = text.trim().replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
	if (!/^[A-Za-z0-9+/]*$/.test(standard)) return null;
	try {
		const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}
