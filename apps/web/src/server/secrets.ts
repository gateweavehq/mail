// Ported from Gateweave Agents (packages/registry/src/secrets.ts), with Mail's own salt.
import { fromBase64, toBase64 } from "./base64";
import {
	keysFor,
	MIN_KEY_BYTES,
	type SecretsKey,
	type SecretsKeySettings,
	secretsKeys,
} from "./secrets-key";

export { fromBase64, toBase64 };

/**
 * Secrets Mail keeps for a workspace, such as its Resend key. Each is encrypted with AES-256-GCM
 * under a key that HKDF derives from the deployment's `SECRETS_KEY` and the workspace's id, so one
 * workspace's rows cannot be opened with another's key. The additional data names the secret's
 * place, so a sealed value copied into another row does not open there.
 *
 * A sealed value names the key it was sealed with (`v2.<key id>.<iv>.<data>`). One sealed before
 * keys had ids (`v1.<iv>.<data>`) is opened with the current key or the previous one. After the
 * key changes, with the old one kept as `SECRETS_KEY_PREVIOUS`, the daily run seals each value
 * again under the new key (`reseal-secrets.ts`). Secrets under a key the deployment no longer has
 * are lost.
 */

export interface Sealer {
	seal(place: string, plaintext: string): Promise<string>;
	/** Throws when the value was sealed elsewhere, under another key, or was changed. */
	open(place: string, sealed: string): Promise<string>;
	/** Whether a sealed value is already under the current key, so needs no sealing again. */
	isCurrent(sealed: string): boolean;
}

const SALT = new TextEncoder().encode("gateweave-mail/secrets/v1");

/** The key for one workspace's secrets, from one of the deployment's keys. */
function scopedKey(key: SecretsKey, scope: string): Promise<CryptoKey> {
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(scope) },
		key.hkdf,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** A sealed value's parts, or null when it is no sealed value this server knows. */
function parse(
	sealed: string,
): { id: string | null; iv: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> } | null {
	const parts = sealed.split(".");
	const [version] = parts;
	const [id, iv, data] =
		version === "v2" && parts.length === 4
			? [parts[1] ?? null, parts[2], parts[3]]
			: version === "v1" && parts.length === 3
				? [null, parts[1], parts[2]]
				: [];
	const ivBytes = iv ? fromBase64(iv) : null;
	const dataBytes = data ? fromBase64(data) : null;
	if (!ivBytes || !dataBytes || (version === "v2" && !id)) return null;
	return { id: id ?? null, iv: ivBytes, data: dataBytes };
}

/** A sealer for one workspace, or why this deployment cannot keep secrets. */
export async function sealerFor(
	settings: SecretsKeySettings,
	scope: string,
): Promise<Sealer | { unavailable: string }> {
	if (!settings.SECRETS_KEY) {
		return { unavailable: "This server has no SECRETS_KEY, so it can't keep keys." };
	}
	const keys = await secretsKeys(settings);
	const current = keys.current;
	if (!current) {
		return { unavailable: `This server's SECRETS_KEY is shorter than ${MIN_KEY_BYTES} bytes.` };
	}
	const sealing = scopedKey(current, scope);
	return {
		async seal(place, plaintext) {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const sealed = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(place) },
				await sealing,
				new TextEncoder().encode(plaintext),
			);
			return `v2.${current.id}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
		},
		async open(place, sealed) {
			const parts = parse(sealed);
			if (!parts) throw new Error("Not a sealed secret");
			for (const key of keysFor(keys, parts.id)) {
				try {
					const plaintext = await crypto.subtle.decrypt(
						{ name: "AES-GCM", iv: parts.iv, additionalData: new TextEncoder().encode(place) },
						await scopedKey(key, scope),
						parts.data,
					);
					return new TextDecoder().decode(plaintext);
				} catch {
					// Another key may open it, when its seal doesn't say which.
				}
			}
			// WebCrypto's own error says nothing useful, and nothing about the secret should leak.
			throw new Error("A secret could not be opened");
		},
		isCurrent: (sealed) => sealed.startsWith(`v2.${current.id}.`),
	};
}

/** Whether this is a sealer rather than the reason there is none. */
export const isSealer = (value: Sealer | { unavailable: string }): value is Sealer =>
	!("unavailable" in value);
