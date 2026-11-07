import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { slugProblem } from "./slug";

/** The first segment of each page's path, from its file's name, which is what names its route. */
function pagePaths(): string[] {
	return readdirSync(resolve(import.meta.dirname, "../routes"))
		.filter((file) => !/^(?:__root|index|\$)/.test(file))
		.map((file) => file.split(".")[0] ?? "");
}

describe("slugProblem", () => {
	it("keeps workspaces off every path the app answers itself", () => {
		const paths = pagePaths();
		expect(paths).toContain("login");
		expect(paths).toContain("settings");
		for (const path of paths) {
			expect(slugProblem(path), `a workspace at /${path}`).not.toBeNull();
		}
	});
});
