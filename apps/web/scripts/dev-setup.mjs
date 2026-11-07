// One-time local setup: creates .dev.vars at the repository root (next to wrangler.jsonc) with a
// random secret, and applies D1 migrations to the local database. Safe to re-run: an existing
// .dev.vars is left alone.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DEV_VARS = "../../.dev.vars";

if (existsSync(DEV_VARS)) {
	console.log(".dev.vars already exists, leaving it alone.");
} else {
	const secret = randomBytes(32).toString("base64");
	const template = readFileSync("../../.dev.vars.example", "utf8");
	writeFileSync(
		DEV_VARS,
		template.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`),
	);
	console.log("Created .dev.vars with a fresh BETTER_AUTH_SECRET.");
}

execSync("pnpm db:migrate:local", { stdio: "inherit" });
