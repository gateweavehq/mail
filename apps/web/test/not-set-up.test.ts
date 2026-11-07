import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMail } from "./mail-worker";

// A branch's Preview gets none of the Worker's bindings or secrets. A deployment missing either the
// database or the secret says why and serves nothing else.

const origin = "https://mail.test";

describe.each([
	["no database", { withoutDatabase: true }],
	["no secret", { withoutSecret: true }],
])("a deployment with %s", (_, missing) => {
	let worker: Awaited<ReturnType<typeof startMail>>;

	beforeAll(async () => {
		worker = await startMail(origin, missing);
	});
	afterAll(() => worker.dispose());

	it.each(["/", "/login", "/api/auth/get-session"])("says why at %s", async (path) => {
		const response = await worker.fetch(`${origin}${path}`);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("docs/self-hosting.md");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
	});

	it("makes no account and no session", async () => {
		const response = await worker.fetch(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({
				name: "Someone",
				email: "someone@example.com",
				password: "a long enough password",
			}),
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("set-cookie")).toBeNull();
	});
});

describe("mail to a deployment with no database", () => {
	// It can't know the address doesn't exist, and a refusal would tell the sender that for good.
	it("tells the sender to try again", async () => {
		const worker = await startMail(origin, { withoutDatabase: true });
		try {
			const answer = await worker.deliver(
				"sender@example.org",
				"someone@mail.test",
				[
					"From: Sender <sender@example.org>",
					"To: someone@mail.test",
					"Subject: Hello",
					"Message-ID: <one@example.org>",
					"",
					"Hello",
					"",
				].join("\r\n"),
			);
			expect(answer.status).toBeGreaterThanOrEqual(500);
			expect(answer.text).not.toContain("No such address");
		} finally {
			await worker.dispose();
		}
	});
});
