import { describe, expect, it } from "vitest";
import { suppressionMeaning } from "./suppressions";

describe("what a suppression means", () => {
	it("calls a bounce for good only when the entry never ends", () => {
		expect(suppressionMeaning("bounced", null)).toContain("for good");
		const week = Date.now() + 7 * 24 * 60 * 60 * 1000;
		expect(suppressionMeaning("bounced", week)).toBe("Their mail server refused mail to it.");
	});
});
