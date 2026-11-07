import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb } from "../db";
import { createAuth } from "./config";

let mf: Miniflare;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "auth-session-queries-test" },
		}),
	);
	const d1 = await mf.getD1Database("DB");
	const migrations = resolve(import.meta.dirname, "../../../migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await d1.batch(statements.map((statement) => d1.prepare(statement)));
	}
});

afterAll(async () => {
	await mf?.dispose();
});

it("reads a session in one query, because each is a trip to the database, and answers as it did with two", async () => {
	const d1 = await mf.getD1Database("DB");
	let queries = 0;
	const counted = new Proxy(d1, {
		get(target, key) {
			if (key === "prepare") queries += 1;
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const auth = createAuth({
		db: createDb(counted as unknown as D1Database),
		secret: "a-test-secret-that-is-long-enough-for-better-auth",
		baseURL: "https://mail.test",
	});
	const { headers } = await auth.api.signUpEmail({
		body: { name: "Quinn", email: "quinn@example.com", password: "a-long-test-password" },
		returnHeaders: true,
	});
	const cookie = headers
		.getSetCookie()
		.map((line) => line.split(";")[0])
		.join("; ");

	queries = 0;
	const found = await auth.api.getSession({ headers: new Headers({ cookie }) });

	expect(queries).toBe(1);
	expect(found?.user).toMatchObject({
		name: "Quinn",
		email: "quinn@example.com",
		emailVerified: false,
	});
	expect(found?.user.createdAt).toBeInstanceOf(Date);
	expect(found?.session.expiresAt).toBeInstanceOf(Date);
	expect(found?.session.expiresAt.getTime()).toBeGreaterThan(Date.now());
});
