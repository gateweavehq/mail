/**
 * Incoming mail, from Cloudflare Email Routing.
 *
 * Each message is looked up in the directory. An address that doesn't exist gets a permanent
 * refusal, which tells the sender's server the mailbox is not there (a 555 over SMTP). Mail for an
 * address that does exist is stored in its mailbox (see `mailbox/`), and when that fails it throws,
 * so the sender tries again later.
 *
 * The rules this handler keeps, which the next version must keep too (see AGENTS.md):
 *
 * - It has about 2 seconds of CPU. It looks up and refuses, or stores. It reads no more than the
 *   header block and streams the rest to R2; parsing a message happens when someone opens it.
 * - Delivery is at least once. A slow handler is cancelled after about 5 minutes and run again, and
 *   a sender retries after a temporary refusal, so the same mail twice must change nothing.
 * - A failure of ours is not the sender's fault: let it throw, which tells the sender to try again
 *   (421). `setReject` is permanent (555) and only for a real refusal, such as an address that does
 *   not exist.
 * - Mail is untrusted input. Only `dmarc=pass` in `Authentication-Results` proves who sent it, and a
 *   forged mail can arrive marked `dmarc=none`. `message.from` is the envelope sender, so show the
 *   `From` header.
 */
export const NO_SUCH_ADDRESS = "No such address";

/** The part of Cloudflare's `ForwardableEmailMessage` this handler uses. */
export interface IncomingMessage {
	readonly to: string;
	setReject(reason: string): void;
}

export async function receiveMail<Found>(
	message: IncomingMessage,
	find: (recipient: string) => Promise<Found | null | undefined>,
	store: (found: Found) => Promise<void>,
): Promise<void> {
	const found = await lookUp(message.to, find);
	if (!found) {
		message.setReject(NO_SUCH_ADDRESS);
		return;
	}
	try {
		await store(found);
	} catch (error) {
		// Like a failed lookup, a failed write can quote what it was given.
		console.error("email: storing the message failed", {
			name: error instanceof Error ? error.name : "unknown",
		});
		throw new Error("Storing the message failed");
	}
}

/**
 * A failed query's error quotes its parameters, which here are the recipient, and Workers Logs keeps
 * what `email()` throws. So only the error's name is logged, and a plain error goes on up.
 */
async function lookUp<Found>(
	recipient: string,
	find: (recipient: string) => Promise<Found | null | undefined>,
) {
	try {
		return await find(recipient);
	} catch (error) {
		console.error("email: the directory lookup failed", {
			name: error instanceof Error ? error.name : "unknown",
		});
		throw new Error("The directory lookup failed");
	}
}
