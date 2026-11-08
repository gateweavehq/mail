// Builds Mail and deploys it to Cloudflare, with the D1 migrations applied before the new code
// goes live, so it never meets an old schema. The one exception is the very first deploy from
// the command line: the database does not exist until `wrangler deploy` creates it, so there the
// migrations follow. (The "Deploy to Cloudflare" button creates the database beforehand.)
//
// The queue for Email Service's delivery events is made first when it is missing.
//
// A first deploy also needs BETTER_AUTH_SECRET, which Wrangler only accepts for a new Worker as a
// file. Unless the button has set one, a random secret is generated for it and never shown.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";

const require = createRequire(import.meta.url);
// Wrangler runs from the repository root: wrangler.jsonc is there, and so is the build's pointer
// to its output (see rootDeployConfig in vite.config.ts), which Wrangler only follows from there.
const root = fileURLToPath(new URL("../../..", import.meta.url));

/** The script behind a package's command-line tool. */
function tool(pkg, bin) {
	const manifest = require.resolve(`${pkg}/package.json`);
	const { bin: bins } = require(manifest);
	return join(dirname(manifest), typeof bins === "string" ? bins : bins[bin]);
}

/** Runs a package's command-line tool with this Node, as a package script would. */
function run(pkg, bin, args, cwd) {
	execFileSync(process.execPath, [tool(pkg, bin), ...args], { cwd, stdio: "inherit" });
}

const wrangler = (args) => run("wrangler", "wrangler", args, root);

/** Runs Wrangler and returns what it prints, or throws with what it printed on failure. */
function ask(args) {
	const result = spawnSync(process.execPath, [tool("wrangler", "wrangler"), ...args], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status === 0) return result.stdout;
	const error = new Error(`wrangler ${args.join(" ")} failed:\n${result.stderr}`);
	error.stderr = result.stderr;
	throw error;
}

function databaseExists() {
	const config = unstable_readConfig({ config: join(root, "wrangler.jsonc") });
	const database = config.d1_databases.find(({ binding }) => binding === "DB");
	if (!database) throw new Error('wrangler.jsonc has no D1 database bound as "DB"');
	if (database.database_id) return true;
	const listed = JSON.parse(ask(["d1", "list", "--json"]));
	return listed.some(({ name }) => name === database.database_name);
}

function workerExists() {
	try {
		ask(["secret", "list", "--format", "json"]);
		return true;
	} catch (error) {
		// Anything else, such as a network error, stops the deploy rather than replace a secret.
		if (/Worker ".+" not found/.test(error.stderr ?? "")) return false;
		throw error;
	}
}

/**
 * Creates the queues the Worker consumes that don't exist yet, as Email Service's delivery events
 * queue: Wrangler won't deploy a consumer of a queue that isn't there. The Deploy button makes them
 * itself.
 */
function createQueues() {
	const config = unstable_readConfig({ config: join(root, "wrangler.jsonc") });
	for (const { queue } of config.queues?.consumers ?? []) {
		try {
			ask(["queues", "info", queue]);
		} catch (error) {
			// Anything else, such as a network error, stops the deploy.
			if (!/does not exist/.test(error.stderr ?? "")) throw error;
			wrangler(["queues", "create", queue]);
		}
	}
}

const migrate = () => wrangler(["d1", "migrations", "apply", "DB", "--remote"]);

run("vite", "vite", ["build"]);
const exists = databaseExists();
if (exists) migrate();
createQueues();
if (workerExists()) {
	wrangler(["deploy"]);
} else {
	const directory = mkdtempSync(join(tmpdir(), "mail-deploy-"));
	const secrets = join(directory, "secrets.json");
	try {
		const secret = randomBytes(32).toString("base64");
		writeFileSync(secrets, JSON.stringify({ BETTER_AUTH_SECRET: secret }), { mode: 0o600 });
		wrangler(["deploy", "--secrets-file", secrets]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
if (!exists) migrate();
