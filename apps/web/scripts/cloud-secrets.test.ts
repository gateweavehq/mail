import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import { missingSecrets, refusal, secretNames } from "./check-cloud-secrets.mjs";
import guard from "./cloud-secrets.json" with { type: "json" };

// Gateweave Cloud's production must never go live open (scripts/check-cloud-secrets.mjs). The
// names it must have are in cloud-secrets.json, the one place the guard and these tests read.

const listed = (names: string[]) => ({
	status: 0,
	stdout: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))),
	stderr: "",
});

describe("the secrets Cloud's production must have before a release", () => {
	it("are the ones without which it would be open, unsealed or without its provider", () => {
		expect(guard.environment).toBe("cloud");
		expect([...guard.required].sort()).toEqual(
			[
				"BETTER_AUTH_SECRET",
				"BETTER_AUTH_URL",
				"OIDC_CLIENT_ID",
				"OIDC_CLIENT_SECRET",
				"OIDC_ISSUER",
				"SECRETS_KEY",
				"SIGN_UP_ALLOW",
			].sort(),
		);
	});

	it("are all there on a Worker that lists them, whatever else it has", () => {
		const names = secretNames(listed([...guard.required, "EMAIL_FROM"]));
		expect(missingSecrets(guard.required, names)).toEqual([]);
	});

	it.each(guard.required)("stop a release when %s is not there", (name) => {
		const names = secretNames(listed(guard.required.filter((one) => one !== name)));
		expect(missingSecrets(guard.required, names)).toEqual([name]);
	});

	it("are all missing on a Worker that does not exist yet, which a first release would make", () => {
		// Wrangler's own words, with an environment (measured with 4.160 on 2026-11-16) and without.
		for (const stderr of [
			'\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mWorker "gateweave-mail-cloud" (env: cloud) not found.\u001b[0m\n\n  If this is a new Worker, run `wrangler deploy` first to create it.',
			'✘ [ERROR] Worker "gateweave-mail-cloud" not found.',
		]) {
			const names = secretNames({ status: 1, stdout: "", stderr });
			expect(names).toEqual([]);
			expect(missingSecrets(guard.required, names)).toEqual(guard.required);
		}
	});

	it("are all missing on a Worker with only the secret a first deploy generates", () => {
		const names = secretNames(listed(["BETTER_AUTH_SECRET"]));
		expect(missingSecrets(guard.required, names)).toEqual(
			guard.required.filter((name) => name !== "BETTER_AUTH_SECRET"),
		);
	});

	it("stop a release that cannot look, rather than let it pass", () => {
		for (const stderr of ["Authentication error [code: 10000]", "fetch failed", ""]) {
			expect(() => secretNames({ status: 1, stdout: "", stderr })).toThrow("Could not list");
		}
		expect(() => secretNames({ status: 0, stdout: '{"result":[]}', stderr: "" })).toThrow();
	});

	it("say which are missing and how to set them, and never a value", () => {
		const words = refusal(["SIGN_UP_ALLOW", "SECRETS_KEY"], guard.environment, guard.worker);
		expect(words).toContain('the Worker "gateweave-mail-cloud" (the "cloud" environment)');
		expect(words).toContain("  - SIGN_UP_ALLOW\n  - SECRETS_KEY");
		expect(words).toContain("pnpm wrangler secret put <NAME> --env cloud");
		expect(words).toContain("Nothing was migrated or deployed");
	});
});

describe("the guard as the release job runs it", () => {
	const script = fileURLToPath(new URL("./check-cloud-secrets.mjs", import.meta.url));

	it("asks for names only, of the cloud environment", () => {
		const source = readFileSync(script, "utf8");
		expect(source).toContain('"secret", "list", "--env", environment, "--format", "json"');
		// Nothing that could print or fetch a value.
		expect(source).not.toMatch(
			/secret",\s*"(put|bulk|get)"|\.dev\.vars|process\.env\.[A-Z_]*SECRET/,
		);
		expect(manifest.scripts["deploy:guard:cloud"]).toBe("node scripts/check-cloud-secrets.mjs");
	});

	it("does nothing when another script only imports it", () => {
		// Importing it is how these tests read it. Were it to run then, it would ask Cloudflare.
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)})`],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		expect(result.stdout + result.stderr).toBe("");
	});
});
