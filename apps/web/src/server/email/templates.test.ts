import { describe, expect, it } from "vitest";
import {
	invitationEmail,
	passwordResetEmail,
	passwordTriesSpentEmail,
	verificationEmail,
} from "./templates";

const DAY = 24 * 60 * 60 * 1000;

describe("invitationEmail", () => {
	const now = Date.UTC(2026, 9, 28);
	const base = {
		inviter: { name: "Maya Chen", email: "maya@example.com" },
		workspace: "Acme",
		url: "https://mail.example.com/invite/abc?x=1&y=2",
		expiresAt: now + 7 * DAY,
		now,
	};

	it("says who invited whom to what, and links to the invitation", () => {
		const email = invitationEmail(base);
		expect(email.subject).toBe("Maya Chen invited you to Acme on Gateweave Mail");
		expect(email.text).toContain("Maya Chen (maya@example.com)");
		expect(email.text).toContain(base.url);
		expect(email.text).toContain("expires in 7 days");
		expect(email.html).toContain('href="https://mail.example.com/invite/abc?x=1&amp;y=2"');
	});

	it("escapes names in HTML and keeps them to one short line", () => {
		const email = invitationEmail({
			...base,
			inviter: { name: "Mallory\r\nBcc: everyone", email: "m@example.com" },
			workspace: `<img src=x onerror=alert(1)> ${"very ".repeat(30)}long`,
		});
		expect(email.subject).not.toMatch(/[\r\n]/);
		expect(email.subject).toContain("Mallory Bcc: everyone invited you to");
		expect(email.subject).toContain("…");
		expect(email.html).not.toContain("<img");
		expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("counts down to a day, never zero", () => {
		const email = invitationEmail({ ...base, expiresAt: now + 3 * 60 * 60 * 1000 });
		expect(email.text).toContain("expires in 1 day.");
	});
});

describe("passwordResetEmail", () => {
	it("links to the reset and says what happens", () => {
		const url = "https://mail.example.com/api/auth/reset-password/token?callbackURL=%2Freset";
		const email = passwordResetEmail({ url });
		expect(email.subject).toBe("Reset your Gateweave Mail password");
		expect(email.text).toContain(url);
		expect(email.text).toContain("signs you out on every device");
		expect(email.html).toContain(`href="${url}"`);
	});
});

describe("passwordTriesSpentEmail", () => {
	it("names the account, says it is refused for now and what to do, and links nowhere", () => {
		const email = passwordTriesSpentEmail({ email: "ada@example.com" });
		expect(email.subject).toBe("Too many tries at your Gateweave Mail password");
		expect(email.text).toContain("ada@example.com");
		expect(email.text).toContain("even if it is the right one");
		expect(email.text).toContain("Sign out everywhere");
		// Someone who reads this may be under attack, and a link would teach them to follow one.
		expect(email.text).not.toContain("http");
		expect(email.html).not.toContain("href");
	});
});

describe("verificationEmail", () => {
	it("links to the verification and says how long it works", () => {
		const url = "https://mail.example.com/api/auth/verify-email?token=t&callbackURL=%2F";
		const email = verificationEmail({ url });
		expect(email.subject).toBe("Verify your email for Gateweave Mail");
		expect(email.text).toContain(url);
		expect(email.text).toContain("24 hours");
		expect(email.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
	});
});
