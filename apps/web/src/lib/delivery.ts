/**
 * What became of a sent message at one recipient's mail server, as the provider's delivery events
 * say. Sending ends when the provider takes a message; these come after, one recipient at a time.
 */
export const DELIVERY_STATES = [
	"deferred",
	"delivered",
	"bounced",
	"failed",
	"rejected",
	"complained",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * How far along each state is. A recipient's record only moves to a state that ranks higher, or to
 * a newer event of the same rank, so events that arrive twice or out of order end the same: a delay
 * never hides a delivery or a bounce, and a complaint comes after delivery.
 */
export const DELIVERY_RANK: Record<DeliveryState, number> = {
	deferred: 0,
	delivered: 1,
	bounced: 2,
	failed: 2,
	rejected: 2,
	complained: 3,
};

/** The most a detail keeps of what the receiving server or the provider said, in characters. */
export const MAX_DELIVERY_DETAIL = 300;

// A type, not an interface, so that SQLite's rows can be read as it.
/** One recipient's record. */
export type Delivery = {
	/** Lower case. */
	recipient: string;
	state: DeliveryState;
	/** When the event that set the state happened. */
	at: number;
	/** What the receiving server or the provider said, as they said it, cut short. */
	detail: string | null;
};

/** A word or two for a recipient's state, beside their address. */
export function deliveryLabel(state: DeliveryState): string {
	switch (state) {
		case "deferred":
			return "Delayed";
		case "delivered":
			return "Delivered";
		case "bounced":
			return "Bounced";
		case "failed":
			return "Not delivered";
		case "rejected":
			return "Not sent";
		case "complained":
			return "Marked as spam";
	}
}

/** What a state means, for whoever reads the thread. */
export function deliveryMeaning(state: DeliveryState): string {
	switch (state) {
		case "deferred":
			return "Their mail server didn't take it yet, so it is being tried again.";
		case "delivered":
			return "Their mail server took it.";
		case "bounced":
			return "Their mail server refused it.";
		case "failed":
			return "It couldn't be delivered.";
		case "rejected":
			return "It wasn't sent to them, as happens when their address bounced before.";
		case "complained":
			return "They marked it as spam.";
	}
}

/** Whether something went wrong for a recipient, which the thread shows first. */
export const isTrouble = (state: DeliveryState) => DELIVERY_RANK[state] >= 2;
