// Stops a release of Gateweave Cloud's production that would go live open. A first deploy of a
// Worker that has no secrets takes the deploy script's new-Worker branch: it would answer at
// mail.gateweave.com with a generated BETTER_AUTH_SECRET and nothing else, so with sign-up open
// to anyone, no sign-in provider and mail kept unsealed. So before anything changes, the release
// job asks which secrets the Worker has, by name, and stops unless every one in
// cloud-secrets.json is there. A Worker that does not exist yet has none.
//
// It reads names only: Cloudflare never gives a secret's value back, and nothing here asks.
// Self-hosters' deploys and staging don't run this.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `worker` is the name wrangler.jsonc gives that environment's Worker, which a test holds equal:
// Wrangler finds the Worker from the environment, and the name is for the words below.
const { environment, worker, required } = JSON.parse(
	readFileSync(new URL("./cloud-secrets.json", import.meta.url), "utf8"),
);

/** The required names that are not among the listed ones, in the order they are required. */
export function missingSecrets(requiredNames, listedNames) {
	const listed = new Set(listedNames);
	return requiredNames.filter((name) => !listed.has(name));
}

/**
 * The names in what `wrangler secret list --format json` printed, or none for a Worker that
 * does not exist. Anything else that went wrong is thrown: a guard that cannot look must not pass.
 */
export function secretNames({ status, stdout, stderr }) {
	if (status !== 0) {
		// As Wrangler 4.160 says it for an environment: `Worker "name" (env: cloud) not found.`
		if (/Worker "[^"]+"( \(env: [^)]+\))? not found/.test(stderr ?? "")) return [];
		throw new Error(`Could not list the Worker's secrets:\n${stderr}`);
	}
	const listed = JSON.parse(stdout);
	if (!Array.isArray(listed))
		throw new Error("Wrangler listed the Worker's secrets in a new shape");
	return listed.map(({ name }) => name).filter((name) => typeof name === "string");
}

/** What the release is told when it is stopped. */
export function refusal(missing, env, name) {
	return [
		`This release is stopped: the Worker "${name}" (the "${env}" environment) lacks ${missing.length === 1 ? "a secret" : "secrets"} it must have before it answers anyone.`,
		...missing.map((name) => `  - ${name}`),
		"Without them it would go live with sign-up open, no sign-in provider, or mail kept unsealed.",
		`Set each one, then run the release again:  pnpm wrangler secret put <NAME> --env ${env}`,
		'See "Gateweave Cloud" in docs/self-hosting.md. Nothing was migrated or deployed.',
	].join("\n");
}

function listSecrets() {
	const require = createRequire(import.meta.url);
	const manifest = require.resolve("wrangler/package.json");
	const { bin } = require(manifest);
	const wrangler = join(dirname(manifest), typeof bin === "string" ? bin : bin.wrangler);
	// From the repository root, where wrangler.jsonc is.
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	return spawnSync(
		process.execPath,
		[wrangler, "secret", "list", "--env", environment, "--format", "json"],
		{ cwd: root, encoding: "utf8" },
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const missing = missingSecrets(required, secretNames(listSecrets()));
	if (missing.length > 0) {
		console.error(refusal(missing, environment, worker));
		process.exit(1);
	}
	console.log(`The Worker "${worker}" has the ${required.length} secrets a release needs.`);
}
