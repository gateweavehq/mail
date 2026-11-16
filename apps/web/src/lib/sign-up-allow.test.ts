import { describe, expect, it } from "vitest";
import { isListed, parseAllowList } from "./sign-up-allow";

function listed(setting: string, email: string) {
	const list = parseAllowList(setting);
	if (!list) throw new Error("The setting made no list");
	return isListed(list, email);
}

describe("parseAllowList", () => {
	it("makes no list from nothing, so sign-up stays open", () => {
		expect(parseAllowList(undefined)).toBeNull();
		expect(parseAllowList("")).toBeNull();
		expect(parseAllowList(" ,\n, ")).toBeNull();
	});

	it("reads addresses and domains, separated by commas or spaces, in any case", () => {
		const list = parseAllowList("Ada@Example.com, @Study.Example\n grace@example.org");
		expect(list).toEqual({
			addresses: new Set(["ada@example.com", "grace@example.org"]),
			domains: new Set(["study.example"]),
			ignored: 0,
		});
	});

	it("keeps a list of nobody when no entry is usable, and counts what it ignored", () => {
		const list = parseAllowList("example.com, *, a@b@c, @, @two@ats");
		expect(list).toEqual({ addresses: new Set(), domains: new Set(), ignored: 5 });
		expect(listed("example.com", "ada@example.com")).toBe(false);
	});
});

describe("isListed", () => {
	it("takes a listed address, whatever its case", () => {
		expect(listed("ada@example.com", "ada@example.com")).toBe(true);
		expect(listed("ada@example.com", "ADA@Example.COM")).toBe(true);
		expect(listed("ada@example.com", "grace@example.com")).toBe(false);
	});

	it("takes any address at a listed domain, whatever its case", () => {
		expect(listed("@gateweave.com", "x@gateweave.com")).toBe(true);
		expect(listed("@gateweave.com", "X@GateWeave.Com")).toBe(true);
	});

	it("takes nothing that only looks like a listed domain", () => {
		for (const email of [
			"x@evilgateweave.com",
			"x@gateweave.com.evil.org",
			"x@sub.gateweave.com",
			"x@gateweave.co",
			"x@gateweave.com.",
			"gateweave.com@evil.org",
			"x@gateweave.com@evil.org",
			"@gateweave.com",
			"x@",
			"gateweave.com",
			"",
		]) {
			expect(listed("@gateweave.com", email), email).toBe(false);
		}
	});

	it("takes nothing that only looks like a listed address", () => {
		for (const email of [
			"xada@example.com",
			"ada@example.com.evil.org",
			"ada@example.comx",
			"ada+tag@example.com",
			"ada@example.com ",
		]) {
			expect(listed("ada@example.com", email), email).toBe(false);
		}
	});
});
