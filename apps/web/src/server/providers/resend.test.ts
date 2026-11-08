import { describe, expect, it } from "vitest";
import { failureOf, resendBody } from "./resend";

describe("resendBody", () => {
	it("makes Resend's request from what Email Service's binding is given", () => {
		expect(
			resendBody({
				from: { name: "Support", email: "help@example.com" },
				to: ["ada@example.org"],
				cc: ["bob@example.org"],
				subject: "Re: Hello",
				text: "Hi",
				headers: { References: "<a@x> <b@x>", "In-Reply-To": "<b@x>" },
			}),
		).toEqual({
			from: "Support <help@example.com>",
			to: ["ada@example.org"],
			cc: ["bob@example.org"],
			subject: "Re: Hello",
			text: "Hi",
			headers: { References: "<a@x> <b@x>", "In-Reply-To": "<b@x>" },
		});
	});

	it("quotes a name that an address header can't hold as it is", () => {
		const from = (name: string) =>
			resendBody({ from: { name, email: "a@example.com" }, to: "b@example.com", subject: "" }).from;
		expect(from('Ops, "night" team')).toBe('"Ops, \\"night\\" team" <a@example.com>');
		expect(from("Café")).toBe('"Café" <a@example.com>');
		expect(from("  ")).toBe("a@example.com");
	});
});

describe("failureOf", () => {
	it("refuses what Resend read and turned down, which spends the key", () => {
		expect(
			failureOf(403, {
				name: "validation_error",
				message: "The example.com domain is not verified.",
			}),
		).toEqual({
			kind: "refused",
			code: "resend:validation_error",
			detail: "The example.com domain is not verified.",
			answered: true,
		});
		expect(failureOf(422, { name: "missing_required_field" })).toMatchObject({
			kind: "refused",
			answered: true,
		});
	});

	it("waits out a busy moment or a daily quota, and stops at a monthly one", () => {
		expect(failureOf(429, { name: "rate_limit_exceeded" })).toMatchObject({ kind: "busy" });
		expect(failureOf(429, { name: "daily_quota_exceeded" })).toMatchObject({ kind: "daily" });
		expect(failureOf(429, { name: "monthly_quota_exceeded" })).toMatchObject({
			kind: "refused",
			answered: false,
		});
	});

	it("takes Resend's failure, or the same key still being sent, as maybe sent", () => {
		expect(failureOf(500, { name: "application_error" })).toMatchObject({
			kind: "unsure",
			code: "resend:application_error",
			answered: false,
		});
		expect(failureOf(503, null)).toMatchObject({ kind: "unsure", code: "resend:503" });
		expect(failureOf(409, { name: "concurrent_idempotent_requests" })).toMatchObject({
			kind: "unsure",
			answered: false,
		});
	});

	it("keeps only a name Resend could have given, and a short message", () => {
		const failure = failureOf(400, { name: "<b>odd</b>", message: "x".repeat(1000) });
		expect(failure.code).toBe("resend:400");
		expect(failure.detail).toHaveLength(300);
	});
});
