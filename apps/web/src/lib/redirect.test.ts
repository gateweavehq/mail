import { describe, expect, it } from "vitest";
import { safeRedirect } from "./redirect";

describe("safeRedirect", () => {
	it("keeps paths on this site", () => {
		expect(safeRedirect("/invite/abc")).toBe("/invite/abc");
		expect(safeRedirect("/acme/team/ENG?view=board#top")).toBe("/acme/team/ENG?view=board#top");
	});

	it("refuses other sites, however they are spelled", () => {
		for (const value of [
			"https://evil.example",
			"//evil.example",
			"/\\evil.example",
			"\\\\evil.example",
			"javascript:alert(1)",
			" /invite",
		]) {
			expect(safeRedirect(value)).toBeNull();
		}
	});

	it("refuses a path whose dot segments resolve to another site", () => {
		for (const value of [
			"/.//example.com/x",
			"/x/..//example.com/x",
			"/%2e//example.com/x",
			"/./\\example.com",
		]) {
			expect(safeRedirect(value), value).toBeNull();
		}
		expect(safeRedirect("/acme/../other")).toBe("/other");
	});

	it("refuses a missing value", () => {
		expect(safeRedirect(undefined)).toBeNull();
		expect(safeRedirect("")).toBeNull();
	});
});
