import { describe, expect, it } from "vitest";
import { MAX_DELIVERY_DETAIL } from "../lib/delivery";
import { readEvent } from "./delivery-events";

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
