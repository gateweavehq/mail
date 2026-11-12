import type { DeliveryState } from "../../lib/delivery";
import type { Database } from "../db";
import { findAddress } from "../directory";
import { NO_SUCH_ADDRESS } from "../inbound";
import { type Judge, MailboxFullError, type StoringMailbox, storeMail } from "./store";

/**
 * Mail a mailbox sends to addresses this deployment hosts goes straight to their mailboxes, through
 * the storing path `email()` takes (`storeMail`): the same raw mail, kept once, in its thread, told
 * to webhooks and indexed. Out through a provider and back in through MX, it would cost a send and a
 * place in the provider's limits, take seconds, depend on DNS and be scored for spam.
 *
 * Only a message whose every recipient is here goes this way. Email Service and Resend take one
 * list for the headers and the envelope alike, so a message that also goes elsewhere can't leave
 * our own addresses out without taking them out of what the others see; it goes through its
 * provider to everyone, as before.
 *
 * Its sender is proved by this server rather than by DMARC: an address of the sending mailbox, on a
 * domain the directory proved, as the gateway checked when it was written and as each try checks
 * again. So the recipients' copies name that domain as proved, and no DMARC result.
 */

/** Whether this deployment hands mail for its own addresses straight to their mailboxes. */
export const deliversDirectly = (settings: { DIRECT_DELIVERY?: string }) =>
	settings.DIRECT_DELIVERY?.trim().toLowerCase() !== "off";

/** Who sends a message: the address it goes from, and the mailbox and workspace sending it. */
export interface Sender {
	address: string;
	mailboxId: string;
	workspaceId: string;
}

/** Whether the address is still the sending mailbox's own, on a domain the directory proved. */
export async function isOwnSender(db: Database, sender: Sender, now: Date): Promise<boolean> {
	const found = await findAddress(db, sender.address, now);
	return found?.mailboxId === sender.mailboxId && found.workspaceId === sender.workspaceId;
}

/**
 * Whether a message goes straight to mailboxes here: its sender is the mailbox's own, and every
 * address it goes to is a live one here. Throws when D1 doesn't say.
 */
export async function goesDirectly(
	db: Database,
	sender: Sender,
	recipients: string[],
	now: Date,
): Promise<boolean> {
	if (recipients.length === 0 || !(await isOwnSender(db, sender, now))) return false;
	const found = await Promise.all(recipients.map((recipient) => findAddress(db, recipient, now)));
	return found.every(Boolean);
}

/** The domain an address is on, lower case. */
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** Mail from a mailbox here: its domain is proved by the directory, with no DMARC check. */
const provedHere =
	(domain: string): Judge =>
	() => ({ dmarc: null, verifiedDomain: domain });

/** What became of one recipient: stored, or no such address, or to try again. */
export type DirectOutcome =
	| {
			recipient: string;
			state: Extract<DeliveryState, "delivered" | "bounced">;
			detail: string | null;
	  }
	| { recipient: string; state: "full" | "unavailable" };

/** How many recipients are stored for at once. */
const AT_ONCE = 5;

/** How much of the raw mail one read hands over. */
const CHUNK_BYTES = 64 * 1024;

/**
 * The raw mail as a stream that copies a chunk at a time, as it is read. A whole copy for each
 * recipient could take more memory than the object has, with large files and many recipients.
 */
function streamOf(raw: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at >= raw.byteLength) {
				controller.close();
				return;
			}
			controller.enqueue(raw.slice(at, at + CHUNK_BYTES));
			at += CHUNK_BYTES;
		},
	});
}

/**
 * Stores a message's raw mail in the mailbox of each address it goes to, one copy each, as `email()`
 * would. Never throws: what went wrong for a recipient is in its outcome. Storing it again changes
 * nothing for a mailbox that has it, so a try that stopped half way can be tried again.
 */
export async function deliverHere(
	db: Database,
	raw: Uint8Array<ArrayBuffer>,
	sender: string,
	recipients: string[],
	open: (mailboxId: string) => StoringMailbox,
): Promise<DirectOutcome[]> {
	const judge = provedHere(domainOf(sender));
	const one = async (recipient: string): Promise<DirectOutcome> => {
		try {
			const found = await findAddress(db, recipient, new Date());
			if (!found) return { recipient, state: "bounced", detail: NO_SUCH_ADDRESS };
			const message = { from: sender, to: recipient, raw: streamOf(raw), rawSize: raw.byteLength };
			await storeMail(found, message, judge, open);
			return { recipient, state: "delivered", detail: null };
		} catch (error) {
			if (error instanceof MailboxFullError) return { recipient, state: "full" };
			// Its message can quote the address, so only its name is logged.
			console.error("mailbox: storing mail sent to a mailbox here failed", {
				name: error instanceof Error ? error.name : "unknown",
			});
			return { recipient, state: "unavailable" };
		}
	};
	const outcomes: DirectOutcome[] = [];
	for (let at = 0; at < recipients.length; at += AT_ONCE) {
		outcomes.push(...(await Promise.all(recipients.slice(at, at + AT_ONCE).map(one))));
	}
	return outcomes;
}
