// Starts the built app for the end-to-end tests: `vite preview` on port 4752, or MAIL_E2E_PORT as
// playwright.config.ts reads it, with its own empty local database. It runs from Playwright's
// `webServer`, so it works the same on a laptop and in CI, where there is no .dev.vars. Run
// `vite build` first.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);

// Kept apart from `pnpm dev` data, and wiped on every start so each run begins empty.
const state = resolve(root, ".wrangler", "e2e-state");
rmSync(state, { recursive: true, force: true });

// Only the secrets matter; the app runs with email off. A preview reads them from beside the built
// Worker, where a build leaves a copy of .dev.vars if there is one, and CI has none. A Worker
// without them serves nothing, so the tests have their own wherever they run. The .dev.vars at the
// repository root is left alone.
writeFileSync(
	resolve(root, "dist/server/.dev.vars"),
	[`BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`, ""].join("\n"),
);

// Run the tools with this Node, not through a shell: Playwright stops the server by killing this
// process, and a shell in between would leave the server running (and Playwright waiting).
const migrated = spawnSync(
	process.execPath,
	[
		resolve(root, "node_modules/wrangler/bin/wrangler.js"),
		...["d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
	],
	{ stdio: "inherit" },
);
if (migrated.status !== 0) process.exit(migrated.status ?? 1);

const server = spawn(
	process.execPath,
	[
		resolve(root, "node_modules/vite/bin/vite.js"),
		"preview",
		"--port",
		String(Number(process.env.MAIL_E2E_PORT) || 4752),
		"--strictPort",
	],
	{ stdio: "inherit", env: { ...process.env, MAIL_STATE_DIR: state } },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
