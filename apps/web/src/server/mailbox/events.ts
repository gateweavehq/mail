import type { DeliveryState } from "../../lib/delivery";
import type { DeliveryEventType, SentEventType } from "../../lib/webhooks";

/**
 * Which event, if any, tells of a recipient's server coming to this state. A delay alone tells of
 * nothing; mail refused before or after it left counts as bounced, and the recipient's state says
 * which.
 */
export function deliveryEventOf(state: DeliveryState): DeliveryEventType | null {
	switch (state) {
		case "deferred":
			return null;
		case "delivered":
			return "message.delivered";
		case "bounced":
		case "failed":
		case "rejected":
			return "message.bounced";
		case "complained":
			return "message.complained";
	}
}

/**
 * What an event about a message the mailbox sends tells of, taken when it happened: the message
 * may be deleted before the outbox is emptied, as a rejected one is at once, and a recipient's
 * state may move on.
 */
export interface SentFacts {
	message: {
		id: string;
		threadId: string;
		writtenAt: number;
		/** The From header, as written. */
		from: string | null;
		to: string[];
		cc: string[];
		/** The Subject header, as written. */
		subject: string | null;
		/** Memberships, by id. */
		writtenBy: string | null;
		approvedBy: string | null;
	};
	/** The membership that did what the event tells of; null for what a recipient's server did. */
	by: string | null;
	recipient: { address: string; state: DeliveryState; at: number; detail: string | null } | null;
}

/** The addresses in a request's `to` or `cc`: one or a list, each written out or as `{ email }`. */
export function listed(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(listed);
	if (typeof value === "string") return [value];
	if (value && typeof value === "object" && "email" in value && typeof value.email === "string") {
		return [value.email];
	}
	return [];
}

/**
 * Writes an event about a message this mailbox sends into its outbox, with the message as it is
 * now. Called in the transaction that makes the change it tells of, so the one is kept if and only
 * if the other is. `by` is whoever did it; left out, it is who approved the message, or else who
 * wrote it, as for a send the alarm tried again. Nothing when no stored message here has that id.
 */
export function writeSentEvent(
	sql: SqlStorage,
	type: SentEventType,
	messageId: string,
	by?: string | null,
	recipient: SentFacts["recipient"] = null,
): void {
	const row = sql
		.exec<{
			threadId: string | null;
			writtenAt: number;
			from: string | null;
			subject: string | null;
			writtenBy: string | null;
			approvedBy: string | null;
			request: string;
		}>(
			`SELECT message.thread_id AS threadId, message.arrived_at AS writtenAt,
				message.from_header AS "from", message.subject AS subject, message.sent_by AS writtenBy,
				outgoing.approved_by AS approvedBy, outgoing.request AS request
			FROM message JOIN outgoing ON outgoing.message = message.id
			WHERE message.id = ? AND message.state = 'stored'`,
			messageId,
		)
		.toArray()[0];
	if (!row || row.threadId === null) return;
	const request = JSON.parse(row.request) as { to?: unknown; cc?: unknown };
	const facts: SentFacts = {
		message: {
			id: messageId,
			threadId: row.threadId,
			writtenAt: row.writtenAt,
			from: row.from,
			to: listed(request.to),
			cc: listed(request.cc),
			subject: row.subject,
			writtenBy: row.writtenBy,
			approvedBy: row.approvedBy,
		},
		by: by === undefined ? (row.approvedBy ?? row.writtenBy) : by,
		recipient,
	};
	sql.exec(
		"INSERT INTO event (id, type, message, at, data) VALUES (?, ?, ?, ?, ?)",
		crypto.randomUUID(),
		type,
		messageId,
		Date.now(),
		JSON.stringify(facts),
	);
}
