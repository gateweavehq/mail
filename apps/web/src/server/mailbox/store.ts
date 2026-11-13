import { env } from "cloudflare:workers";
import type { Arrival, Begun } from "./durable-object";
import {
	cloudflareVerdict,
	deliveryKey,
	firstHeader,
	type Header,
	parseHeaders,
	readHeaderBlock,
	resendVerifiedDomain,
	signedAddressees,
	verifiedDomain,
} from "./headers";
import { rawMail } from "./sealed";
import { ownId, referencedIds } from "./thread";

/** The mailbox's own instance. Only the Worker reaches it, after checking who is asking. */
export function mailboxStub(mailboxId: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

/** What storing asks of the mailbox a message is for: its stub, or the object itself. */
export interface StoringMailbox {
	begin(arrival: Arrival): Promise<Begun>;
	finish(id: string): Promise<"stored" | "duplicate" | "gone">;
}

/** What `email()` gets from Cloudflare, or a delivery from Resend, as far as storing goes. */
export interface ArrivingMessage {
	readonly from: string;
	readonly to: string;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
}

/**
 * What proves who sent a message to an address (`recipient`): a DMARC result, the domain it proves
 * the mail came from, and whether that sender is proved to have addressed it to the recipient.
 */
export type Judge = (
	headers: Header[],
	recipient: string,
) => { dmarc: string | null; verifiedDomain: string | null; addressed: boolean };

/**
 * For mail from Email Routing: Cloudflare's own `Authentication-Results`, in its own place, and the
 * signed `To` and `Cc` it vouches for (`signedAddressees`).
 */
export const judgedByCloudflare: Judge = (headers, recipient) => {
	const verdict = cloudflareVerdict(headers);
	const domain = verifiedDomain(headers, verdict);
	return {
		dmarc: verdict?.dmarc ?? null,
		verifiedDomain: domain,
		addressed: signedAddressees(headers, domain).includes(recipient.trim().toLowerCase()),
	};
};

/**
 * For mail that came through Resend: the DMARC result its API gives, which its MX computed, for
 * the From it read (`from`). Nothing in the mail itself counts, as a sender can write anything
 * there, Cloudflare's headers too. Its API says no more of DKIM than DMARC's result, so no recipient
 * is proved addressed.
 */
export const judgedByResend =
	(dmarc: string | null, from: string | null): Judge =>
	(headers) => ({
		dmarc,
		verifiedDomain: resendVerifiedDomain(headers, dmarc, from),
		addressed: false,
	});

/** The mailbox has no room for the message, which may change by the time the sender tries again. */
export class MailboxFullError extends Error {
	override name = "MailboxFullError";
	constructor() {
		super("The mailbox is full");
	}
}

/**
 * Stores a message for a mailbox the directory found. The header block is read from the start of
 * the raw mail, and the whole of it streams into R2, sealed when the deployment has a
 * `SECRETS_KEY`, without being held in memory. Anything that goes wrong throws, which tells the
 * sender to try again.
 *
 * `open` reaches the mailbox: its stub, unless a mailbox stores mail it sends to itself.
 */
export async function storeMail(
	found: { workspaceId: string; mailboxId: string; agentMemberId?: string | null },
	message: ArrivingMessage,
	judge: Judge = judgedByCloudflare,
	open: (mailboxId: string) => StoringMailbox = mailboxStub,
): Promise<void> {
	const [forHeaders, forStoring] = message.raw.tee();
	const headers = parseHeaders(await readHeaderBlock(forHeaders));
	const judged = judge(headers, message.to);
	const mailbox = open(found.mailboxId);
	const raw = rawMail(env);
	const begun = await mailbox.begin({
		workspaceId: found.workspaceId,
		mailboxId: found.mailboxId,
		key: await deliveryKey(found.mailboxId, headers),
		size: message.rawSize,
		envelopeFrom: message.from,
		envelopeTo: message.to,
		from: firstHeader(headers, "from"),
		subject: firstHeader(headers, "subject"),
		date: firstHeader(headers, "date"),
		messageId: firstHeader(headers, "message-id"),
		ownId: ownId(headers),
		references: referencedIds(headers),
		dmarc: judged.dmarc,
		verifiedDomain: judged.verifiedDomain,
		addressed: judged.addressed,
		cameFor: found.agentMemberId ?? null,
		seal: await raw.newSeal(),
	});
	if (!begun.ok) {
		await forStoring.cancel();
		// Temporary on purpose: the mailbox may have room again by the time the sender retries.
		throw new MailboxFullError();
	}
	// Sealed as the mailbox kept it: an object older than sealing keeps no seal, and says none.
	await raw.put(
		{ object: begun.object, size: message.rawSize, seal: begun.seal ?? null },
		forStoring,
	);
	if ((await mailbox.finish(begun.id)) === "gone") {
		// The alarm or a removal let this delivery go while it was on its way, and nothing knows its
		// mail now. The sender tries again.
		await env.RAW_MAIL.delete(begun.object).catch(() => {});
		throw new Error("The mailbox gave up on this delivery");
	}
}
