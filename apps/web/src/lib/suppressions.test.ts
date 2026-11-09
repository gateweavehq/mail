import { describe, expect, it } from "vitest";
import { removalWords, suppressionMeaning } from "./suppressions";

describe("what the page says once an address is removed", () => {
	const removed = (...providers: Parameters<typeof removalWords>[1]) =>
		removalWords("ada@example.org", providers);

	it("names the address, and adds nothing when no provider's list had it", () => {
		expect(removed()).toBe("Removed ada@example.org.");
		expect(removed({ provider: "resend", outcome: "notListed" })).toBe("Removed ada@example.org.");
		expect(removed({ provider: "cloudflare", outcome: "done", removed: 0, kept: 0 })).toBe(
			"Removed ada@example.org.",
		);
	});

	it("says which providers' lists it came off", () => {
		expect(
			removed(
				{ provider: "resend", outcome: "removed" },
				{ provider: "cloudflare", outcome: "done", removed: 2, kept: 0 },
			),
		).toBe(
			"Removed ada@example.org. Resend's own list no longer has it either. Email Service's own list no longer has it either.",
		);
	});

	it("says when a provider's list may still refuse it, and who can change that", () => {
		expect(removed({ provider: "resend", outcome: "sendingOnly" })).toContain("can only send");
		expect(removed({ provider: "resend", outcome: "failed" })).toContain("didn't answer");
		expect(removed({ provider: "cloudflare", outcome: "notSetUp" })).toContain(
			"only whoever runs this deployment",
		);
		expect(removed({ provider: "cloudflare", outcome: "failed" })).toContain("couldn't be checked");
		// An entry it kept still stops the mail, whatever else came off.
		const kept = removed({ provider: "cloudflare", outcome: "done", removed: 1, kept: 1 });
		expect(kept).toContain("still has it");
		expect(kept).not.toContain("no longer");
	});
});

describe("what a suppression means", () => {
	it("calls a bounce for good only when the entry never ends", () => {
		expect(suppressionMeaning("bounced", null)).toContain("for good");
		const week = Date.now() + 7 * 24 * 60 * 60 * 1000;
		expect(suppressionMeaning("bounced", week)).toBe("Their mail server refused mail to it.");
	});
});
