import { DELIVERY_RANK, type DeliveryState, MAX_DELIVERY_DETAIL } from "../../lib/delivery";
import type { SendsWith } from "../../lib/providers";

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
 * already says more: a state of a higher rank, or a newer event of the same rank. False when no
 * message here has that id, as when it was deleted, or never sent from here.
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
	sql.exec(
		`INSERT INTO delivery (message, recipient, state, at, detail) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (message, recipient) DO UPDATE SET
			state = excluded.state, at = excluded.at, detail = excluded.detail
		WHERE ${rank("excluded.state")} > ${rank("delivery.state")}
			OR (${rank("excluded.state")} = ${rank("delivery.state")} AND excluded.at >= delivery.at)`,
		found.message,
		event.recipient.trim().toLowerCase(),
		event.state,
		event.at,
		event.detail?.slice(0, MAX_DELIVERY_DETAIL) ?? null,
	);
	return true;
}

/** A message's recipients' records as one JSON array, for a listing's row. */
export const DELIVERIES_JSON = `(SELECT json_group_array(json_object('recipient', recipient,
		'state', state, 'at', at, 'detail', detail))
	FROM delivery WHERE delivery.message = message.id)`;
