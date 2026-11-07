import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import manifest from "../package.json" with { type: "json" };

// `vite build --mode <env>` takes the Wrangler environment from apps/web/.env.<env>. Without that
// file the build silently targets the top-level Worker, which is Gateweave's production, and the
// `wrangler deploy` that follows would replace it.
const web = fileURLToPath(new URL("..", import.meta.url));
const config = fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url));

const builds = Object.entries(manifest.scripts).flatMap(([script, command]) => {
	const mode = /vite build --mode (\S+)/.exec(command)?.[1];
	return mode ? [{ script, mode }] : [];
});

describe("environment builds", () => {
	it("covers staging", () => {
		expect(builds.map(({ mode }) => mode)).toEqual(expect.arrayContaining(["staging"]));
	});

	it.each(builds)("$script builds the $mode Worker, not production", ({ mode }) => {
		expect(loadEnv(mode, web, "CLOUDFLARE_ENV").CLOUDFLARE_ENV).toBe(mode);

		const production = unstable_readConfig({ config }, { hideWarnings: true });
		const environment = unstable_readConfig({ config, env: mode }, { hideWarnings: true });
		expect(environment.name).not.toBe(production.name);
		const database = ({ d1_databases }: typeof production): string | undefined =>
			d1_databases.find((d1: { binding: string }) => d1.binding === "DB")?.database_name;
		expect(database(environment)).toBeDefined();
		expect(database(environment)).not.toBe(database(production));
	});
});
