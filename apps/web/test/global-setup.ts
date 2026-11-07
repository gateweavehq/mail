import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/** Builds the Worker once per run, so the tests exercise what deploys. */
export default function setup() {
	const require = createRequire(import.meta.url);
	const vitePackage = require.resolve("vite/package.json");
	const { bin } = require(vitePackage) as { bin: { vite: string } };
	execFileSync(
		process.execPath,
		[join(dirname(vitePackage), bin.vite), "build", "--logLevel", "warn"],
		{
			cwd: resolve(import.meta.dirname, ".."),
			// Vitest sets NODE_ENV to "test", which would make this a development build.
			env: { ...process.env, NODE_ENV: "production" },
			stdio: "inherit",
		},
	);
}
