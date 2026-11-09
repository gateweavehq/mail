import { DELIVERY_RANK, type DeliveryState, MAX_DELIVERY_DETAIL } from "../../lib/delivery";
import type { SendsWith } from "../../lib/providers";
import { deliveryEventOf, writeSentEvent } from "./events";

/** One provider's delivery event for one recipient, as a mailbox records it. */
export interface DeliveryEvent {
	/** Whose id `messageId` is. */
	provider: SendsWith;
	/** The provider's id for the message: what Email Service's `send()` or Resend's API gave back. */
	messageId: string;
	recipient: string;
	state: DeliveryState;
	/** When it happened, by the provider's clock. */
	at: number;
	detail: string | null;
}

/** A state's rank in SQL, from `DELIVERY_RANK`. */
const rank = (column: string) =>
	`CASE ${column} ${Object.entries(DELIVERY_RANK)
		.map(([state, value]) => `WHEN '${state}' THEN ${value}`)
		.join(" ")} END`;

/**
 * Records an event for the message this mailbox sent under that id, unless the recipient's record
 * already says more: a state of a higher rank, or a newer event of the same rank. The state, then
 * what was said, breaks a tie, so the record ends the same whatever order events come in. False
 * when no message here has that id, as when it was deleted, or never sent from here.
 *
 * A record that comes to tell of something new, as delivered after a delay or a complaint after
 * delivery, is told to the workspace's webhooks too, from the outbox, in the caller's transaction.
 */
export function recordDelivery(sql: SqlStorage, event: DeliveryEvent): boolean {
	const found = sql
		.exec<{ message: string }>(
			"SELECT message FROM outgoing WHERE provider_id = ? AND provider = ?",
			event.messageId,
			event.provider,
		)
		.toArray()[0];
	if (!found) return false;
	const recipient = event.recipient.trim().toLowerCase();
	const before = sql
		.exec<{ state: DeliveryState }>(
			"SELECT state FROM delivery WHERE message = ? AND recipient = ?",
			found.message,
			recipient,
		)
		.toArray()[0];
	// A row only when the record changed: one the event doesn't move on is left as it was.
	const after = sql
		.exec<{ state: DeliveryState; at: number; detail: string | null }>(
			`INSERT INTO delivery (message, recipient, state, at, detail) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (message, recipient) DO UPDATE SET
				state = excluded.state, at = excluded.at, detail = excluded.detail
			WHERE (${rank("excluded.state")}, excluded.at, excluded.state, coalesce(excluded.detail, ''))
				> (${rank("delivery.state")}, delivery.at, delivery.state, coalesce(delivery.detail, ''))
			RETURNING state, at, detail`,
			found.message,
			recipient,
			event.state,
			event.at,
			event.detail?.slice(0, MAX_DELIVERY_DETAIL) ?? null,
		)
		.toArray()[0];
	const type = after ? deliveryEventOf(after.state) : null;
	// Told once for each thing it tells of: a bounce that the provider then calls a failure is one.
	if (after && type && type !== (before ? deliveryEventOf(before.state) : null)) {
		writeSentEvent(sql, type, found.message, null, { address: recipient, ...after });
	}
	return true;
}

/** A message's recipients' records as one JSON array, for a listing's row. */
export const DELIVERIES_JSON = `(SELECT json_group_array(json_object('recipient', recipient,
		'state', state, 'at', at, 'detail', detail))
	FROM delivery WHERE delivery.message = message.id)`;

/**
 * How many addresses a message the mailbox sent went to, counted once each, for a listing's row: its
 * request's `to` and `cc`, each a list or one address.
 */
export const RECIPIENT_COUNT = `(SELECT count(DISTINCT lower(trim(address.value))) FROM outgoing
	JOIN json_each(outgoing.request) AS field ON field.key IN ('to', 'cc')
	JOIN json_each(CASE field.type WHEN 'array' THEN field.value ELSE json_array(field.value) END)
		AS address
	WHERE outgoing.message = message.id AND address.type = 'text')`;
