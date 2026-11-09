import { describe, expect, it } from "vitest";
import {
	AgentAddressPolicyInput,
	addressPolicySummary,
	agentLocalPart,
	RANDOM_LOCAL_PART_LENGTH,
	RESERVED_LOCAL_PARTS,
	randomLocalPart,
	readDomains,
} from "./agent-addresses";

describe("agentLocalPart", () => {
	it("takes a name as an address is stored", () => {
		expect(agentLocalPart(" Invoice-42 ")).toEqual({ ok: true, localPart: "invoice-42" });
		expect(agentLocalPart("a.b_c")).toEqual({ ok: true, localPart: "a.b_c" });
	});

	it("refuses what isn't a local part we make", () => {
		for (const input of ["", "-a", "a-", "a..b", "a+b", "a b", "ü"]) {
			expect(agentLocalPart(input).ok, input).toBe(false);
		}
	});

	it("refuses the names that prove who runs a domain, however they are written", () => {
		for (const name of ["admin", "Administrator", " webmaster", "HOSTMASTER", "postmaster"]) {
			const read = agentLocalPart(name);
			expect(read.ok, name).toBe(false);
			if (!read.ok) expect(read.error).toContain("ask an admin");
		}
		expect(agentLocalPart("abuse").ok).toBe(false);
		expect(agentLocalPart("mailer-daemon").ok).toBe(false);
		// Only the names themselves: one that contains one is the agent's.
		expect(agentLocalPart("admin-team").ok).toBe(true);
	});
});

describe("randomLocalPart", () => {
	it("is lower-case letters and digits, of its length, and never reserved", () => {
		const made = new Set<string>();
		for (let i = 0; i < 500; i++) {
			const part = randomLocalPart();
			expect(part).toMatch(new RegExp(`^[a-z0-9]{${RANDOM_LOCAL_PART_LENGTH}}$`));
			expect(RESERVED_LOCAL_PARTS.has(part)).toBe(false);
			expect(agentLocalPart(part)).toEqual({ ok: true, localPart: part });
			made.add(part);
		}
		expect(made.size).toBe(500);
	});

	it("uses every character", () => {
		const seen = new Set(Array.from({ length: 200 }, randomLocalPart).join(""));
		expect(seen.size).toBe(36);
	});
});

describe("AgentAddressPolicyInput", () => {
	it("holds the limits to their ranges", () => {
		const valid = { maxLive: 0, maxDays: 1, domains: [] };
		expect(AgentAddressPolicyInput.safeParse(valid).success).toBe(true);
		expect(
			AgentAddressPolicyInput.safeParse({ ...valid, maxLive: 500, maxDays: 365 }).success,
		).toBe(true);
		for (const wrong of [
			{ maxLive: -1 },
			{ maxLive: 501 },
			{ maxLive: 1.5 },
			{ maxDays: 0 },
			{ maxDays: 366 },
			{ domains: ["not a domain"] },
			{ domains: Array.from({ length: 21 }, (_, i) => `d${i}.example.com`) },
		]) {
			expect(AgentAddressPolicyInput.safeParse({ ...valid, ...wrong }).success).toBe(false);
		}
	});

	it("reads domains as they are stored", () => {
		const read = AgentAddressPolicyInput.parse({
			maxLive: 1,
			maxDays: 1,
			domains: [" Agents.Example.COM. "],
		});
		expect(read.domains).toEqual(["agents.example.com"]);
	});
});

describe("readDomains", () => {
	it("reads a stored list, and anything else as none", () => {
		expect(readDomains('["a.example.com"]')).toEqual(["a.example.com"]);
		expect(readDomains('["a.example.com", 7]')).toEqual(["a.example.com"]);
		expect(readDomains("{}")).toEqual([]);
		expect(readDomains("not json")).toEqual([]);
	});
});

describe("addressPolicySummary", () => {
	it("says what the agent may make", () => {
		expect(addressPolicySummary({ maxLive: 0, maxDays: 7, domains: ["a.example.com"] })).toBe(
			"Can't make addresses.",
		);
		expect(addressPolicySummary({ maxLive: 5, maxDays: 7, domains: [] })).toBe(
			"Can't make addresses.",
		);
		expect(addressPolicySummary({ maxLive: 1, maxDays: 1, domains: ["a.example.com"] })).toBe(
			"Makes up to 1 address at once on a.example.com, each lasting up to 1 day.",
		);
		expect(
			addressPolicySummary({
				maxLive: 20,
				maxDays: 30,
				domains: ["a.example.com", "b.example.com", "c.example.com"],
			}),
		).toBe(
			"Makes up to 20 addresses at once on a.example.com, b.example.com and 1 more, each lasting up to 30 days.",
		);
	});
});
