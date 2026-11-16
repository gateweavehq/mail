import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import manifest from "../package.json" with { type: "json" };

// `vite build --mode <env>` takes the Wrangler environment from apps/web/.env.<env>. Without that
// file the build silently targets the top-level Worker, which has the name of Gateweave's
// production, and the `wrangler deploy` that follows would replace it.
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

	// Gateweave Cloud's production deploys the `cloud` environment, which the build, the deploy
	// script and Wrangler take from CLOUDFLARE_ENV (.github/workflows/deploy.yml). It is the Worker
	// the top level names, with the same bindings, so the code finds what it expects, and its own
	// database, bucket and queue, so a self-hoster's names are never Gateweave's.
	it("deploys Cloud's production as the top-level Worker, with resources of its own", () => {
		const production = unstable_readConfig({ config }, { hideWarnings: true });
		const cloud = unstable_readConfig({ config, env: "cloud" }, { hideWarnings: true });
		expect(cloud.name).toBe(production.name);
		expect(cloud.durable_objects.bindings).toEqual(production.durable_objects.bindings);
		const bindings = ({ d1_databases, r2_buckets, send_email }: typeof production) => [
			...d1_databases.map((d1: { binding: string }) => d1.binding),
			...r2_buckets.map((r2: { binding: string }) => r2.binding),
			...send_email.map((email: { name: string }) => email.name),
		];
		expect(bindings(cloud)).toEqual(bindings(production));
		const staging = unstable_readConfig({ config, env: "staging" }, { hideWarnings: true });
		const kept = ({ d1_databases, r2_buckets, queues }: typeof production) => [
			...d1_databases.map((d1: { database_name?: string }) => d1.database_name),
			...r2_buckets.map((r2: { bucket_name?: string }) => r2.bucket_name),
			...(queues.consumers ?? []).map(({ queue }: { queue: string }) => queue),
		];
		for (const other of [...kept(production), ...kept(staging)]) {
			expect(kept(cloud)).not.toContain(other);
		}
	});

	it("reads Cloud's production from CLOUDFLARE_ENV, as the deploy script does", () => {
		// `scripts/deploy.mjs` reads the config without naming an environment. Were this not so,
		// a release would look for the top level's database and queue, and migrate the wrong one.
		const before = process.env.CLOUDFLARE_ENV;
		process.env.CLOUDFLARE_ENV = "cloud";
		try {
			const read = unstable_readConfig({ config }, { hideWarnings: true });
			expect(read.d1_databases.map((d1: { database_name?: string }) => d1.database_name)).toEqual([
				"gateweave-mail-eu",
			]);
			expect(read.vars.DURABLE_OBJECT_JURISDICTION).toBe("eu");
		} finally {
			if (before === undefined) delete process.env.CLOUDFLARE_ENV;
			else process.env.CLOUDFLARE_ENV = before;
		}
	});

	it("releases to Cloud's production: its database migrated, then its Worker deployed", () => {
		// Without CLOUDFLARE_ENV the release would deploy the top level, a Worker with a database,
		// a bucket and objects outside the EU, under production's name.
		const workflow = readFileSync(
			new URL("../../../.github/workflows/deploy.yml", import.meta.url),
			"utf8",
		).replaceAll("\r\n", "\n");
		const production = workflow.slice(workflow.indexOf("\n  production:\n"));
		expect(production).toContain("url: https://mail.gateweave.com");
		const migrate = production.indexOf("run: pnpm --filter @gateweave/mail-web db:migrate:cloud");
		const deploy = production.indexOf(
			"env:\n          CLOUDFLARE_ENV: cloud\n        run: pnpm --filter @gateweave/mail-web run deploy",
		);
		const smoke = production.indexOf("MAIL_SMOKE_URL: https://mail.gateweave.com");
		expect(migrate).toBeGreaterThan(0);
		expect(deploy).toBeGreaterThan(migrate);
		expect(smoke).toBeGreaterThan(deploy);
		expect(manifest.scripts["db:migrate:cloud"]).toContain("--remote --env cloud");
	});

	it("changes nothing in a release before it knows the Worker has its secrets and its queue", () => {
		// A first deploy of a Worker without secrets would go live open, and a token that can't reach
		// Queues would stop the deploy after the schema had changed. Both come before the migrations.
		const workflow = readFileSync(
			new URL("../../../.github/workflows/deploy.yml", import.meta.url),
			"utf8",
		).replaceAll("\r\n", "\n");
		const at = workflow.indexOf("\n  production:\n");
		const production = workflow.slice(at);
		const guard = production.indexOf("run: pnpm --filter @gateweave/mail-web deploy:guard:cloud");
		const queues = production.indexOf(
			"env:\n          CLOUDFLARE_ENV: cloud\n        run: pnpm --filter @gateweave/mail-web deploy:queues",
		);
		const migrate = production.indexOf("run: pnpm --filter @gateweave/mail-web db:migrate:cloud");
		expect(guard).toBeGreaterThan(production.indexOf("pnpm install --frozen-lockfile"));
		expect(queues).toBeGreaterThan(guard);
		expect(migrate).toBeGreaterThan(queues);
		expect(manifest.scripts["deploy:queues"]).toBe("node scripts/deploy.mjs --queues");
		// The release then proves from outside that the deployment is closed and has its provider.
		expect(production).toContain('MAIL_SMOKE_SSO: "1"\n          MAIL_SMOKE_CLOSED: "1"');
		// Staging is not held to it, and self-hosters' deploys never run it.
		expect(workflow.slice(0, at)).not.toContain("deploy:guard");
		expect(manifest.scripts.deploy).toBe("node scripts/deploy.mjs");
		const script = readFileSync(new URL("./deploy.mjs", import.meta.url), "utf8");
		expect(script).not.toContain("cloud-secrets");
	});

	// Staging keeps the objects it has, outside any jurisdiction, until they are moved.
	it("keeps Cloud's Durable Objects in the EU, and leaves staging's where they are", () => {
		const vars = (env?: string) =>
			unstable_readConfig({ config, env }, { hideWarnings: true }).vars;
		expect(vars("cloud").DURABLE_OBJECT_JURISDICTION).toBe("eu");
		expect(vars("staging").DURABLE_OBJECT_JURISDICTION).toBeUndefined();
		expect(vars().DURABLE_OBJECT_JURISDICTION).toBeUndefined();
	});
});
