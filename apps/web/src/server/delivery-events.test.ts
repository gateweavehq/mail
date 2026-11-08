import { describe, expect, it } from "vitest";
import { MAX_DELIVERY_DETAIL } from "../lib/delivery";
import {
	type EventDirectory,
	FIND_WINDOW_MS,
	failureDelay,
	MAX_FAILURE_DELAY_SECONDS,
	RETRY_DELAY_SECONDS,
	readEvent,
	receiveDeliveryEvents,
} from "./delivery-events";

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

/** A directory where help@ and sales@ example.com are two mailboxes' addresses. */
function directory(fails?: Error): EventDirectory & { came: string[][] } {
	const came: string[][] = [];
	return {
		came,
		async eventsCame(domains) {
			if (fails) throw fails;
			came.push(domains);
		},
		async mailboxesOf(senders) {
			const known = new Map([
				["help@example.com", "box-help"],
				["sales@example.com", "box-sales"],
			]);
			return new Map(
				[...senders].flatMap((one) => (known.has(one) ? [[one, known.get(one) ?? ""]] : [])),
			);
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
