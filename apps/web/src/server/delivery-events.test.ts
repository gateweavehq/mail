import { describe, expect, it } from "vitest";
import { MAX_DELIVERY_DETAIL } from "../lib/delivery";
import { SUPPRESSION_DAYS } from "../lib/suppressions";
import {
	type EventDirectory,
	FIND_WINDOW_MS,
	failureDelay,
	MAX_FAILURE_DELAY_SECONDS,
	RETRY_DELAY_SECONDS,
	readEvent,
	receiveDeliveryEvents,
	type Sender,
} from "./delivery-events";
import type { NewSuppression } from "./suppressions";

/** An Email Sending event as the docs and the staging measurement show it. */
function event(type: string, payload: Record<string, unknown> = {}, extra = {}) {
	return {
		type: `cf.email.sending.message.${type}`,
		source: { type: "email.sending", zoneId: "z", domain: "Example.com" },
		metadata: {
			accountId: "a",
			eventSubscriptionId: "s",
			eventSchemaVersion: 1,
			eventTimestamp: "2026-11-08T22:08:35.031Z",
		},
		payload: {
			eventId: "e",
			messageId: "<abc@example.com>",
			sender: "Help@Example.com",
			recipient: "Ada@Example.org",
			subject: "Hi",
			terminal: true,
			delivery: { status: type },
			...payload,
		},
		...extra,
	};
}

const at = Date.parse("2026-11-08T22:08:35.031Z");

describe("reading Email Sending's delivery events", () => {
	it("reads a delivery as the staging measurement saw it", () => {
		expect(
			readEvent(
				event("delivered", { delivery: { status: "delivered", provider: "cloudflare" } }),
				0,
			),
		).toEqual({
			domain: "example.com",
			sender: "help@example.com",
			event: {
				provider: "cloudflare",
				messageId: "<abc@example.com>",
				recipient: "ada@example.org",
				state: "delivered",
				at,
				detail: null,
			},
			suppression: null,
		});
	});

	it("keeps what the server or Email Service said, for each state", () => {
		const detail = (type: string, payload: Record<string, unknown>) =>
			readEvent(event(type, payload), 0)?.event.detail;
		expect(
			detail("deferred", {
				delivery: { status: "deferred", smtpResponse: "451 4.2.0 Temporary mailbox error" },
				bounce: { type: "soft", reason: "other" },
			}),
		).toBe("451 4.2.0 Temporary mailbox error");
		expect(
			detail("bounced", {
				delivery: { status: "bounced", smtpResponse: "550 smtp" },
				bounce: { type: "hard", reason: "550 5.1.1 User unknown" },
			}),
		).toBe("550 5.1.1 User unknown");
		expect(detail("bounced", { delivery: { smtpResponse: "550 smtp" } })).toBe("550 smtp");
		expect(detail("failed", { failure: { reason: "delivery_failed" } })).toBe("delivery_failed");
		expect(
			detail("rejected", {
				rejection: { reason: "suppressed", party: "recipient", detail: "Recipient is suppressed" },
			}),
		).toBe("Recipient is suppressed");
		expect(detail("rejected", { rejection: { reason: "suppressed" } })).toBe("suppressed");
		expect(detail("complained", { complaint: { type: "abuse" } })).toBeNull();
	});

	it("keeps a server's words on one line, cut short", () => {
		const read = readEvent(
			event("bounced", { bounce: { reason: `550 no\r\nsuch\tuser ${"x".repeat(400)}` } }),
			0,
		);
		expect(read?.event.detail).toMatch(/^550 no such user x+$/);
		expect(read?.event.detail).toHaveLength(MAX_DELIVERY_DETAIL);
	});

	it("reads an event whose parts aren't as expected, without them", () => {
		const read = readEvent(event("bounced", { bounce: "550", delivery: [1, 2] }), 0);
		expect(read?.event).toMatchObject({ state: "bounced", detail: null });
		expect(readEvent(event("bounced", { bounce: { reason: 550 } }), 0)?.event.detail).toBeNull();
	});

	it("uses the time the queue got it when the event has none", () => {
		expect(readEvent(event("delivered", {}, { metadata: {} }), 42)?.event.at).toBe(42);
		expect(readEvent(event("delivered", {}, { metadata: "?" }), 42)?.event.at).toBe(42);
		expect(
			readEvent(event("delivered", {}, { metadata: { eventTimestamp: "soon" } }), 42)?.event.at,
		).toBe(42);
	});

	it("leaves out anything else", () => {
		expect(readEvent(event("opened"), 0)).toBeNull();
		expect(readEvent({ ...event("delivered"), type: "cf.kv.namespace.created" }, 0)).toBeNull();
		expect(
			readEvent({ ...event("delivered"), source: { type: "r2", domain: "example.com" } }, 0),
		).toBeNull();
		expect(readEvent(event("delivered", { messageId: "" }), 0)).toBeNull();
		expect(readEvent(event("delivered", { sender: undefined }), 0)).toBeNull();
		expect(readEvent(event("delivered", { recipient: 7 }), 0)).toBeNull();
		expect(readEvent(event("delivered", { messageId: "x".repeat(999) }), 0)).toBeNull();
		expect(readEvent("delivered", 0)).toBeNull();
		expect(readEvent(null, 0)).toBeNull();
	});
});

/** A queued message, and what the handler did with it. */
function queued(body: unknown, attempts = 1) {
	const done: { acked: boolean; delay: number | null } = { acked: false, delay: null };
	const message: Message<unknown> = {
		id: crypto.randomUUID(),
		timestamp: new Date(at),
		body,
		attempts,
		ack: () => {
			done.acked = true;
		},
		retry: (options) => {
			done.delay = options?.delaySeconds ?? 0;
		},
	};
	return { message, done };
}

function batchOf(...messages: Message<unknown>[]): MessageBatch<unknown> {
	return {
		messages,
		queue: "gateweave-mail-events",
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		retryAll: () => {
			throw new Error("not expected");
		},
		ackAll: () => {
			throw new Error("not expected");
		},
	};
}

/**
 * A directory where help@ and sales@ example.com are two mailboxes' addresses, of two workspaces.
 * `fails` makes the lookups fail, `suppressFails` adding to a list.
 */
function directory(
	fails?: Error,
	suppressFails?: Error,
): EventDirectory & { came: string[][]; suppressed: NewSuppression[] } {
	const came: string[][] = [];
	const suppressed: NewSuppression[] = [];
	const known = new Map<string, Sender>([
		["help@example.com", { mailboxId: "box-help", workspaceId: "ws-help" }],
		["sales@example.com", { mailboxId: "box-sales", workspaceId: "ws-sales" }],
	]);
	return {
		came,
		suppressed,
		async eventsCame(domains) {
			if (fails) throw fails;
			came.push(domains);
		},
		async mailboxesOf(senders) {
			return new Map(
				[...senders].flatMap((one) => {
					const sender = known.get(one);
					return sender ? [[one, sender] as const] : [];
				}),
			);
		},
		async suppress(entries) {
			if (suppressFails) throw suppressFails;
			suppressed.push(...entries);
		},
	};
}

describe("receiving a batch of delivery events", () => {
	it("records each event in the mailbox that sent it, and drops what isn't a mailbox's", async () => {
		const help = queued(event("delivered"));
		const sales = queued(event("bounced", { sender: "Sales@Example.com" }));
		const otherApp = queued(event("delivered", { sender: "notifications@example.com" }));
		const otherSubscription = queued(
			event("delivered", {}, { source: { type: "email.sending", domain: "example.net" } }),
		);
		const unreadable = queued({ type: "nope" });
		const recorded: Record<string, string[]> = {};
		const handled = await receiveDeliveryEvents(
			batchOf(
				help.message,
				sales.message,
				otherApp.message,
				otherSubscription.message,
				unreadable.message,
			),
			directory(),
			(id) => ({
				recordDeliveries: (events) => {
					recorded[id] = events.map(({ state }) => state);
					return events.map(() => true);
				},
			}),
			at,
		);
		expect(recorded).toEqual({ "box-help": ["delivered"], "box-sales": ["bounced"] });
		expect([help, sales, otherApp, otherSubscription, unreadable].map(({ done }) => done)).toEqual(
			Array(5).fill({ acked: true, delay: null }),
		);
		expect(handled).toEqual({
			recorded: 2,
			unreadable: 1,
			notOurs: 2,
			notFound: 0,
			waiting: 0,
			suppressed: 0,
			failed: 0,
			failures: [],
		});
	});

	it("looks again soon for a message not found yet, but only for a while after the event", async () => {
		const notFound = () => ({ recordDeliveries: (events: unknown[]) => events.map(() => false) });
		const young = queued(event("delivered"));
		const waiting = await receiveDeliveryEvents(
			batchOf(young.message),
			directory(),
			notFound,
			at + FIND_WINDOW_MS - 1,
		);
		expect(young.done).toEqual({ acked: false, delay: RETRY_DELAY_SECONDS });
		expect(waiting).toMatchObject({ waiting: 1, notFound: 0 });
		const old = queued(event("delivered"));
		const gone = await receiveDeliveryEvents(
			batchOf(old.message),
			directory(),
			notFound,
			at + FIND_WINDOW_MS,
		);
		expect(old.done).toEqual({ acked: true, delay: null });
		expect(gone).toMatchObject({ waiting: 0, notFound: 1 });
	});

	it("waits longer after each failure, up to twelve hours", () => {
		expect([1, 2, 3, 10, 11, 16].map(failureDelay)).toEqual([
			60,
			120,
			240,
			30_720,
			MAX_FAILURE_DELAY_SECONDS,
			MAX_FAILURE_DELAY_SECONDS,
		]);
		expect(MAX_FAILURE_DELAY_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
	});

	it("lets every event come again when the directory fails, and says why without addresses", async () => {
		const first = queued(event("delivered"), 1);
		const third = queued(event("bounced"), 3);
		const handled = await receiveDeliveryEvents(
			batchOf(first.message, third.message),
			directory(new Error("D1_ERROR: no such table: mail_address, looking up help@example.com")),
			() => {
				throw new Error("not expected");
			},
			at,
		);
		expect(first.done).toEqual({ acked: false, delay: 60 });
		expect(third.done).toEqual({ acked: false, delay: 240 });
		expect(handled).toMatchObject({
			failed: 2,
			failures: ["directory: Error: D1_ERROR: no such table: mail_address, looking up <address>"],
		});
	});

	it("names a query error by its cause, as its message lists the query's values", async () => {
		const query = Object.assign(new Error("Failed query: select ... params: help,example.com"), {
			name: "DrizzleQueryError",
		});
		const failures = async (error: Error) =>
			(
				await receiveDeliveryEvents(
					batchOf(queued(event("delivered")).message),
					directory(error),
					() => ({ recordDeliveries: () => [] }),
					at,
				)
			).failures;
		expect(await failures(query)).toEqual(["directory: DrizzleQueryError"]);
		query.cause = new Error("D1_ERROR: Network connection lost.");
		expect(await failures(query)).toEqual(["directory: Error: D1_ERROR: Network connection lost."]);
	});

	it("lets only a failing mailbox's events come again", async () => {
		const help = queued(event("delivered"), 2);
		const sales = queued(event("delivered", { sender: "sales@example.com" }));
		const handled = await receiveDeliveryEvents(
			batchOf(help.message, sales.message),
			directory(),
			(id) => ({
				recordDeliveries: (events) => {
					if (id === "box-help")
						throw new Error("Durable Object reset because its code was updated.");
					return events.map(() => true);
				},
			}),
			at,
		);
		expect(help.done).toEqual({ acked: false, delay: 120 });
		expect(sales.done).toEqual({ acked: true, delay: null });
		expect(handled).toMatchObject({
			recorded: 1,
			failed: 1,
			failures: ["mailbox: Error: Durable Object reset because its code was updated."],
		});
	});
});

describe("what an event says about writing to its recipient again", () => {
	const suppression = (type: string, payload: Record<string, unknown> = {}) =>
		readEvent(event(type, payload), 0)?.suppression;

	it("stops mail after a complaint until someone removes it", () => {
		expect(suppression("complained", { complaint: { type: "abuse" } })).toEqual({
			reason: "complained",
			forever: true,
		});
	});

	it("stops mail after a hard bounce, for good when the mailbox or domain doesn't exist", () => {
		expect(
			suppression("bounced", {
				bounce: {
					type: "hard",
					classification: "permanent_failure",
					reason: "550 5.1.1 User unknown",
				},
			}),
		).toEqual({ reason: "bounced", forever: true });
		expect(
			suppression("bounced", {
				bounce: { type: "hard", reason: "550 no" },
				delivery: { smtpEnhancedStatusCode: "5.1.10" },
			}),
		).toEqual({ reason: "bounced", forever: true });
		expect(
			suppression("bounced", {
				bounce: { type: "hard", reason: "550-5.1.1 The email account that you tried to reach" },
			}),
		).toEqual({ reason: "bounced", forever: true });
		expect(
			suppression("bounced", { bounce: { type: "hard", reason: "554 5.7.1 Policy rejection" } }),
		).toEqual({ reason: "bounced", forever: false });
	});

	it("doesn't take a code about the sender, or one that only looks like it, for good", () => {
		const hard = (reason: string, delivery: Record<string, unknown> = {}) =>
			suppression("bounced", { bounce: { type: "hard", reason }, delivery });
		// About the sender's address, as when its bounce domain stops resolving.
		expect(hard("553 5.1.8 Sender address rejected: Domain not found")?.forever).toBe(false);
		// An IP address in a blocklist's words.
		expect(hard("554 5.7.1 Service unavailable; Client host [5.1.83.12] blocked")?.forever).toBe(
			false,
		);
		expect(hard("Delivery failed: 5.1.1 somewhere in the words")?.forever).toBe(false);
		// The event's own code comes first.
		expect(hard("550 5.1.1 User unknown", { smtpEnhancedStatusCode: "5.7.1" })?.forever).toBe(
			false,
		);
		expect(hard("550 rejected", { smtpEnhancedStatusCode: " 5.1.2 " })?.forever).toBe(true);
	});

	it("doesn't stop mail after a soft bounce, a delay, a failure or a delivery", () => {
		expect(
			suppression("bounced", { bounce: { type: "soft", reason: "452 4.2.2 Mailbox full" } }),
		).toBeNull();
		expect(suppression("bounced", { bounce: { reason: "550 5.1.1 User unknown" } })).toBeNull();
		expect(suppression("deferred")).toBeNull();
		expect(suppression("failed", { failure: { reason: "delivery_failed" } })).toBeNull();
		expect(suppression("delivered")).toBeNull();
	});

	it("notes a refusal only when the provider's list is why", () => {
		expect(
			suppression("rejected", {
				rejection: { reason: "suppressed", party: "recipient", detail: "Recipient is suppressed" },
			}),
		).toEqual({ reason: "rejected", forever: false });
		expect(suppression("rejected", { rejection: { reason: "validation" } })).toBeNull();
	});
});

describe("adding to suppression lists from a batch", () => {
	/** A mailbox that has sent the messages of these ids, and only those. */
	const sent =
		(...ids: string[]) =>
		() => ({
			recordDeliveries: (events: { messageId: string }[]) =>
				events.map(({ messageId }) => ids.includes(messageId)),
		});

	it("adds a bounce or a complaint only for mail the mailbox sent, and a refusal for the provider's list either way", async () => {
		const known = directory();
		const bounced = queued(
			event("bounced", {
				messageId: "<sent@example.com>",
				bounce: { type: "hard", reason: "550 5.1.1 User unknown" },
			}),
		);
		// About mail this mailbox has no record of sending, such as before its domain was proved here.
		const complained = queued(
			event("complained", { messageId: "<earlier@example.com>", complaint: { type: "abuse" } }),
		);
		const refused = queued(
			event("rejected", {
				messageId: "<never-sent@example.com>",
				sender: "sales@example.com",
				rejection: { reason: "suppressed", detail: "Recipient is suppressed" },
			}),
		);
		const otherApp = queued(
			event("complained", { sender: "notifications@example.com", complaint: { type: "abuse" } }),
		);
		const handled = await receiveDeliveryEvents(
			batchOf(bounced.message, complained.message, refused.message, otherApp.message),
			known,
			sent("<sent@example.com>"),
			at,
		);
		expect(known.suppressed).toEqual([
			{
				workspaceId: "ws-help",
				address: "ada@example.org",
				reason: "bounced",
				provider: "cloudflare",
				detail: "550 5.1.1 User unknown",
				at,
				expiresAt: null,
			},
			{
				workspaceId: "ws-sales",
				address: "ada@example.org",
				reason: "rejected",
				provider: "cloudflare",
				detail: "Recipient is suppressed",
				at,
				expiresAt: at + SUPPRESSION_DAYS * 24 * 60 * 60 * 1000,
			},
		]);
		expect(bounced.done).toEqual({ acked: true, delay: null });
		expect(complained.done).toEqual({ acked: false, delay: RETRY_DELAY_SECONDS });
		expect(handled).toMatchObject({ suppressed: 2, recorded: 1, waiting: 2, notOurs: 1 });
	});

	it("adds nothing for an event whose mailbox failed, which comes again", async () => {
		const known = directory();
		const bounced = queued(
			event("bounced", {
				messageId: "<sent@example.com>",
				bounce: { type: "hard", reason: "550 5.1.1 User unknown" },
			}),
		);
		const handled = await receiveDeliveryEvents(
			batchOf(bounced.message),
			known,
			() => ({
				recordDeliveries: () => {
					throw new Error("the object restarted");
				},
			}),
			at,
		);
		expect(known.suppressed).toEqual([]);
		expect(bounced.done).toEqual({ acked: false, delay: 60 });
		expect(handled).toMatchObject({ suppressed: 0, failed: 1 });
	});

	it("adds a refusal for the provider's list when it comes after the message would be found", async () => {
		const known = directory();
		const late = queued(
			event("rejected", { rejection: { reason: "suppressed", detail: "Recipient is suppressed" } }),
		);
		const handled = await receiveDeliveryEvents(
			batchOf(late.message),
			known,
			sent(),
			at + FIND_WINDOW_MS + 1,
		);
		expect(known.suppressed).toHaveLength(1);
		expect(late.done).toEqual({ acked: true, delay: null });
		expect(handled).toMatchObject({ suppressed: 1, notFound: 1 });
	});

	it("lets the events that add to a list come again when it can't be written, once recorded", async () => {
		const recorded: string[] = [];
		const bounced = queued(
			event("bounced", {
				messageId: "<sent@example.com>",
				bounce: { type: "hard", reason: "550" },
			}),
			2,
		);
		const other = queued(event("delivered", { sender: "sales@example.com" }));
		const handled = await receiveDeliveryEvents(
			batchOf(bounced.message, other.message),
			directory(undefined, new Error("D1_ERROR: database is locked")),
			(mailboxId) => ({
				recordDeliveries: (events) => {
					recorded.push(mailboxId);
					return events.map(() => true);
				},
			}),
			at,
		);
		// Recording only moves forward, so recording it again when it comes back changes nothing.
		expect(recorded.sort()).toEqual(["box-help", "box-sales"]);
		expect(bounced.done).toEqual({ acked: false, delay: 120 });
		expect(other.done).toEqual({ acked: true, delay: null });
		expect(handled).toMatchObject({
			suppressed: 0,
			recorded: 1,
			failed: 1,
			failures: ["suppressions: Error: D1_ERROR: database is locked"],
		});
	});
});
