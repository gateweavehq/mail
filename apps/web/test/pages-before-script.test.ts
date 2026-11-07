import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMail } from "./mail-worker";

// Pressed before the page's script has run, a submit button makes the browser send the form itself,
// as a GET, with what was typed in the URL. So what matters is the HTML the server sends, and these
// read it. The browser's side of this was checked by hand: see the pull request.

const origin = "https://mail.test";

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin, {
		settings: { GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "secret" },
	});
});

afterAll(async () => {
	await mail?.dispose();
});

/** The opening tag of the page's submit button, as the server sent it. */
async function submitButton(path: string) {
	const response = await mail.fetch(`${origin}${path}`);
	expect(response.status).toBe(200);
	const tags = (await response.text()).match(/<button\b[^>]*>/g) ?? [];
	const submit = tags.filter((tag) => tag.includes('type="submit"'));
	expect(submit).toHaveLength(1);
	return submit[0];
}

describe("a form that is on the page before its script", () => {
	it.each([
		["signing in", "/login"],
		["signing up", "/login?mode=sign-up"],
		["choosing a new password", "/reset-password?token=not-checked-until-it-is-sent"],
		["asking for a reset link", "/forgot-password"],
	])("cannot be sent when %s", async (_, path) => {
		// The attribute, not the `disabled:` of a class name in the same tag.
		expect(await submitButton(path)).toMatch(/\sdisabled(=|\s|>)/);
	});

	it("does not offer GitHub until it can go there", async () => {
		const response = await mail.fetch(`${origin}/login`);
		const tags = (await response.text()).match(/<button\b[^>]*>/g) ?? [];
		// The first button on the page, above the form.
		expect(tags[0]).not.toContain('type="submit"');
		expect(tags[0]).toMatch(/\sdisabled(=|\s|>)/);
	});

	it("has no form that could go without its button", async () => {
		for (const path of ["/login", "/forgot-password", "/reset-password?token=x"]) {
			const html = await (await mail.fetch(`${origin}${path}`)).text();
			expect(html.match(/<form\b/g) ?? []).toHaveLength(1);
		}
	});
});
