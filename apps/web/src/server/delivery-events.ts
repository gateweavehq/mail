import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { DELIVERY_STATES, type DeliveryState, MAX_DELIVERY_DETAIL } from "../lib/delivery";
import { type Database, schema } from "./db";
import type { DeliveryEvent } from "./mailbox/deliveries";

/**
 * Email Service's delivery events, which reach Mail through a Queue: each domain that sends has an
 * event subscription that publishes to it (see docs/self-hosting.md). An event names the message by
 * the id `send()` gave, which the mailbox kept, and the mailbox by the address it was sent from.
 *
 * Only the deployment's own account can publish to its queue, but what an event says is still
 * checked as data: the address must be on a domain a workspace proved, which is also the domain the
 * event came from, and remote text is cut short.
 */

/** The prefix of an Email Sending event's type, before the state. */
const TYPE_PREFIX = "cf.email.sending.message.";

/** How long after an event Mail keeps looking for a message it doesn't find yet. */
export const FIND_WINDOW_MS = 10 * 60 * 1000;

/** How long to wait before looking again for a message not found yet, or after a failure. */
export const RETRY_DELAY_SECONDS = 60;

/** How many local parts one D1 query asks for, as D1 binds at most 100 values. */
const LOOKUP_CHUNK = 50;

/** Text fields of an event's parts, any of which may be missing. */
const Part = z.record(z.string(), z.unknown()).optional().catch(undefined);

const EmailSendingEvent = z.object({
	type: z.string().max(100),
	source: z.object({ type: z.literal("email.sending"), domain: z.string().min(1).max(253) }),
	metadata: z
		.object({ eventTimestamp: z.string().max(64).optional() })
		.optional()
		.catch(undefined),
	payload: z.object({
		messageId: z.string().min(1).max(998),
		sender: z.string().min(3).max(320),
		recipient: z.string().min(3).max(320),
		delivery: Part,
		bounce: Part,
		failure: Part,
		rejection: Part,
	}),
});

type Payload = z.infer<typeof EmailSendingEvent>["payload"];

/** An event Mail can act on: the record, and where it came from. */
export interface ReadEvent {
	/** The sending domain its subscription is for, in lower case. */
	domain: string;
	/** The address the message was sent from, in lower case. */
	sender: string;
	event: DeliveryEvent;
}

const isState = (value: string): value is DeliveryState =>
	(DELIVERY_STATES as readonly string[]).includes(value);

/** One line of what a server or Email Service said, cut short. Null when there is none. */
function said(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value !== "string") continue;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
		const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
		if (line) return line.slice(0, MAX_DELIVERY_DETAIL);
	}
	return null;
}

/** What to show for a state: the SMTP response or the reason, whichever the event has. */
function detailOf(state: DeliveryState, payload: Payload): string | null {
	const { delivery, bounce, failure, rejection } = payload;
	switch (state) {
		case "deferred":
			return said(delivery?.smtpResponse, bounce?.reason);
		case "bounced":
			return said(bounce?.reason, delivery?.smtpResponse);
		case "failed":
			return said(failure?.reason, delivery?.smtpResponse);
		case "rejected":
			return said(rejection?.detail, rejection?.reason);
		default:
			return null;
	}
}

/**
 * An Email Sending event as Mail records it, or null for anything else: another source, a type Mail
 * doesn't know, or a shape it can't read. `receivedAt` stands in for an event without a time.
 */
export function readEvent(body: unknown, receivedAt: number): ReadEvent | null {
	const parsed = EmailSendingEvent.safeParse(body);
	if (!parsed.success) return null;
	const { type, source, metadata, payload } = parsed.data;
	if (!type.startsWith(TYPE_PREFIX)) return null;
	const state = type.slice(TYPE_PREFIX.length);
	if (!isState(state)) return null;
	const at = Date.parse(metadata?.eventTimestamp ?? "");
	return {
		domain: source.domain.toLowerCase(),
		sender: payload.sender.trim().toLowerCase(),
		event: {
			provider: "cloudflare",
			messageId: payload.messageId,
			recipient: payload.recipient.trim().toLowerCase(),
			state,
			at: Number.isFinite(at) ? at : receivedAt,
			detail: detailOf(state, payload),
		},
	};
}

/** The address's two parts, when it is one. */
function split(address: string): { local: string; domain: string } | null {
	const at = address.lastIndexOf("@");
	if (at < 1 || at === address.length - 1) return null;
	return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/**
 * The mailbox of each of these addresses, on domains a workspace proved. A temporary address that
 * has ended still counts: it sent the message, and the mailbox still has it.
 */
async function mailboxesOf(db: Database, senders: Set<string>): Promise<Map<string, string>> {
	const byDomain = new Map<string, string[]>();
	for (const sender of senders) {
		const parts = split(sender);
		if (!parts) continue;
		byDomain.set(parts.domain, [...(byDomain.get(parts.domain) ?? []), parts.local]);
	}
	const { mailAddress, mailDomain } = schema;
	const found = new Map<string, string>();
	for (const [domain, locals] of byDomain) {
		for (let start = 0; start < locals.length; start += LOOKUP_CHUNK) {
			const rows = await db
				.select({ local: mailAddress.localPart, mailboxId: mailAddress.mailboxId })
				.from(mailAddress)
				.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
				.where(
					and(
						eq(mailDomain.name, domain),
						isNotNull(mailDomain.verifiedAt),
						inArray(mailAddress.localPart, locals.slice(start, start + LOOKUP_CHUNK)),
					),
				)
				.all();
			for (const row of rows) found.set(`${row.local}@${domain}`, row.mailboxId);
		}
	}
	return found;
}

/** What `recordDeliveries` needs of a mailbox. */
export interface DeliveryRecorder {
	recordDeliveries(events: DeliveryEvent[]): Promise<boolean[]> | boolean[];
}

/** How a batch went, in counts, for the log. */
export interface EventsHandled {
	recorded: number;
	/** Not Email Sending events Mail can read. */
	unreadable: number;
	/** From an address that isn't a mailbox's, such as another app's on the same domain. */
	notOurs: number;
	/** For a message the mailbox doesn't have, after the time it is looked for. */
	notFound: number;
	retried: number;
}

/**
 * Records a batch of Email Sending events in the mailboxes that sent the messages, and notes for
 * each proved domain that its events arrive. Events Mail has no use for are acknowledged and
 * dropped. One whose message isn't found yet is looked for again for a while, in case its send
 * isn't recorded yet. When D1 or a mailbox fails, the events wait and come again.
 */
export async function receiveDeliveryEvents(
	batch: MessageBatch<unknown>,
	db: Database,
	mailbox: (id: string) => DeliveryRecorder,
	now = Date.now(),
): Promise<EventsHandled> {
	const handled: EventsHandled = {
		recorded: 0,
		unreadable: 0,
		notOurs: 0,
		notFound: 0,
		retried: 0,
	};
	const retry = (message: Message<unknown>) => {
		message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
		handled.retried++;
	};
	const read: { message: Message<unknown>; event: ReadEvent }[] = [];
	for (const message of batch.messages) {
		const event = readEvent(message.body, message.timestamp.getTime());
		if (event) {
			read.push({ message, event });
		} else {
			message.ack();
			handled.unreadable++;
		}
	}
	if (read.length === 0) return handled;

	let mailboxes: Map<string, string>;
	try {
		const domains = [...new Set(read.map(({ event }) => event.domain))];
		await db
			.update(schema.mailDomain)
			.set({ eventsAt: new Date(now) })
			.where(
				and(inArray(schema.mailDomain.name, domains), isNotNull(schema.mailDomain.verifiedAt)),
			);
		mailboxes = await mailboxesOf(db, new Set(read.map(({ event }) => event.sender)));
	} catch {
		for (const { message } of read) retry(message);
		return handled;
	}

	const byMailbox = new Map<string, typeof read>();
	for (const one of read) {
		const mailboxId = mailboxes.get(one.event.sender);
		// The address must be on the domain whose subscription sent the event.
		if (!mailboxId || split(one.event.sender)?.domain !== one.event.domain) {
			one.message.ack();
			handled.notOurs++;
			continue;
		}
		byMailbox.set(mailboxId, [...(byMailbox.get(mailboxId) ?? []), one]);
	}

	await Promise.all(
		[...byMailbox].map(async ([mailboxId, events]) => {
			let found: boolean[];
			try {
				found = await mailbox(mailboxId).recordDeliveries(events.map(({ event }) => event.event));
			} catch {
				for (const { message } of events) retry(message);
				return;
			}
			events.forEach(({ message, event }, index) => {
				if (found[index]) {
					message.ack();
					handled.recorded++;
				} else if (now - event.event.at < FIND_WINDOW_MS) {
					retry(message);
				} else {
					message.ack();
					handled.notFound++;
				}
			});
		}),
	);
	return handled;
}
