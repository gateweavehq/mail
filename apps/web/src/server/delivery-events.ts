import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { DELIVERY_STATES, type DeliveryState, MAX_DELIVERY_DETAIL } from "../lib/delivery";
import { SUPPRESSION_DAYS, type SuppressionReason } from "../lib/suppressions";
import { type Database, schema } from "./db";
import type { DeliveryEvent } from "./mailbox/deliveries";
import { type NewSuppression, suppress } from "./suppressions";

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

/** How long to wait before looking again for a message not found yet, and after a first failure. */
export const RETRY_DELAY_SECONDS = 60;

/** The longest a message waits after failures, within the 24 hours Queues allows. */
export const MAX_FAILURE_DELAY_SECONDS = 12 * 60 * 60;

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

/** What an event says about writing to its recipient again. */
export interface SuppressionSaid {
	reason: SuppressionReason;
	/** Until someone removes it, rather than for `SUPPRESSION_DAYS`. */
	forever: boolean;
}

/** An event Mail can act on: the record, and where it came from. */
export interface ReadEvent {
	/** The sending domain its subscription is for, in lower case. */
	domain: string;
	/** The address the message was sent from, in lower case. */
	sender: string;
	event: DeliveryEvent;
	/** Null when the event doesn't stop mail to the recipient. */
	suppression: SuppressionSaid | null;
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
 * Enhanced status codes for a mailbox or domain that doesn't exist (RFC 3463): bad mailbox
 * (`5.1.1`), bad system (`5.1.2`), bad address syntax (`5.1.3`) and a null MX (`5.1.10`). Not the
 * rest of `5.1.x`, such as `5.1.8`, which is about the sender's address and says nothing of the
 * recipient's.
 */
const NO_SUCH_MAILBOX = new Set(["5.1.1", "5.1.2", "5.1.3", "5.1.10"]);

/** An enhanced status code as an SMTP reply starts with it: `550 5.1.1 User unknown`. */
const REPLY_CODE = /^\s*5\d\d[\s-]+(5\.\d{1,3}\.\d{1,3})(?![\d.])/;

/** The enhanced status code of a bounce: the one the event gives, or the one its reply starts with. */
function enhancedCode(payload: Payload): string | null {
	const given = payload.delivery?.smtpEnhancedStatusCode;
	if (typeof given === "string" && given.trim()) return given.trim();
	for (const reply of [payload.bounce?.reason, payload.delivery?.smtpResponse]) {
		const match = typeof reply === "string" ? REPLY_CODE.exec(reply) : null;
		if (match?.[1]) return match[1];
	}
	return null;
}

/**
 * Whether the event stops mail to its recipient, by Email Service's own rules: every complaint, a
 * bounce only when it is hard, as a soft one that ran out of tries may pass, and a refusal because
 * Email Service's list has the address. A hard bounce for a mailbox or domain that doesn't exist
 * lasts until removed, as Email Service's own does; another may come right, so it lasts a week.
 */
function suppressionOf(state: DeliveryState, payload: Payload): SuppressionSaid | null {
	switch (state) {
		case "complained":
			return { reason: "complained", forever: true };
		case "bounced": {
			if (payload.bounce?.type !== "hard") return null;
			return { reason: "bounced", forever: NO_SUCH_MAILBOX.has(enhancedCode(payload) ?? "") };
		}
		case "rejected":
			return payload.rejection?.reason === "suppressed"
				? { reason: "rejected", forever: false }
				: null;
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
		suppression: suppressionOf(state, payload),
	};
}

/** The address's two parts, when it is one. */
function split(address: string): { local: string; domain: string } | null {
	const at = address.lastIndexOf("@");
	if (at < 1 || at === address.length - 1) return null;
	return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/** What receiving events needs of the directory, which D1 holds. */
export interface EventDirectory {
	/** Notes that events came for these domains, where a workspace proved them. */
	eventsCame(domains: string[], at: number): Promise<void>;
	/**
	 * The mailbox of each of these addresses, on domains a workspace proved, and that workspace. A
	 * temporary address that has ended still counts: it sent the message, and the mailbox still has
	 * it.
	 */
	mailboxesOf(senders: Set<string>): Promise<Map<string, Sender>>;
	/** Adds addresses to their workspaces' suppression lists. */
	suppress(entries: NewSuppression[], now: number): Promise<void>;
}

/** Whose address sent a message. */
export interface Sender {
	mailboxId: string;
	workspaceId: string;
}

/** The directory in D1. */
export function directoryIn(db: Database): EventDirectory {
	const { mailAddress, mailDomain } = schema;
	return {
		async eventsCame(domains, at) {
			await db
				.update(mailDomain)
				.set({ eventsAt: new Date(at) })
				.where(and(inArray(mailDomain.name, domains), isNotNull(mailDomain.verifiedAt)));
		},
		async mailboxesOf(senders) {
			const byDomain = new Map<string, string[]>();
			for (const sender of senders) {
				const parts = split(sender);
				if (!parts) continue;
				byDomain.set(parts.domain, [...(byDomain.get(parts.domain) ?? []), parts.local]);
			}
			const found = new Map<string, Sender>();
			for (const [domain, locals] of byDomain) {
				for (let start = 0; start < locals.length; start += LOOKUP_CHUNK) {
					const rows = await db
						.select({
							local: mailAddress.localPart,
							mailboxId: mailAddress.mailboxId,
							workspaceId: mailDomain.organizationId,
						})
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
					for (const { local, mailboxId, workspaceId } of rows) {
						found.set(`${local}@${domain}`, { mailboxId, workspaceId });
					}
				}
			}
			return found;
		},
		suppress: (entries, now) => suppress(db, entries, now),
	};
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
	/** For a message not found yet, to be looked for again. */
	waiting: number;
	/** Recipients added to a workspace's suppression list, or kept there. */
	suppressed: number;
	/** Not handled because D1 or a mailbox failed, to come again later. */
	failed: number;
	/** What failed, without addresses. */
	failures: string[];
}

/**
 * How long a message waits before it comes again after `attempts` deliveries ended in a failure:
 * twice as long each time, from a minute up to twelve hours. With the consumer's `max_retries`,
 * that outlasts an outage of up to about three days, or the queue's retention when it is shorter.
 */
export const failureDelay = (attempts: number) =>
	Math.min(RETRY_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_FAILURE_DELAY_SECONDS);

/** Anything in an error's words that looks like an address. */
const ADDRESS = /[^\s<>"'(),;:]*@[^\s<>"'(),;:]+/g;

/**
 * What went wrong, for the log: D1's or the object's own words, without addresses. A query error
 * from Drizzle lists the query's values, which include parts of addresses, so it gives its cause
 * or only its name.
 */
function failureOf(where: string, error: unknown): string {
	const inner = error instanceof Error && error.cause instanceof Error ? error.cause : error;
	if (!(inner instanceof Error)) return `${where}: ${typeof inner}`;
	if (inner === error && inner.name === "DrizzleQueryError") return `${where}: ${inner.name}`;
	const words = said(`${inner.name}: ${inner.message}`.replace(ADDRESS, "<address>"));
	return `${where}: ${words?.slice(0, 200) ?? inner.name}`;
}

/**
 * Records a batch of Email Sending events in the mailboxes that sent the messages, and notes for
 * each proved domain that its events arrive. Events Mail has no use for are acknowledged and
 * dropped. One whose message isn't found yet is looked for again for a while, in case its send
 * isn't recorded yet. When D1 or a mailbox fails, the events wait and come again.
 */
export async function receiveDeliveryEvents(
	batch: MessageBatch<unknown>,
	directory: EventDirectory,
	mailbox: (id: string) => DeliveryRecorder,
	now = Date.now(),
): Promise<EventsHandled> {
	const handled: EventsHandled = {
		recorded: 0,
		unreadable: 0,
		notOurs: 0,
		notFound: 0,
		waiting: 0,
		suppressed: 0,
		failed: 0,
		failures: [],
	};
	const fail = (messages: Message<unknown>[], failure: string) => {
		for (const message of messages) message.retry({ delaySeconds: failureDelay(message.attempts) });
		handled.failed += messages.length;
		if (!handled.failures.includes(failure)) handled.failures.push(failure);
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

	let mailboxes: Map<string, Sender>;
	try {
		await directory.eventsCame([...new Set(read.map(({ event }) => event.domain))], now);
		mailboxes = await directory.mailboxesOf(new Set(read.map(({ event }) => event.sender)));
	} catch (error) {
		fail(
			read.map(({ message }) => message),
			failureOf("directory", error),
		);
		return handled;
	}

	type Routed = (typeof read)[number] & { sender: Sender };
	const byMailbox = new Map<string, Routed[]>();
	for (const one of read) {
		const sender = mailboxes.get(one.event.sender);
		// The address must be on the domain whose subscription sent the event.
		if (!sender || split(one.event.sender)?.domain !== one.event.domain) {
			one.message.ack();
			handled.notOurs++;
			continue;
		}
		byMailbox.set(sender.mailboxId, [
			...(byMailbox.get(sender.mailboxId) ?? []),
			{ ...one, sender },
		]);
	}

	// Recorded in the mailboxes first. Recording only moves forward, so a batch that comes again
	// after the lists failed records nothing twice.
	const done: { one: Routed; found: boolean }[] = [];
	await Promise.all(
		[...byMailbox].map(async ([mailboxId, events]) => {
			try {
				const found = await mailbox(mailboxId).recordDeliveries(
					events.map(({ event }) => event.event),
				);
				events.forEach((one, index) => {
					done.push({ one, found: found[index] === true });
				});
			} catch (error) {
				fail(
					events.map(({ message }) => message),
					failureOf("mailbox", error),
				);
			}
		}),
	);

	// Then the lists. A bounce or a complaint counts only for a message the mailbox sent, so that one
	// about mail from before a domain changed hands can't stop its new workspace's. A refusal for
	// the provider's list counts either way: such a message never got an id to be found by.
	const suppressions: NewSuppression[] = [];
	const suppressing = new Set<Message<unknown>>();
	for (const { one, found } of done) {
		const said = one.event.suppression;
		if (!said || !(found || said.reason === "rejected")) continue;
		const { recipient, provider, detail, at } = one.event.event;
		suppressions.push({
			workspaceId: one.sender.workspaceId,
			address: recipient,
			reason: said.reason,
			provider,
			detail,
			at,
			expiresAt: said.forever ? null : at + SUPPRESSION_DAYS * 24 * 60 * 60 * 1000,
		});
		suppressing.add(one.message);
	}
	let listsFailed = false;
	if (suppressions.length > 0) {
		try {
			await directory.suppress(suppressions, now);
			handled.suppressed = suppressions.length;
		} catch (error) {
			listsFailed = true;
			fail([...suppressing], failureOf("suppressions", error));
		}
	}

	for (const { one, found } of done) {
		if (listsFailed && suppressing.has(one.message)) continue;
		if (found) {
			one.message.ack();
			handled.recorded++;
		} else if (now - one.event.event.at < FIND_WINDOW_MS) {
			one.message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
			handled.waiting++;
		} else {
			one.message.ack();
			handled.notFound++;
		}
	}
	return handled;
}
