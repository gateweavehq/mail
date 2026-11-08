import { describe, expect, it } from "vitest";
import { MAX_DELIVERY_DETAIL } from "../../lib/delivery";
import { DELIVERIES_JSON, type DeliveryEvent, recordDelivery } from "./deliveries";
import { migrate } from "./schema";
import { nodeStorage } from "./testing";

/** A mailbox's storage with one message it sent, which Email Service knows as `<sent@cf>`. */
function mailbox() {
	const { db, storage } = nodeStorage();
	migrate(storage);
	db.prepare(
		`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
			envelope_to, sent_by)
		VALUES ('m1', 'stored', 'sent:m1', 'w/m/m1.eml', 10, 1, 'help@example.com', 'a@x', 'member')`,
	).run();
	db.prepare(
		`INSERT INTO outgoing (message, state, request, provider, provider_id)
		VALUES ('m1', 'sent', '{}', 'cloudflare', '<sent@cf>')`,
	).run();
	const record = (event: Partial<DeliveryEvent>) =>
		recordDelivery(storage.sql, {
			provider: "cloudflare",
			messageId: "<sent@cf>",
			recipient: "ada@example.org",
			state: "delivered",
			at: 1000,
			detail: null,
			...event,
		});
	const rows = () =>
		db.prepare("SELECT recipient, state, at, detail FROM delivery ORDER BY recipient").all();
	return { db, record, rows };
}

describe("recording delivery events", () => {
	it("keeps one record per recipient, under the message the provider's id names", () => {
		const { record, rows } = mailbox();
		expect(record({ recipient: "Ada@Example.org " })).toBe(true);
		expect(record({ recipient: "grace@example.org", state: "deferred", detail: "451 later" })).toBe(
			true,
		);
		expect(rows()).toEqual([
			{ recipient: "ada@example.org", state: "delivered", at: 1000, detail: null },
			{ recipient: "grace@example.org", state: "deferred", at: 1000, detail: "451 later" },
		]);
	});

	it("says when no message here has that id, or it is another provider's", () => {
		const { record, rows } = mailbox();
		expect(record({ messageId: "<other@cf>" })).toBe(false);
		expect(record({ provider: "resend" })).toBe(false);
		expect(rows()).toEqual([]);
	});

	it("ends the same whatever order the events come in, and however often", () => {
		const events: Partial<DeliveryEvent>[] = [
			{ state: "deferred", at: 1000, detail: "451 try later" },
			{ state: "delivered", at: 2000 },
			{ state: "complained", at: 9000 },
		];
		const orders = [
			[0, 1, 2],
			[2, 1, 0],
			[1, 0, 2, 0],
			[2, 0, 1, 2],
		];
		for (const order of orders) {
			const { record, rows } = mailbox();
			for (const index of order) record(events[index] ?? {});
			expect(rows()).toEqual([
				{ recipient: "ada@example.org", state: "complained", at: 9000, detail: null },
			]);
		}
	});

	it("never lets a delay hide a delivery or a bounce", () => {
		const { record, rows } = mailbox();
		record({ state: "bounced", at: 1000, detail: "550 5.1.1 User unknown" });
		record({ state: "deferred", at: 5000, detail: "451 later" });
		record({ state: "delivered", at: 6000 });
		expect(rows()).toEqual([
			{
				recipient: "ada@example.org",
				state: "bounced",
				at: 1000,
				detail: "550 5.1.1 User unknown",
			},
		]);
	});

	it("takes the newer of two events of the same rank", () => {
		const { record, rows } = mailbox();
		record({ state: "deferred", at: 2000, detail: "second" });
		record({ state: "deferred", at: 1000, detail: "first" });
		expect(rows()).toEqual([
			{ recipient: "ada@example.org", state: "deferred", at: 2000, detail: "second" },
		]);
		record({ state: "failed", at: 3000, detail: "delivery_failed" });
		record({ state: "bounced", at: 4000, detail: "550" });
		expect(rows()).toEqual([
			{ recipient: "ada@example.org", state: "bounced", at: 4000, detail: "550" },
		]);
	});

	it("cuts what a server said short", () => {
		const { record, rows } = mailbox();
		record({ state: "bounced", detail: "x".repeat(MAX_DELIVERY_DETAIL + 50) });
		expect(rows()).toEqual([expect.objectContaining({ detail: "x".repeat(MAX_DELIVERY_DETAIL) })]);
	});

	it("lets the records go with their message", () => {
		const { db, record, rows } = mailbox();
		record({});
		db.prepare("DELETE FROM message WHERE id = 'm1'").run();
		expect(rows()).toEqual([]);
	});

	it("gives a listing's row its records as JSON, and an empty list before any", () => {
		const { db, record } = mailbox();
		const json = () =>
			(
				db
					.prepare(`SELECT ${DELIVERIES_JSON} AS deliveries FROM message WHERE id = 'm1'`)
					.get() as {
					deliveries: string;
				}
			).deliveries;
		expect(JSON.parse(json())).toEqual([]);
		record({ state: "bounced", detail: "550" });
		expect(JSON.parse(json())).toEqual([
			{ recipient: "ada@example.org", state: "bounced", at: 1000, detail: "550" },
		]);
	});
});
