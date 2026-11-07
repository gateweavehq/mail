import { describe, expect, it } from "vitest";
import { type Allowance, LocalLimiter, type Rule, take } from "./gcra";

const SECOND = 1000;

/** Makes requests at the given times, in seconds, and reports which were allowed. */
function run(rules: Rule[], times: number[]) {
	let allowance: Allowance = {};
	return times.map((time) => {
		const result = take(allowance, rules, time * SECOND);
		allowance = result.allowance;
		return result.decision;
	});
}

describe("take", () => {
	const threePerTen = { window: 10, max: 3 };

	it("allows a burst of max, then one request per window / max", () => {
		const decisions = run([threePerTen], [0, 0, 0, 0, 3, 3.4, 3.4]);
		expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false, false, true, false]);
	});

	it("says how long to wait, rounded up to whole seconds", () => {
		const [, , , fourth] = run([threePerTen], [0, 0, 0, 0]);
		expect(fourth).toEqual({ allowed: false, retryAfter: 4 });
	});

	it("does not count refused requests", () => {
		// Retrying while refused must not push the next allowed request further away.
		const refusals = Array.from({ length: 50 }, () => 1);
		const decisions = run([threePerTen], [0, 0, 0, ...refusals, 3.4]);
		expect(decisions.at(-1)?.allowed).toBe(true);
	});

	it("refills completely after a quiet window", () => {
		const decisions = run([threePerTen], [0, 0, 0, 10, 10, 10, 10]);
		expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, true, true, true, false]);
	});

	it("allows a request only when every rule does", () => {
		const rules = [threePerTen, { window: 3600, max: 5 }];
		// The short rule refills every 3.33 seconds, but the hourly one runs out after 5.
		const decisions = run(rules, [0, 0, 0, 4, 8, 12]);
		expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, true, true, false]);
		expect(decisions.at(-1)?.retryAfter).toBe(720 - 12);
	});
});

describe("LocalLimiter", () => {
	const rule = { window: 10, max: 1 };

	it("keeps clients apart", () => {
		const limiter = new LocalLimiter();
		expect(limiter.consume("a", [rule], 0).allowed).toBe(true);
		expect(limiter.consume("a", [rule], 0).allowed).toBe(false);
		expect(limiter.consume("b", [rule], 0).allowed).toBe(true);
	});

	it("forgets the oldest clients beyond its capacity", () => {
		const limiter = new LocalLimiter(2);
		for (const key of ["a", "b", "c"]) limiter.consume(key, [rule], 0);
		expect(limiter.consume("a", [rule], 0).allowed).toBe(true);
		expect(limiter.consume("c", [rule], 0).allowed).toBe(false);
	});
});
