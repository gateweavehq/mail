import { describe, expect, it } from "vitest";
import type { ResendFailure } from "../providers/resend";
import { errorCode, outcomeOf, resendOutcome, WAITS_MS } from "./delivery";

const coded = (code: string) => Object.assign(new Error("Refused"), { code });

describe("errorCode", () => {
	it("reads Email Service's code, or finds one in the message", () => {
		expect(errorCode(coded("E_RECIPIENT_SUPPRESSED"))).toBe("E_RECIPIENT_SUPPRESSED");
		expect(errorCode(new Error("E_DELIVERY_FAILED: the server said no"))).toBe("E_DELIVERY_FAILED");
	});

	it("finds none in an error that isn't Email Service's", () => {
		expect(errorCode(new Error("Network connection lost"))).toBeNull();
		expect(errorCode(coded("ECONNRESET"))).toBeNull();
		expect(errorCode("E_RATE_LIMIT_EXCEEDED")).toBeNull();
	});
});

describe("outcomeOf", () => {
	const now = 1_000_000;

	it("takes an error without a code as maybe sent, never to be tried again by itself", () => {
		expect(outcomeOf(new Error("Network connection lost"), 1, now)).toEqual({
			state: "uncertain",
			code: null,
		});
	});

	it("takes Email Service's own failure as maybe sent, as it may come after the message went", () => {
		expect(outcomeOf(coded("E_INTERNAL_SERVER_ERROR"), 1, now)).toEqual({
			state: "uncertain",
			code: "E_INTERNAL_SERVER_ERROR",
		});
	});

	it("takes a refusal as final", () => {
		for (const code of ["E_RECIPIENT_SUPPRESSED", "E_SENDER_NOT_VERIFIED", "E_SOMETHING_NEW"]) {
			expect(outcomeOf(coded(code), 1, now)).toEqual({ state: "refused", code });
		}
	});

	it("waits longer after each busy try, then gives up", () => {
		const busy = coded("E_RATE_LIMIT_EXCEEDED");
		const waits = WAITS_MS.busy.map((_, i) => {
			const outcome = outcomeOf(busy, i + 1, now);
			return outcome.state === "waiting" ? outcome.nextAt - now : null;
		});
		expect(waits).toEqual(WAITS_MS.busy);
		expect(waits.every((wait, i) => i === 0 || (wait ?? 0) > (waits[i - 1] ?? 0))).toBe(true);
		expect(outcomeOf(busy, WAITS_MS.busy.length + 1, now)).toEqual({
			state: "refused",
			code: "E_RATE_LIMIT_EXCEEDED",
		});
	});

	it("waits hours for a daily quota to come back", () => {
		const outcome = outcomeOf(coded("E_DAILY_LIMIT_EXCEEDED"), 1, now);
		expect(outcome).toEqual({
			state: "waiting",
			code: "E_DAILY_LIMIT_EXCEEDED",
			nextAt: now + 60 * 60 * 1000,
		});
	});
});

describe("resendOutcome", () => {
	const now = 1_000_000;
	const failure = (kind: ResendFailure["kind"], code = `resend:${kind}`): ResendFailure => ({
		kind,
		code,
		detail: null,
		answered: kind === "refused",
	});

	it("refuses what Resend refused, at once", () => {
		expect(resendOutcome(failure("refused", "resend:validation_error"), 1, now)).toEqual({
			state: "refused",
			code: "resend:validation_error",
		});
	});

	it("tries again what may have gone, since Resend knows it by its key", () => {
		expect(resendOutcome(failure("unsure", "resend:unreachable"), 1, now)).toEqual({
			state: "waiting",
			code: "resend:unreachable",
			nextAt: now + (WAITS_MS.busy[0] ?? 0),
		});
	});

	it("leaves what may have gone uncertain once the tries run out", () => {
		const last = WAITS_MS.busy.length + 1;
		expect(resendOutcome(failure("unsure", "resend:application_error"), last, now)).toEqual({
			state: "uncertain",
			code: "resend:application_error",
		});
	});

	it("waits hours over a daily quota, and refuses busy mail once the tries run out", () => {
		expect(resendOutcome(failure("daily"), 2, now)).toEqual({
			state: "waiting",
			code: "resend:daily",
			nextAt: now + (WAITS_MS.daily[1] ?? 0),
		});
		expect(resendOutcome(failure("busy"), WAITS_MS.busy.length + 1, now)).toEqual({
			state: "refused",
			code: "resend:busy",
		});
	});
});
