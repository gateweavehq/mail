import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMail } from "./mail-worker";

// A server with no email cannot send anyone a reset link, so docs/self-hosting.md tells whoever runs
// it how to make one. This runs what the guide says, against the public routes of the built Worker.

const origin = "https://mail.test";
const PASSWORD = "a-long-test-password";
const NEW_PASSWORD = "another-long-test-password";

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin, { settings: { EMAIL_FROM: "" } });
});

afterAll(async () => {
	await mail?.dispose();
});

let clients = 0;

function post(path: string, body: object) {
	clients += 1;
	return mail.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": `198.51.100.${clients}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

const guide = readFileSync(
	join(import.meta.dirname, "..", "..", "..", "docs", "self-hosting.md"),
	"utf8",
);

function fromGuide(pattern: RegExp) {
	const statement = pattern.exec(guide)?.[1];
	if (!statement) throw new Error("The guide has no such statement");
	return statement;
}

const LIST = /"(SELECT id, email FROM user[^"]*)"/;
const MAKE_LINK = /"(INSERT INTO verification [^"]+)"/;

/** Finds someone as the guide says to: by reading the list. */
async function idFromTheList(email: string) {
	const { results } = await mail.db.prepare(fromGuide(LIST)).all();
	const id = (results as { id: string; email: string }[]).find((row) => row.email === email)?.id;
	if (!id) throw new Error("They are not in the list");
	return id;
}

/** The statement the guide gives, for this person and this token. */
function statementFor(person: string, token: string) {
	return fromGuide(MAKE_LINK).replaceAll("$TOKEN", token).replaceAll("$PERSON", person);
}

async function sessionOf(cookie: string) {
	clients += 1;
	const response = await mail.fetch(`${origin}/api/auth/get-session`, {
		headers: { "cf-connecting-ip": `198.51.100.${clients}`, cookie },
	});
	return response.json();
}

describe("a server that sends no email", () => {
	it("has nobody paste an address into a command", () => {
		// An address can hold a quote or a $( ), and this runs in a shell and in SQL.
		expect(fromGuide(MAKE_LINK)).not.toContain("@");
		expect(fromGuide(LIST)).not.toContain("@");
	});

	it("lets whoever runs it help someone back in, as the guide says, once", async () => {
		const email = "locked-out@reset.test";
		const entered = await post("/sign-up/email", { name: "Ada", email, password: PASSWORD });
		expect(entered.status).toBe(200);
		const cookie = entered.headers
			.getSetCookie()
			.map((line) => line.split(";")[0] ?? "")
			.filter((line) => !line.endsWith("="))
			.join("; ");
		expect(await sessionOf(cookie)).toMatchObject({ user: { email } });

		// It says it cannot do this for them, so the guide is the only way.
		const page = await mail.fetch(`${origin}/forgot-password`);
		expect(await page.text()).toContain("does not send email");

		const token = "a-token-as-openssl-would-make-it";
		await mail.db.prepare(statementFor(await idFromTheList(email), token)).run();
		const opened = await mail.fetch(`${origin}/reset-password?token=${token}`);
		expect(opened.status).toBe(200);

		const chosen = await post("/reset-password", { token, newPassword: NEW_PASSWORD });
		expect(chosen.status).toBe(200);

		expect(await sessionOf(cookie)).toBeNull();
		expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(401);
		expect((await post("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);

		const again = await post("/reset-password", {
			token,
			newPassword: "yet-another-long-password",
		});
		expect(again.status).toBe(400);
		expect((await post("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
	});

	it("changes nothing with a link for an id nobody has", async () => {
		const token = "a-token-for-nobody";
		await mail.db.prepare(statementFor("not-anyone", token)).run();
		expect((await post("/reset-password", { token, newPassword: NEW_PASSWORD })).status).toBe(400);
	});

	it("stops taking a link that has run out", async () => {
		const email = "too-late@reset.test";
		const entered = await post("/sign-up/email", { name: "Ada", email, password: PASSWORD });
		expect(entered.status).toBe(200);

		const token = "a-token-left-too-long";
		await mail.db.prepare(statementFor(await idFromTheList(email), token)).run();
		const row = await mail.db
			.prepare("SELECT expires_at AS expiresAt FROM verification WHERE identifier = ?")
			.bind(`reset-password:${token}`)
			.first<{ expiresAt: number }>();
		// An hour, as the guide says.
		expect(row?.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
		expect(row?.expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);

		await mail.db
			.prepare("UPDATE verification SET expires_at = ? WHERE identifier = ?")
			.bind(Date.now() - 1000, `reset-password:${token}`)
			.run();
		expect((await post("/reset-password", { token, newPassword: NEW_PASSWORD })).status).toBe(400);
		expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
	});
});
