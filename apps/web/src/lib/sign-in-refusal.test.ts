import { describe, expect, it } from "vitest";
import { signInRefusal } from "./sign-in-refusal";

describe("signInRefusal", () => {
	it("says nothing when nothing was refused", () => {
		expect(signInRefusal(undefined)).toBeNull();
		expect(signInRefusal("")).toBeNull();
	});

	it("explains an address that cannot be linked to its account", () => {
		expect(signInRefusal("account_not_linked")).toContain("already has an account");
	});

	it("answers anything else in its own words, whatever the link says", () => {
		const message = signInRefusal("<script>alert(1)</script>");
		expect(message).toContain("did not work");
		expect(message).not.toContain("script");
		// Not the prototype's, which a lookup on a plain object would find.
		expect(signInRefusal("constructor")).toBe(message);
	});
});
