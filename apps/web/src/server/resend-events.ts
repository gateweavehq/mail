import { z } from "zod";
import type { DeliveryState } from "../lib/delivery";
import { SUPPRESSION_DAYS } from "../lib/suppressions";
import {
	codeOfReply,
	type DeliveryRecorder,
	type EventDirectory,
	FIND_WINDOW_MS,
	failureOf,
	noSuchMailbox,
	type SuppressionSaid,
	said,
	split,
} from "./delivery-events";
import type { DeliveryEvent } from "./mailbox/deliveries";
import { DELIVERY_EVENTS, type DeliveryEventType } from "./providers/resend";
import type { NewSuppression } from "./suppressions";

/**
 * What became of mail sent through Resend, which the workspace's webhook tells once its signature
 * is checked (`resend-inbound.ts`). Each event names the message by the id Resend gave when it took
 * it, which the mailbox kept, and the one recipient it is about.
 *
 * The rules this keeps, beside those of `delivery-events.ts`, whose records and lists it fills:
 *
 * - The webhook is the workspace's own, in the Resend account of its key, but that account may send
 *   for others too. So an event counts only when it was sent from an address of a mailbox of this
 *   workspace, on a domain it proved.
 * - Resend tries a delivery again until it gets a success, for about a day, and turns off a webhook
 *   that keeps failing. So Mail answers with a success once the event is recorded, or once trying
 *   again can't help: an event it can't read, or for a message not found after `FIND_WINDOW_MS`.
 */

/** Text fields of an event's parts, any of which may be missing. */
const Part = z.record(z.string(), z.unknown()).optional().catch(undefined);

const ResendEmailEvent = z.object({
	type: z.string().max(100),
	created_at: z.string().max(64).optional().catch(undefined),
	data: z.object({
		email_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
		from: z.string().min(3).max(1_000),
		to: z.array(z.string().max(1_000)).min(1).max(50),
		bounce: Part,
		failed: Part,
		suppressed: Part,
	}),
});

type Data = z.infer<typeof ResendEmailEvent>["data"];

/** An event Mail can act on: the address it was sent from, and what it says of each recipient. */
export interface ReadResendEvent {
	/** In lower case. */
	sender: string;
	events: { event: DeliveryEvent; suppression: SuppressionSaid | null }[];
}

export const isDeliveryEvent = (type: string): type is DeliveryEventType =>
	Object.hasOwn(DELIVERY_EVENTS, type);

/** `Name <a@b>` or `a@b` as a bare address in lower case, or null. */
export function bareAddress(text: string): string | null {
	const inside = /<([^<>]*)>\s*$/.exec(text)?.[1] ?? text;
	const address = inside.trim().toLowerCase();
	return /^[^\s@<>]+@[^\s@<>]+$/.test(address) ? address : null;
}

/** The receiving server's first reply, without the `smtp; ` Resend puts before it. */
function diagnostic(bounce: Data["bounce"]): string | null {
	const codes = bounce?.diagnosticCode;
	const first = Array.isArray(codes) ? codes.find((code) => typeof code === "string") : codes;
	return typeof first === "string" ? first.replace(/^\s*smtp;\s*/i, "") : null;
}

/** What to show for a state: the server's reply or Resend's words, whichever the event has. */
function detailOf(state: DeliveryState, data: Data): string | null {
	switch (state) {
		case "bounced":
			return said(diagnostic(data.bounce), data.bounce?.message);
		case "failed":
			return said(data.failed?.reason);
		case "rejected":
			return said(data.suppressed?.message, data.suppressed?.reason);
		default:
			return null;
	}
}

/**
 * Whether the event stops mail to its recipient, by the rules Email Service's events follow: every
 * complaint; a bounce only when it is permanent, for good when the server says the mailbox or domain
 * doesn't exist; and Resend's own list keeping it from the address, which a bounce of the subtype
 * `Suppressed` says too.
 */
function suppressionOf(state: DeliveryState, data: Data): SuppressionSaid | null {
	switch (state) {
		case "complained":
			return { reason: "complained", forever: true };
		case "bounced":
			if (data.bounce?.type !== "Permanent") return null;
			if (data.bounce.subType === "Suppressed") return { reason: "rejected", forever: false };
			return { reason: "bounced", forever: noSuchMailbox(codeOfReply(diagnostic(data.bounce))) };
		case "rejected":
			return { reason: "rejected", forever: false };
		default:
			return null;
	}
}

/**
 * A Resend event about sent mail as Mail records it, or null for anything else: another type, or a
 * shape it can't read. `receivedAt` stands in for an event without a time.
 */
export function readResendEvent(body: unknown, receivedAt: number): ReadResendEvent | null {
	const parsed = ResendEmailEvent.safeParse(body);
	if (!parsed.success || !isDeliveryEvent(parsed.data.type)) return null;
	const { type, created_at, data } = parsed.data;
	const sender = bareAddress(data.from);
	const recipients = [...new Set(data.to.map(bareAddress).filter((address) => address !== null))];
	if (!sender || recipients.length === 0) return null;
	const state = DELIVERY_EVENTS[type];
	const time = Date.parse(created_at ?? "");
	const at = Number.isFinite(time) ? time : receivedAt;
	const detail = detailOf(state, data);
	const suppression = suppressionOf(state, data);
	return {
		sender,
		events: recipients.map((recipient) => ({
			event: { provider: "resend", messageId: data.email_id, recipient, state, at, detail },
			suppression,
		})),
	};
}

/** What became of one event, and what Resend is told: 503 to have it come again. */
export type ResendEventOutcome =
	| { status: 200; outcome: "recorded" | "notOurs" | "notFound"; suppressed: number }
	| { status: 503; outcome: "waiting"; suppressed: number }
	| { status: 503; outcome: "failed"; failure: string };

/**
 * Records an event in the mailbox of this workspace that sent the message, and adds its recipient
 * to the workspace's suppression list when it says to. Any event counts for the list only for a
 * message the mailbox has, Resend's list too: unlike Email Service, Resend takes the message and
 * gives its id before it leaves out an address on its list. Recording only moves forward and adding
 * to a list twice changes nothing, so an event that comes again does no harm.
 */
export async function recordResendEvent(
	read: ReadResendEvent,
	workspaceId: string,
	directory: EventDirectory,
	mailbox: (id: string) => DeliveryRecorder,
	now = Date.now(),
): Promise<ResendEventOutcome> {
	let found: boolean[];
	let sentBy: { mailboxId: string; workspaceId: string } | undefined;
	try {
		sentBy = (await directory.mailboxesOf(new Set([read.sender]))).get(read.sender);
		if (!sentBy || sentBy.workspaceId !== workspaceId) {
			return { status: 200, outcome: "notOurs", suppressed: 0 };
		}
		const domain = split(read.sender)?.domain;
		if (domain) await directory.eventsCame([domain], now, { provider: "resend", workspaceId });
	} catch (error) {
		return { status: 503, outcome: "failed", failure: failureOf("directory", error) };
	}
	try {
		found = await mailbox(sentBy.mailboxId).recordDeliveries(read.events.map(({ event }) => event));
	} catch (error) {
		return { status: 503, outcome: "failed", failure: failureOf("mailbox", error) };
	}

	const suppressions: NewSuppression[] = [];
	read.events.forEach(({ event, suppression }, index) => {
		if (!suppression || found[index] !== true) return;
		suppressions.push({
			workspaceId,
			address: event.recipient,
			reason: suppression.reason,
			provider: event.provider,
			detail: event.detail,
			at: event.at,
			expiresAt: suppression.forever ? null : event.at + SUPPRESSION_DAYS * 24 * 60 * 60 * 1000,
		});
	});
	if (suppressions.length > 0) {
		try {
			await directory.suppress(suppressions, now);
		} catch (error) {
			return { status: 503, outcome: "failed", failure: failureOf("suppressions", error) };
		}
	}

	const suppressed = suppressions.length;
	if (found.every((one) => one === true)) return { status: 200, outcome: "recorded", suppressed };
	// Resend may tell of a message before the mailbox has kept the id it gave: look again a little.
	const at = Math.min(...read.events.map(({ event }) => event.at));
	if (now - at < FIND_WINDOW_MS) return { status: 503, outcome: "waiting", suppressed };
	return { status: 200, outcome: "notFound", suppressed };
}
