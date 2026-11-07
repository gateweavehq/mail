import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMail } from "./mail-worker";

// The Worker's `email()` handler, reached the way Email Routing reaches it: through the built
// Worker's entry, in workerd. No address exists yet, so everything is refused, for good.

const origin = "https://mail.test";

const message = (to: string) =>
	[
		"From: Sender <sender@example.org>",
		`To: ${to}`,
		"Subject: Hello",
		"Message-ID: <one@example.org>",
		"",
		"Is anyone there?",
		"",
	].join("\r\n");

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin);
});

afterAll(async () => {
	await mail?.dispose();
});

describe("incoming mail", () => {
	it("is refused for good, saying there is no such address", async () => {
		const answer = await mail.deliver(
			"sender@example.org",
			"anyone@mail.test",
			message("anyone@mail.test"),
		);
		expect(answer.status).toBe(400);
		expect(answer.text).toContain("No such address");
	});

	it("is refused the same way every time, as a sender's retry would be", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const answer = await mail.deliver(
				"sender@example.org",
				"again@mail.test",
				message("again@mail.test"),
			);
			expect(answer.status).toBe(400);
			expect(answer.text).toContain("No such address");
		}
	});

	it("is refused even when the address looks like one a person made", async () => {
		const answer = await mail.deliver(
			"sender@example.org",
			"first.last@mail.test",
			message("first.last@mail.test"),
		);
		expect(answer.text).toContain("No such address");
	});

	it("leaves the sign-in pages alone", async () => {
		const login = await mail.fetch(`${origin}/login`);
		expect(login.status).toBe(200);
	});
});
