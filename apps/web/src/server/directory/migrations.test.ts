import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// What a migration does to a database that already holds a workspace's mailboxes, which the
// Worker tests, starting from an empty one, never see.

let mf: Miniflare;
let d1: D1Database;

const migrations = resolve(import.meta.dirname, "../../../migrations");
const files = readdirSync(migrations)
	.filter((name) => name.endsWith(".sql"))
	.sort();

async function migrate(file: string) {
	const statements = readFileSync(join(migrations, file), "utf8")
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter(Boolean);
	await d1.batch(statements.map((statement) => d1.prepare(statement)));
}

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "directory-migrations-test" },
		}),
	);
	d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
});

afterAll(async () => {
	await mf?.dispose();
});

describe("0007, which decides who reads each mailbox", () => {
	it("leaves the mailboxes there are open to everyone, and a new one for owners and admins", async () => {
		const upTo = files.indexOf("0007_mailbox_access_rules.sql");
		expect(upTo).toBeGreaterThan(0);
		for (const file of files.slice(0, upTo)) await migrate(file);
		await d1.batch([
			d1.prepare(
				"INSERT INTO organization (id, name, slug, created_at) VALUES ('w1', 'Acme', 'acme', 0)",
			),
			d1.prepare("INSERT INTO mailbox (id, organization_id, name) VALUES ('old', 'w1', 'Support')"),
		]);

		for (const file of files.slice(upTo)) await migrate(file);
		await d1
			.prepare("INSERT INTO mailbox (id, organization_id, name) VALUES ('new', 'w1', 'Sales')")
			.run();

		const { results } = await d1
			.prepare("SELECT id, everyone FROM mailbox ORDER BY id")
			.all<{ id: string; everyone: number }>();
		expect(results).toEqual([
			{ id: "new", everyone: 0 },
			{ id: "old", everyone: 1 },
		]);
	});
});
