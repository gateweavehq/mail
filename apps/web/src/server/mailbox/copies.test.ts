import { describe, expect, it } from "vitest";
import { COPIES_WITHIN_MS, type Copy, cameAlso } from "./copies";

const at = Date.UTC(2026, 10, 13, 9);

/** The copy a mailbox kept: for its own address, proved to come from bank.example. */
const kept: Copy = {
	envelopeTo: "inbox@acme.example",
	cameFor: null,
	verifiedDomain: "bank.example",
	arrivedAt: at,
	addressed: 1,
};

/** A copy of the same mail for an agent's address. */
const forAgent = (changes: Partial<Copy> = {}): Copy => ({
	envelopeTo: "Agent@Acme.example",
	cameFor: "agent-member",
	verifiedDomain: "bank.example",
	arrivedAt: at,
	addressed: 0,
	...changes,
});

describe("cameAlso", () => {
	it("adds a copy that comes soon after, and its agent", () => {
		expect(cameAlso(kept, forAgent(), at + 60_000)).toEqual({
			envelopeTo: "inbox@acme.example, agent@acme.example",
			cameFor: "agent-member",
		});
	});

	// A sender that was told to try again can come back days later (MAIL-48).
	it("adds a copy that comes long after, when its sender is proved to have addressed it there", () => {
		const late = at + 3 * 24 * COPIES_WITHIN_MS;
		expect(cameAlso(kept, forAgent({ addressed: 1, arrivedAt: late }), late)).toEqual({
			envelopeTo: "inbox@acme.example, agent@acme.example",
			cameFor: "agent-member",
		});
	});

	// Someone who has the mail can send it again, word for word, to an agent's address.
	it("adds nothing from a copy that comes long after and wasn't proved addressed there", () => {
		const late = at + COPIES_WITHIN_MS + 1;
		expect(cameAlso(kept, forAgent({ arrivedAt: late }), late)).toBeNull();
	});

	it("adds nothing from a copy proved otherwise than the kept one, whenever it comes", () => {
		for (const verifiedDomain of [null, "other.example"]) {
			expect(cameAlso(kept, forAgent({ verifiedDomain }), at + 60_000)).toBeNull();
			expect(cameAlso(kept, forAgent({ verifiedDomain, addressed: 1 }), at + 60_000)).toBeNull();
		}
	});

	it("changes nothing for a retry of the kept copy", () => {
		const theirs = { ...kept, envelopeTo: "agent@acme.example", cameFor: "agent-member" };
		expect(cameAlso(theirs, forAgent(), at + 60_000)).toBeNull();
		expect(cameAlso(theirs, forAgent({ addressed: 1 }), at + 2 * COPIES_WITHIN_MS)).toBeNull();
	});

	it("keeps the agent the kept copy came for: one message counts for one agent", () => {
		const theirs = { ...kept, envelopeTo: "agent@acme.example", cameFor: "agent-member" };
		const other = forAgent({ envelopeTo: "other@acme.example", cameFor: "another" });
		expect(cameAlso(theirs, other, at + 60_000)).toEqual({
			envelopeTo: "agent@acme.example, other@acme.example",
			cameFor: "agent-member",
		});
	});

	it("stops adding addresses past the longest list", () => {
		const full = { ...kept, envelopeTo: `${"a".repeat(1_990)}@acme.example` };
		expect(cameAlso(full, forAgent({ addressed: 1 }), at)).toBeNull();
	});
});
