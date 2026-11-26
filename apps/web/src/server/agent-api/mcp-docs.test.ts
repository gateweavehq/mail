import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "./operations";
import { firstSentence, NEEDS, TOOLS_END, TOOLS_START, toolsTable } from "./tools-table";

// docs/mcp.md tells people and their agents what Mail's tools are, so its table is held to
// OPERATIONS: a tool it lacks or describes wrongly would send a reader wrong.

const page = "../../../../../docs/mcp.md";
const REWRITE =
	"pnpm --filter @gateweave/mail-web exec vitest run --project unit src/server/agent-api/mcp-docs -u";

describe("docs/mcp.md", () => {
	it("has the tools table between its markers, as OPERATIONS make it", async () => {
		const text = readFileSync(new URL(page, import.meta.url), "utf8");
		const start = text.indexOf(TOOLS_START);
		const end = text.indexOf(TOOLS_END);
		expect(start, `docs/mcp.md has no ${TOOLS_START}`).toBeGreaterThanOrEqual(0);
		expect(end, `docs/mcp.md has no ${TOOLS_END} after it`).toBeGreaterThan(start);
		const expected = `${text.slice(0, start + TOOLS_START.length)}\n\n${toolsTable()}\n\n${text.slice(end)}`;
		try {
			// `vitest -u` writes the page again.
			await expect(expected).toMatchFileSnapshot(page);
		} catch (error) {
			throw new Error(
				`The tools table in docs/mcp.md differs from OPERATIONS. Rewrite the block with:\n  ${REWRITE}\n\n${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});

	it("has a row for every operation", () => {
		const text = readFileSync(new URL(page, import.meta.url), "utf8");
		for (const operation of OPERATIONS) {
			expect(text).toMatch(new RegExp(`^\\| \`${operation.name}\` +\\|`, "m"));
		}
	});

	it("says what each operation needs, from a map with an entry for each", () => {
		for (const operation of OPERATIONS) {
			expect(NEEDS[operation.name], `NEEDS has no entry for ${operation.name}`).toBeTruthy();
		}
		const names = OPERATIONS.map((operation) => operation.name);
		expect(Object.keys(NEEDS).filter((name) => !names.includes(name))).toEqual([]);
	});

	it("fails, naming the operation, when one has no entry in the map", () => {
		const [first] = OPERATIONS;
		if (!first) throw new Error("no operations");
		const missing = { ...first, name: "not_in_the_map" };
		expect(() => toolsTable([missing])).toThrow(/not_in_the_map/);
	});

	it("takes each description's first sentence whole", () => {
		expect(firstSentence("Lists a. Then b.")).toBe("Lists a.");
		expect(firstSentence("No full stop")).toBe("No full stop");
	});
});
