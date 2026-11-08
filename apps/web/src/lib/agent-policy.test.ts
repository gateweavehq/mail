import { describe, expect, it } from "vitest";
import {
	AgentPolicyInput,
	AllowedEntry,
	goesWithoutApproval,
	isAllowedRecipient,
	readAllowed,
} from "./agent-policy";

describe("isAllowedRecipient", () => {
	const allowed = ["ops@example.org", "@acme.test"];

	it("takes an allowed address, in any case", () => {
		expect(isAllowedRecipient("ops@example.org", allowed)).toBe(true);
		expect(isAllowedRecipient("Ops@Example.ORG", allowed)).toBe(true);
	});

	it("takes any address on an allowed domain", () => {
		expect(isAllowedRecipient("anyone@acme.test", allowed)).toBe(true);
	});

	it("doesn't take another address on an allowed address's domain", () => {
		expect(isAllowedRecipient("ceo@example.org", allowed)).toBe(false);
	});

	it("doesn't take a subdomain, or a domain that only ends the same", () => {
		expect(isAllowedRecipient("a@mail.acme.test", allowed)).toBe(false);
		expect(isAllowedRecipient("a@notacme.test", allowed)).toBe(false);
	});

	it("takes nothing when nothing is allowed", () => {
		expect(isAllowedRecipient("ops@example.org", [])).toBe(false);
	});
});

describe("goesWithoutApproval", () => {
	it("needs every recipient allowed", () => {
		expect(goesWithoutApproval(["a@acme.test", "b@acme.test"], ["@acme.test"])).toBe(true);
		expect(goesWithoutApproval(["a@acme.test", "b@other.test"], ["@acme.test"])).toBe(false);
	});

	it("doesn't take an empty list", () => {
		expect(goesWithoutApproval([], ["@acme.test"])).toBe(false);
	});
});

describe("AllowedEntry", () => {
	it("reads addresses and domains in lower case", () => {
		expect(AllowedEntry.parse(" Ops@Example.org ")).toBe("ops@example.org");
		expect(AllowedEntry.parse("@Acme.Test")).toBe("@acme.test");
	});

	it("refuses what is neither", () => {
		for (const entry of [
			"acme.test",
			"@",
			"@acme",
			"a@acme.test,b@acme.test",
			"@*.acme.test",
			"a@b",
		]) {
			expect(AllowedEntry.safeParse(entry).success).toBe(false);
		}
	});
});

describe("AgentPolicyInput", () => {
	it("keeps the day's count whole and within bounds", () => {
		expect(AgentPolicyInput.safeParse({ sendPerDay: -1, allowed: [] }).success).toBe(false);
		expect(AgentPolicyInput.safeParse({ sendPerDay: 1.5, allowed: [] }).success).toBe(false);
		expect(AgentPolicyInput.safeParse({ sendPerDay: 1001, allowed: [] }).success).toBe(false);
		expect(AgentPolicyInput.safeParse({ sendPerDay: 0, allowed: [] }).success).toBe(true);
	});
});

describe("readAllowed", () => {
	it("reads a stored list, and anything else as none", () => {
		expect(readAllowed('["@acme.test"]')).toEqual(["@acme.test"]);
		expect(readAllowed('[1, "a@b.test"]')).toEqual(["a@b.test"]);
		expect(readAllowed("{}")).toEqual([]);
		expect(readAllowed("not json")).toEqual([]);
	});
});
