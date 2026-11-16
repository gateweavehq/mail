import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

describe("what a deploy does to settings", () => {
	it("leaves alone what someone set in the dashboard", () => {
		// Wrangler otherwise removes a plain-text variable it does not find in this file, so the next
		// push would quietly take away a spending limit, or turn off email or a server's legal pages.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		expect(unstable_readConfig({ config }).keep_vars).toBe(true);
	});

	it.each(["cloud", "staging"])("leaves it alone in %s too", (env) => {
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		expect(unstable_readConfig({ config, env }, { hideWarnings: true }).keep_vars).toBe(true);
	});
});

describe("what self-hosters deploy", () => {
	it("is as it was: no domain, no jurisdiction, no placement, resources made on first deploy", () => {
		// The top level is theirs, and the Deploy button reads it. Gateweave Cloud's own choices
		// belong in its environments.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		const top = unstable_readConfig({ config }, { hideWarnings: true });
		expect(top.name).toBe("gateweave-mail");
		expect(top.routes).toBeUndefined();
		expect(top.placement).toBeUndefined();
		expect(top.vars).toEqual({});
		expect(top.d1_databases).toEqual([
			{ binding: "DB", database_name: "gateweave-mail", migrations_dir: "apps/web/migrations" },
		]);
		expect(top.r2_buckets).toEqual([{ binding: "RAW_MAIL", bucket_name: "gateweave-mail" }]);
	});
});

describe("Gateweave Cloud's production", () => {
	const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
	const cloud = () => unstable_readConfig({ config, env: "cloud" }, { hideWarnings: true });

	it("answers at mail.gateweave.com", () => {
		expect(cloud().routes).toEqual([{ pattern: "mail.gateweave.com", custom_domain: true }]);
	});

	it("keeps its database, its mail and its Durable Objects in the EU", () => {
		// A database's and a bucket's jurisdiction is chosen when they are made, so what says where
		// they are is which ones are bound. Without the jurisdiction, Wrangler looks for the bucket
		// outside the EU, where there is none of that name.
		const { d1_databases, r2_buckets, vars } = cloud();
		expect(d1_databases).toEqual([
			{
				binding: "DB",
				database_name: "gateweave-mail-eu",
				database_id: "c0c5468c-f84b-45b8-a804-6412544febef",
				migrations_dir: "apps/web/migrations",
			},
		]);
		expect(r2_buckets).toEqual([
			{ binding: "RAW_MAIL", bucket_name: "gateweave-mail-eu", jurisdiction: "eu" },
		]);
		expect(vars.DURABLE_OBJECT_JURISDICTION).toBe("eu");
	});

	it("runs near its database, sends email and has the daily run", () => {
		const { placement, send_email, triggers, secrets } = cloud();
		expect(placement).toEqual({ region: "aws:eu-central-1" });
		expect(send_email).toEqual([{ name: "EMAIL" }]);
		expect(triggers.crons).toEqual(["29 3 * * *"]);
		expect(secrets?.required).toEqual(["BETTER_AUTH_SECRET"]);
	});

	it("consumes its queue as the others consume theirs", () => {
		const consumers = (env?: string) =>
			unstable_readConfig({ config, env }, { hideWarnings: true }).queues.consumers?.map(
				({ queue: _queue, ...settings }: { queue: string }) => settings,
			);
		expect(consumers("cloud")).toEqual(consumers());
	});
});

describe("what a branch's Preview gets", () => {
	it("builds, with none of production's resources", () => {
		// Wrangler refuses to build a Preview without this block, which fails every push to a branch,
		// Dependabot's included.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		const { previews } = unstable_readConfig({ config });
		expect(previews).toBeDefined();
		expect(previews?.d1_databases ?? []).toEqual([]);
	});
});

describe("where delivery events come from", () => {
	it("gives each environment a queue of its own", () => {
		// Bindings aren't inherited: staging consuming production's queue would take its events.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		const consumed = (env?: string) =>
			unstable_readConfig({ config, env }, { hideWarnings: true }).queues.consumers?.map(
				({ queue }: { queue: string }) => queue,
			);
		expect(consumed()).toEqual(["gateweave-mail-events"]);
		expect(consumed("staging")).toEqual(["gateweave-mail-staging-events"]);
		// Made with the `eu` jurisdiction, which its name says, as the database's and the bucket's do.
		expect(consumed("cloud")).toEqual(["gateweave-mail-events-eu"]);
	});
});

describe("the Durable Objects each environment binds", () => {
	it("gives each environment the same ones, the audience's among them", () => {
		// Bindings aren't inherited: an environment without one would fail on its first use.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		const bound = (env?: string) =>
			unstable_readConfig({ config, env }, { hideWarnings: true })
				.durable_objects.bindings.map(
					({ name, class_name }: { name: string; class_name: string }) => `${name}:${class_name}`,
				)
				.sort();
		expect(bound()).toContain("AUDIENCE:Audience");
		expect(bound("staging")).toEqual(bound());
		expect(bound("cloud")).toEqual(bound());
	});
});
