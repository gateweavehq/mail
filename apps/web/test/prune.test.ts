import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { startMail } from "./mail-worker";

const origin = "https://mail.test";
const HOUR = 3_600_000;

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin);
	await mail.db.batch([
		mail.db
			.prepare(
				"INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('someone', 'Someone', 'someone@example.com', 1, ?1, ?1)",
			)
			.bind(Date.now()),
		mail.db.prepare(
			"INSERT INTO organization (id, name, slug, created_at) VALUES ('prunable', 'Prunable', 'prunable', 0)",
		),
	]);
});

afterAll(async () => {
	await mail?.dispose();
});

async function has(table: string, rowId: string) {
	const row = await mail.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(rowId).first();
	return row !== null;
}

describe("the daily cron", () => {
	const past = () => Date.now() - HOUR;
	const future = () => Date.now() + HOUR;

	it("deletes sessions past their time, with the address and browser they hold", async () => {
		const add = (rowId: string, expiresAt: number) =>
			mail.db
				.prepare(
					"INSERT INTO session (id, user_id, token, ip_address, user_agent, expires_at, created_at, updated_at) VALUES (?1, 'someone', ?1, '203.0.113.9', 'A browser', ?2, ?2, ?2)",
				)
				.bind(rowId, expiresAt);
		await mail.db.batch([add("old-session", past()), add("live-session", future())]);
		await mail.runScheduled();
		expect(await has("session", "old-session")).toBe(false);
		expect(await has("session", "live-session")).toBe(true);
	});

	it("deletes verifications past their time", async () => {
		const add = (rowId: string, expiresAt: number) =>
			mail.db
				.prepare(
					"INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?1, ?1, 'a code', ?2, ?2, ?2)",
				)
				.bind(rowId, expiresAt);
		await mail.db.batch([add("old-verification", past()), add("live-verification", future())]);
		await mail.runScheduled();
		expect(await has("verification", "old-verification")).toBe(false);
		expect(await has("verification", "live-verification")).toBe(true);
	});

	it("deletes invitations past their time, and the addresses they hold", async () => {
		const add = (rowId: string, expiresAt: number) =>
			mail.db
				.prepare(
					"INSERT INTO invitation (id, organization_id, email, status, expires_at, inviter_id) VALUES (?1, 'prunable', ?1 || '@example.com', 'pending', ?2, 'someone')",
				)
				.bind(rowId, expiresAt);
		await mail.db.batch([add("old-invitation", past()), add("live-invitation", future())]);
		await mail.runScheduled();
		expect(await has("invitation", "old-invitation")).toBe(false);
		expect(await has("invitation", "live-invitation")).toBe(true);
	});

	it("leaves a person and their workspace alone", async () => {
		await mail.runScheduled();
		expect(await has("user", "someone")).toBe(true);
		expect(await has("organization", "prunable")).toBe(true);
	});

	it("lets go of an ended address's name, and of a removed one's, after 30 days", async () => {
		const day = 24 * HOUR;
		await mail.db.batch([
			mail.db
				.prepare(
					"INSERT INTO mail_domain (id, organization_id, name, verification_token, verified_at, created_at) VALUES ('prune-domain', 'prunable', 'prune.example', 'token', ?1, ?1)",
				)
				.bind(Date.now()),
			mail.db
				.prepare(
					"INSERT INTO mailbox (id, organization_id, name, created_at) VALUES ('prune-box', 'prunable', 'Box', ?)",
				)
				.bind(Date.now()),
			mail.db
				.prepare(
					"INSERT INTO mail_address (id, domain_id, local_part, mailbox_id, expires_at, created_at) VALUES ('long-ended', 'prune-domain', 'old', 'prune-box', ?1, ?1)",
				)
				.bind(Date.now() - 31 * day),
			mail.db
				.prepare(
					"INSERT INTO removed_address (domain_id, local_part, removed_at) VALUES ('prune-domain', 'long-ago', ?1), ('prune-domain', 'lately', ?2)",
				)
				.bind(Date.now() - 31 * day, Date.now() - 29 * day),
		]);
		await mail.runScheduled();
		expect(await has("mail_address", "long-ended")).toBe(false);
		const names = await mail.db
			.prepare("SELECT local_part FROM removed_address WHERE domain_id = 'prune-domain'")
			.all<{ local_part: string }>();
		// The ended address's own delete keeps nothing back: its name was kept long enough already.
		expect(names.results.map((row: { local_part: string }) => row.local_part)).toEqual(["lately"]);
	});

	it("gets through more than one batch", async () => {
		// One statement, not one for each row: preparing 2,500 through the test's connection takes long
		// enough when other suites are busy that the connection is lost before they can be sent.
		await mail.db
			.prepare(
				`WITH RECURSIVE row(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM row WHERE n < 2500)
				INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
				SELECT 'batch-' || n, 'someone', 'something', ?1, ?1, ?1 FROM row`,
			)
			.bind(past())
			.run();
		await mail.runScheduled();
		const left = await mail.db
			.prepare("SELECT COUNT(*) AS count FROM verification WHERE id LIKE 'batch-%'")
			.first<{ count: number }>();
		expect(left?.count).toBe(0);
	});
});

describe("the schedule", () => {
	const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");

	// A handler with no schedule never runs, and nothing would say so: the tables just keep growing.
	it.each([
		["a self-hosted deployment", undefined],
		["staging", "staging"],
	])("runs on %s", (_name, env) => {
		expect(unstable_readConfig({ config, env }).triggers.crons).toEqual(["29 3 * * *"]);
	});
});
