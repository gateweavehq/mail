import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "./accounts";
import { startMail } from "./mail-worker";

const origin = "https://mail.test";

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin);
});

afterAll(async () => {
	await mail?.dispose();
});

describe("the page", () => {
	it("shows who is signed in, but not their session's token", async () => {
		const { headers } = await signUp(mail, origin, "page-token");
		const signed = /session_token=([^;]+)/.exec(headers.cookie)?.[1] ?? "";
		const token = decodeURIComponent(signed).split(".")[0] ?? "";
		expect(token.length).toBeGreaterThan(16);

		const response = await mail.fetch(`${origin}/`, { headers: { cookie: headers.cookie } });
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("page-token@example.com");
		expect(html).not.toContain(token);
	});
});
