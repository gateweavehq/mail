import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAIL_FROM, type SentEmail, startMail } from "./mail-worker";

// Password reset and invitations by email, against the built Worker with email configured.

const origin = "https://mail.test";

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin);
});

afterAll(async () => {
	await mail?.dispose();
});

/** Calls Better Auth as the app's own pages do, each test from its own client address. */
function authApi(path: string, init: { client: string; cookie?: string; body?: object }) {
	return mail.fetch(`${origin}/api/auth${path}`, {
		method: init.body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			...(init.body && { "content-type": "application/json" }),
			...(init.cookie && { cookie: init.cookie }),
		},
		body: init.body && JSON.stringify(init.body),
	});
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

async function signUp(client: string, name: string, email: string, password: string) {
	const response = await authApi("/sign-up/email", { client, body: { name, email, password } });
	expect(response.status).toBe(200);
	return cookieOf(response);
}

/** Email is sent after the response, so wait for it to arrive. */
async function emailTo(address: string, subject: string): Promise<SentEmail> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const email = (await mail.emails()).find(
			(sent) => sent.to === address && sent.subject === subject,
		);
		if (email) return email;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No email to ${address} about "${subject}"`);
}

async function emailsTo(address: string) {
	return (await mail.emails()).filter((sent) => sent.to === address);
}

describe("password reset", () => {
	const client = "203.0.113.10";

	it("emails a link that sets a new password and signs out everywhere", async () => {
		const oldSession = await signUp(client, "Sam Ortiz", "sam@example.com", "the-old-password");

		// Someone without an account gets the same answer, and no email.
		for (const email of ["nobody@example.com", "sam@example.com"]) {
			const response = await authApi("/request-password-reset", {
				client,
				body: { email, redirectTo: "/reset-password" },
			});
			expect(response.status).toBe(200);
		}

		const email = await emailTo("sam@example.com", "Reset your Gateweave Mail password");
		expect(email.from).toEqual(EMAIL_FROM);
		const link = /https:\/\/mail\.test\/api\/auth\/reset-password\/\S+/.exec(email.text)?.[0];
		if (!link) throw new Error(`No reset link in: ${email.text}`);
		expect(email.html).toContain(link.replaceAll("&", "&amp;"));
		expect(await emailsTo("nobody@example.com")).toEqual([]);

		// The link checks the token and hands it to the app's page.
		const opened = await mail.fetch(link, { headers: { "cf-connecting-ip": client } });
		expect(opened.status).toBe(302);
		const page = new URL(opened.headers.get("location") ?? "", origin);
		expect(page.pathname).toBe("/reset-password");
		const token = page.searchParams.get("token");
		if (!token) throw new Error(`No token in ${page.href}`);

		const reset = await authApi("/reset-password", {
			client,
			body: { token, newPassword: "the-new-password" },
		});
		expect(reset.status).toBe(200);

		const session = await authApi("/get-session", { client, cookie: oldSession });
		expect(await session.json()).toBeNull();
		const withNew = await authApi("/sign-in/email", {
			client: "203.0.113.11",
			body: { email: "sam@example.com", password: "the-new-password" },
		});
		expect(withNew.status).toBe(200);
		const withOld = await authApi("/sign-in/email", {
			client: "203.0.113.11",
			body: { email: "sam@example.com", password: "the-old-password" },
		});
		expect(withOld.status).toBe(401);

		// A link works once.
		const again = await authApi("/reset-password", {
			client,
			body: { token, newPassword: "another-password" },
		});
		expect(again.status).toBe(400);
		expect(mail.outbound).toEqual([]);
	});
});

describe("invitations", () => {
	const client = "203.0.113.20";

	it("are emailed only by people who verified their own address", async () => {
		const cookie = await signUp(client, "Maya Chen", "maya@example.com", "a-long-test-password");
		const created = await authApi("/organization/create", {
			client,
			cookie,
			body: { name: "Acme & <Co>", slug: "acme" },
		});
		expect(created.status).toBe(200);
		const { id: organizationId } = (await created.json()) as { id: string };

		async function invite(email: string) {
			const response = await authApi("/organization/invite-member", {
				client,
				cookie,
				body: { email, role: "member", organizationId },
			});
			expect(response.status).toBe(200);
			return ((await response.json()) as { id: string }).id;
		}

		// Anyone can sign up with any address, so an unverified inviter shares the link instead.
		await invite("lena@example.com");

		await mail.db
			.prepare("UPDATE user SET email_verified = 1 WHERE email = ?")
			.bind("maya@example.com")
			.run();
		const invitationId = await invite("diego@example.com");

		const email = await emailTo(
			"diego@example.com",
			"Maya Chen invited you to Acme & <Co> on Gateweave Mail",
		);
		expect(email.from).toEqual(EMAIL_FROM);
		const link = `${origin}/invite/${invitationId}`;
		expect(email.text).toContain(link);
		expect(email.text).toContain("maya@example.com");
		expect(email.html).toContain(`href="${link}"`);
		expect(email.html).toContain("Acme &amp; &lt;Co&gt;");
		expect(email.html).not.toContain("<Co>");
		expect(await emailsTo("lena@example.com")).toEqual([]);
		expect(mail.outbound).toEqual([]);
	});
});

describe("email verification", () => {
	const client = "203.0.113.30";

	it("is required to accept an invitation, and the emailed link provides it", async () => {
		const owner = await signUp(client, "Ana Silva", "ana@example.com", "a-long-test-password");
		await mail.db
			.prepare("UPDATE user SET email_verified = 1 WHERE email = ?")
			.bind("ana@example.com")
			.run();
		const created = await authApi("/organization/create", {
			client,
			cookie: owner,
			body: { name: "Globex", slug: "globex" },
		});
		const { id: organizationId } = (await created.json()) as { id: string };
		const invited = await authApi("/organization/invite-member", {
			client,
			cookie: owner,
			body: { email: "ravi@example.com", role: "member", organizationId },
		});
		const { id: invitationId } = (await invited.json()) as { id: string };

		// Signing up under the invited address is not enough: anyone could type it.
		const signedUp = await authApi("/sign-up/email", {
			client,
			body: {
				name: "Ravi Patel",
				email: "ravi@example.com",
				password: "a-long-test-password",
				callbackURL: `/invite/${invitationId}`,
			},
		});
		const ravi = cookieOf(signedUp);
		const refused = await authApi("/organization/accept-invitation", {
			client,
			cookie: ravi,
			body: { invitationId },
		});
		expect(refused.status).toBe(403);

		const email = await emailTo("ravi@example.com", "Verify your email for Gateweave Mail");
		const link = /https:\/\/mail\.test\/api\/auth\/verify-email\?\S+/.exec(email.text)?.[0];
		if (!link) throw new Error(`No verification link in: ${email.text}`);

		const opened = await mail.fetch(link, { headers: { "cf-connecting-ip": client } });
		expect(opened.status).toBe(302);
		expect(opened.headers.get("location")).toBe(`/invite/${invitationId}`);
		const verified = cookieOf(opened) || ravi;

		const accepted = await authApi("/organization/accept-invitation", {
			client,
			cookie: verified,
			body: { invitationId },
		});
		expect(accepted.status).toBe(200);
		expect(mail.outbound).toEqual([]);
	});
});

describe("limits", () => {
	it("caps the emails one address gets, however many clients ask for them", async () => {
		// Signing up sends the first one, to verify the address.
		await signUp("203.0.113.40", "Kai Novak", "kai@example.com", "a-long-test-password");
		// Each reset comes from another client, so no per-client limit gets in the way.
		for (let n = 1; n <= 5; n++) {
			const response = await authApi("/request-password-reset", {
				client: `203.0.113.${40 + n}`,
				body: { email: "kai@example.com", redirectTo: "/reset-password" },
			});
			expect(response.status).toBe(200);
		}

		// Five go out at once (EMAILS_PER_RECIPIENT); the sixth is dropped.
		for (let attempt = 0; attempt < 100; attempt++) {
			const dropped = mail.logs.some((log) => log.message.startsWith("email: not sent"));
			if (dropped && (await emailsTo("kai@example.com")).length === 5) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(await emailsTo("kai@example.com")).toHaveLength(5);
		expect(mail.logs.filter((log) => log.message.startsWith("email: not sent"))).toHaveLength(1);
		expect(mail.logs.filter((log) => log.message.startsWith("rate limit:"))).toEqual([]);
	});
});
