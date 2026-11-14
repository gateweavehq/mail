import { fromBase64, toBase64 } from "./base64";

/**
 * The deployment's `SECRETS_KEY`, which seals workspaces' secrets in D1, their webhooks' signing
 * secrets in the webhooks objects and raw mail in R2, and the one it replaced,
 * `SECRETS_KEY_PREVIOUS`, which only opens what is still sealed under it until that is sealed again
 * under the new one. Each key has an id that what it seals carries, so a seal
 * says which key opens it, and what is not yet under the current one can be found. The id is a
 * keyed digest of the key, which says nothing of the key itself.
 */

/** The settings that hold the keys, as the Worker's `env` has them. */
export interface SecretsKeySettings {
	SECRETS_KEY?: string | undefined;
	SECRETS_KEY_PREVIOUS?: string | undefined;
}

export interface SecretsKey {
	/** 11 characters of URL-safe base64, never a dot. */
	id: string;
	/** The key, for HKDF to derive each use's own key from. */
	hkdf: CryptoKey;
}

export interface SecretsKeys {
	/** Seals, and opens. Null when the deployment has no usable `SECRETS_KEY`. */
	current: SecretsKey | null;
	/** Only opens. Null when unset, unusable, or the same key as the current one. */
	previous: SecretsKey | null;
}

/** How long a key must be, in bytes. */
export const MIN_KEY_BYTES = 32;

/** The bytes of a key long enough to seal with, or null. */
export function usableKey(text: string | undefined): Uint8Array<ArrayBuffer> | null {
	const bytes = text ? fromBase64(text) : null;
	return bytes && bytes.length >= MIN_KEY_BYTES ? bytes : null;
}

/** Whether this deployment seals: it has a current key long enough to. */
export const canSealWith = (settings: SecretsKeySettings) =>
	usableKey(settings.SECRETS_KEY) !== null;

const ID_INFO = new TextEncoder().encode("gateweave-mail/key-id");

/** Each key's id and HKDF key, made once for the isolate. */
const made = new Map<string, Promise<SecretsKey>>();

function keyOf(text: string | undefined): Promise<SecretsKey> | null {
	const bytes = usableKey(text);
	if (!text || !bytes) return null;
	let key = made.get(text);
	if (!key) {
		key = (async () => {
			const mac = await crypto.subtle.importKey(
				"raw",
				bytes,
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const digest = new Uint8Array(await crypto.subtle.sign("HMAC", mac, ID_INFO));
			return {
				id: toBase64(digest.subarray(0, 8)),
				hkdf: await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]),
			};
		})();
		// Settings change only with a deploy, which starts a new isolate; this holds one or two.
		made.set(text, key);
	}
	return key;
}

/** The deployment's keys. */
export async function secretsKeys(settings: SecretsKeySettings): Promise<SecretsKeys> {
	const [current, previous] = await Promise.all([
		keyOf(settings.SECRETS_KEY),
		keyOf(settings.SECRETS_KEY_PREVIOUS),
	]);
	return {
		current: current ?? null,
		previous: previous && previous.id !== current?.id ? previous : null,
	};
}

/**
 * The key a seal with this id opens with, or null when the deployment has neither. A seal with no
 * id, from before keys had them, may be under either: those are tried in turn, the current first.
 */
export function keysFor(keys: SecretsKeys, id: string | null): SecretsKey[] {
	const all = [keys.current, keys.previous].filter((key): key is SecretsKey => key !== null);
	return id === null ? all : all.filter((key) => key.id === id);
}
