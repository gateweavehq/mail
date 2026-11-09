import { COPY_UNREAD_CODE } from "../../lib/outbox";
import type { ResendFailure } from "../providers/resend";

/**
 * What Email Service's answers mean for a message the mailbox sends. Email Service has no
 * idempotency, so only an answer that says the message didn't go is tried again by Mail itself:
 * anything that leaves it unknown is "uncertain", for a person to decide, since sending again could
 * send it twice.
 */

/** How long a try may go without saying how it went before the message counts as uncertain. */
export const STALE_SENDING_MS = 10 * 60 * 1000;

/** Codes that say Email Service was busy or out of quota, and sent nothing. */
const LATER = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"]);

/**
 * Codes that leave it unknown whether the message went: Email Service's own failure may come after
 * it took the message.
 */
const UNKNOWN = new Set(["E_INTERNAL_SERVER_ERROR"]);

/**
 * How long to wait before each try after the first, by what stopped the one before. A busy moment
 * passes in seconds or minutes, a daily quota comes back in hours. After the last, the message is
 * refused.
 */
export const WAITS_MS: Record<"busy" | "daily", number[]> = {
	busy: [15, 60, 300, 1800, 7200].map((seconds) => seconds * 1000),
	daily: [3600, 3 * 3600, 6 * 3600, 12 * 3600].map((seconds) => seconds * 1000),
};

/** What became of a try. */
export type Outcome =
	| { state: "waiting"; code: string; nextAt: number }
	| { state: "refused"; code: string }
	| { state: "uncertain"; code: string | null };

/**
 * Email Service's code for an error, such as `E_RECIPIENT_SUPPRESSED`: its `code`, or the first
 * such code in its message, where an error that crossed a binding keeps it. Null when there is none.
 */
export function errorCode(error: unknown): string | null {
	if (error instanceof Error) {
		const code = "code" in error ? error.code : undefined;
		if (typeof code === "string" && /^E_[A-Z_]+$/.test(code)) return code;
		return /\bE_[A-Z][A-Z_]*\b/.exec(error.message)?.[0] ?? null;
	}
	return null;
}

/** What a failed try means, given the error and how many tries there have been, this one too. */
export function outcomeOf(error: unknown, attempts: number, now: number): Outcome {
	const code = errorCode(error);
	// No code is no answer: the request may have reached Email Service and the message gone.
	if (code === null) return { state: "uncertain", code: null };
	if (UNKNOWN.has(code)) return { state: "uncertain", code };
	if (!LATER.has(code)) return { state: "refused", code };
	const wait = WAITS_MS[code === "E_DAILY_LIMIT_EXCEEDED" ? "daily" : "busy"][attempts - 1];
	return wait === undefined
		? { state: "refused", code }
		: { state: "waiting", code, nextAt: now + wait };
}

/**
 * What a try means that couldn't read the message's files from its copy, when no provider was asked.
 * R2 failing is a moment that passes, tried again as a busy one is. A copy that is gone, or doesn't
 * hold the files it should, stops the message: refused, or uncertain if an earlier try may have sent
 * it.
 */
export function copyOutcome(
	kind: "unavailable" | "wrong",
	attempts: number,
	now: number,
	earlierMaybeSent: boolean,
): Outcome {
	const stop: Outcome = earlierMaybeSent
		? { state: "uncertain", code: COPY_UNREAD_CODE }
		: { state: "refused", code: COPY_UNREAD_CODE };
	if (kind === "wrong") return stop;
	const wait = WAITS_MS.busy[attempts - 1];
	return wait === undefined
		? stop
		: { state: "waiting", code: COPY_UNREAD_CODE, nextAt: now + wait };
}

/**
 * What a failed try through Resend means. Resend knows each message by its key for a day, so one
 * that may have gone is tried again too, and only when the tries run out is it uncertain. One that
 * stayed busy or over quota until then is refused, since nothing went.
 *
 * Unless an earlier try under the same key may have sent it (`earlierMaybeSent`): then a refusal or
 * the end of the tries leaves it uncertain, since Resend checks a key before it looks for what that
 * key sent, and a refusal now doesn't say the earlier try didn't go.
 */
export function resendOutcome(
	failure: ResendFailure,
	attempts: number,
	now: number,
	earlierMaybeSent = false,
): Outcome {
	const { kind, code } = failure;
	const stop: Outcome =
		earlierMaybeSent || kind === "unsure"
			? { state: "uncertain", code }
			: { state: "refused", code };
	if (kind === "refused") return stop;
	const wait = WAITS_MS[kind === "daily" ? "daily" : "busy"][attempts - 1];
	return wait === undefined ? stop : { state: "waiting", code, nextAt: now + wait };
}
