import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

describe("what a deploy does to settings", () => {
	it("leaves alone what someone set in the dashboard", () => {
		// Wrangler otherwise removes a plain-text variable it does not find in this file, so the next
		// push would quietly take away a spending limit, or turn off email or a server's legal pages.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		expect(unstable_readConfig({ config }).keep_vars).toBe(true);
	});
});

describe("what a branch's Preview gets", () => {
	it("builds, with none of production's resources", () => {
		// Wrangler refuses to build a Preview without this block, which fails every push to a branch,
		// Dependabot's included.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		const { previews } = unstable_readConfig({ config });
		expect(previews).toBeDefined();
		expect(previews?.d1_databases ?? []).toEqual([]);
	});
});
