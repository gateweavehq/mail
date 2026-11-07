import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../db";
import { createAuth } from "./config";
import { tellOfSpentTries } from "./password-tries";

let mf: Miniflare;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "auth-password-tries-test" },
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

const verified = { id: "u-ada", email: "ada@example.com", emailVerified: true };

function recordingMailer() {
	const sent: string[] = [];
	return {
		sent,
		mailer: {
			send: async (email: { to: string }) => {
				sent.push(email.to);
			},
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tellOfSpentTries", () => {
	it("sends one to a verified address when the day's email is free", async () => {
		const { mailer, sent } = recordingMailer();
		await tellOfSpentTries(verified, mailer, async () => true);
		expect(sent).toEqual(["ada@example.com"]);
	});

	it("sends none once the day's email has gone", async () => {
		const { mailer, sent } = recordingMailer();
		await tellOfSpentTries(verified, mailer, async () => false);
		expect(sent).toEqual([]);
	});

	it("does not use up the day's email when there is nothing to send, or nobody to send it to", async () => {
		const allowEmail = vi.fn(async () => true);
		const { mailer, sent } = recordingMailer();
		await tellOfSpentTries(verified, undefined, allowEmail);
		await tellOfSpentTries({ ...verified, emailVerified: false }, mailer, allowEmail);
		expect(allowEmail).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
	});

	it("sends none without a way to hold it to one a day", async () => {
		const { mailer, sent } = recordingMailer();
		await tellOfSpentTries(verified, mailer, undefined);
		expect(sent).toEqual([]);
	});

	it("resolves when sending fails, and logs what kind of failure and nothing of the person", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failed = new TypeError(`could not reach ${verified.email}`);
		await expect(
			tellOfSpentTries(verified, { send: () => Promise.reject(failed) }, async () => true),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("TypeError");
		expect(warn.mock.calls[0]?.join(" ")).not.toContain(verified.email);
	});

	it("resolves when counting fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { mailer, sent } = recordingMailer();
		await expect(
			tellOfSpentTries(verified, mailer, () => Promise.reject(new Error("no"))),
		).resolves.toBeUndefined();
		expect(sent).toEqual([]);
	});
});

describe("running out of tries at a password", () => {
	it("refuses without waiting for the email, which may never arrive", async () => {
		const d1 = await mf.getD1Database("DB");
		const sentTo: string[] = [];
		const auth = createAuth({
			db: createDb(d1 as unknown as D1Database),
			secret: "a-test-secret-that-is-long-enough-for-better-auth",
			baseURL: "https://mail.test",
			mailer: {
				send: (email) => {
					if (email.subject.startsWith("Too many tries")) sentTo.push(email.to);
					return new Promise(() => {});
				},
			},
			runInBackground: () => {},
			allowPasswordTry: async () => false,
			allowSpentTriesEmail: async () => true,
		});
		const { headers } = await auth.api.signUpEmail({
			body: { name: "Rae", email: "rae@example.com", password: "a-long-test-password" },
			returnHeaders: true,
		});
		const cookie = headers
			.getSetCookie()
			.map((line) => line.split(";")[0])
			.join("; ");
		await d1
			.prepare("UPDATE user SET email_verified = 1 WHERE email = ?")
			.bind("rae@example.com")
			.run();

		const refused = await auth.handler(
			new Request("https://mail.test/api/auth/change-password", {
				method: "POST",
				headers: { cookie, origin: "https://mail.test", "content-type": "application/json" },
				body: JSON.stringify({ currentPassword: "a-guess", newPassword: "another-long-password" }),
			}),
		);

		expect(refused.status).toBe(429);
		await vi.waitFor(() => expect(sentTo).toEqual(["rae@example.com"]));
	});
});
