import { describe, expect, it } from "vitest";
import { type Delivery, type DeliveryState, troubleLabel } from "./delivery";

const records = (...states: DeliveryState[]): Delivery[] =>
	states.map((state, index) => ({
		recipient: `r${index}@example.org`,
		state,
		at: 0,
		detail: null,
	}));

describe("the trouble on a sent message's line", () => {
	it("has none while nothing went wrong", () => {
		expect(troubleLabel([], 2)).toBeNull();
		expect(troubleLabel(records("delivered", "deferred"), 2)).toBeNull();
	});

	it("names the trouble when it hit everyone the message went to", () => {
		expect(troubleLabel(records("bounced"), 1)).toBe("Bounced");
		expect(troubleLabel(records("rejected", "rejected"), 2)).toBe("Not sent");
	});

	it("says how many it hit when it was some of several", () => {
		expect(troubleLabel(records("delivered", "bounced", "delivered"), 3)).toBe("1 bounced");
		expect(troubleLabel(records("rejected", "delivered"), 2)).toBe("1 not sent");
		expect(troubleLabel(records("failed", "failed"), 5)).toBe("2 not delivered");
		// Before every recipient's event has come.
		expect(troubleLabel(records("bounced"), 3)).toBe("1 bounced");
	});

	it("puts a complaint before a bounce", () => {
		expect(troubleLabel(records("bounced", "complained", "bounced"), 3)).toBe(
			"1 marked it as spam",
		);
		expect(troubleLabel(records("bounced", "complained"), 2)).toBe("1 marked it as spam");
	});

	it("names the trouble alone when how many recipients isn't known", () => {
		expect(troubleLabel(records("bounced", "delivered"), 0)).toBe("Bounced");
	});
});
