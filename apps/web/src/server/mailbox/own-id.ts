/**
 * Mail's own id for a message a mailbox sends, which goes last in its `References` and which a
 * reply names (see `compose.ts`). It is signed: an HMAC over the mailbox, the id and its domain,
 * under a key HKDF derives from `BETTER_AUTH_SECRET`. So `isOwnId` tells, without looking anything
 * up, an id this deployment gave the mailbox from one a sender made up.
 *
 * That proves where the id came from, not who writes back with it: the id is in the message, so
 * anyone it reached, a forward or a list archive included, can name it. Whatever acts on "this
 * answers what the mailbox sent" also asks who is answering, such as by the domain the reply was
 * proved to come from.
 *
 * Threading never needs the signature: it matches ids as they are, so ids sent before they were
 * signed, or under a `BETTER_AUTH_SECRET` since changed, still keep their threads. Only `isOwnId`
 * asks, and it says no to those.
 */
import { toBase64 } from "../secrets";

const SALT = new TextEncoder().encode("gateweave-mail/own-id/v1");
/** 128 bits: enough that a guess never passes, short enough to leave room in `References`. */
const SIGNATURE_BYTES = 16;
const SIGNED =
	/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{22})@([^@\s<>]+)$/;

/** The key for the deployment's `BETTER_AUTH_SECRET`, made once for the isolate. */
let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

function signingKey(secret: string): Promise<CryptoKey> {
	// The Worker answers nothing without one (`server.ts`), so this is only ever a mistake.
	if (!secret) throw new Error("own-id: BETTER_AUTH_SECRET isn't set");
	if (!cached || cached.secret !== secret) {
		const encoder = new TextEncoder();
		const made: { secret: string; key: Promise<CryptoKey> } = {
			secret,
			key: crypto.subtle
				.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
				.then((base) =>
					crypto.subtle.deriveKey(
						{ name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode("message ids") },
						base,
						{ name: "HMAC", hash: "SHA-256", length: 256 },
						false,
						["sign"],
					),
				)
				.catch((error: unknown) => {
					// Not kept, so the next message tries again.
					if (cached === made) cached = null;
					throw error;
				}),
		};
		cached = made;
	}
	return cached.key;
}

async function signature(
	secret: string,
	mailboxId: string,
	id: string,
	domain: string,
): Promise<string> {
	const mac = await crypto.subtle.sign(
		"HMAC",
		await signingKey(secret),
		new TextEncoder().encode(`${mailboxId}\n${id}\n${domain.toLowerCase()}`),
	);
	return toBase64(new Uint8Array(mac).subarray(0, SIGNATURE_BYTES));
}

/**
 * A new id for a message the mailbox sends, on the domain it is sent from, without angle
 * brackets: `<uuid>.<signature>@<domain>`.
 */
export async function newOwnId(
	secret: string,
	mailboxId: string,
	fromEmail: string,
): Promise<string> {
	const domain = fromEmail.slice(fromEmail.lastIndexOf("@") + 1);
	const id = crypto.randomUUID();
	return `${id}.${await signature(secret, mailboxId, id, domain)}@${domain}`;
}

/**
 * Whether an id, with or without angle brackets, is one this deployment gave a message that this
 * mailbox sent. For what acts on a reply as answering the mailbox's own mail; threading doesn't
 * ask.
 */
export async function isOwnId(secret: string, mailboxId: string, id: string): Promise<boolean> {
	const found = SIGNED.exec(id.replace(/^<(.*)>$/, "$1"));
	if (!found) return false;
	const [, uuid = "", given = "", domain = ""] = found;
	const expected = await signature(secret, mailboxId, uuid, domain);
	// Every character is compared, so how long it takes says nothing of where they differ.
	let difference = 0;
	for (let at = 0; at < expected.length; at++) {
		difference |= expected.charCodeAt(at) ^ given.charCodeAt(at);
	}
	return difference === 0;
}
