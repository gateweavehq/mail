import { describe, expect, it } from "vitest";
import { isAgentMember } from "./agents";

describe("an agent among the members", () => {
	it("is the agent's role on an agent's address, as the agents plugin makes them", () => {
		expect(isAgentMember({ role: "agent", email: "a1b2@agents.invalid" })).toBe(true);
		expect(isAgentMember({ role: "agent", email: "A1B2@Agents.Invalid " })).toBe(true);
	});

	it("isn't a person given the role by hand, nor anyone with another role", () => {
		expect(isAgentMember({ role: "agent", email: "ada@example.org" })).toBe(false);
		expect(isAgentMember({ role: "member", email: "a1b2@agents.invalid" })).toBe(false);
		expect(isAgentMember({ role: "agent", email: "ada@agents.invalid.example.org" })).toBe(false);
	});
});
