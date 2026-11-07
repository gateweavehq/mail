import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./security-headers";

// The Worker tests (test/security-headers.test.ts) cover what a browser is sent. These cover the
// settings a test server would need starting again for.

const url = new URL("https://mail.example.com/acme");

function imagesAllowed(oidcIssuer?: string) {
	return contentSecurityPolicy("nonce", { url, oidcIssuer })
		.split("; ")
		.find((directive) => directive.startsWith("img-src"));
}

describe("where a member's picture may come from", () => {
	it("is GitHub, for an account that signed in there", () => {
		expect(imagesAllowed()).toBe("img-src 'self' data: https://avatars.githubusercontent.com");
	});

	it("is the sign-in provider too, by its origin alone", () => {
		expect(imagesAllowed("https://id.example.com/some/path")).toBe(
			"img-src 'self' data: https://avatars.githubusercontent.com https://id.example.com",
		);
	});

	// A mistake in a setting must not turn into a broken policy on every page.
	it.each(["not an address", "javascript:alert(1)", "https://x.example.com;script-src"])(
		"leaves out %s",
		(issuer) => {
			const policy = contentSecurityPolicy("nonce", { url, oidcIssuer: issuer });
			expect(policy).not.toContain("alert");
			expect(policy.match(/script-src/g)).toHaveLength(1);
		},
	);
});

it("leaves out a socket whose host would end the directive", () => {
	const policy = contentSecurityPolicy("nonce", {
		url: new URL("https://mail.example.com;script-src/acme"),
	});
	expect(policy).toContain("connect-src 'self';");
	expect(policy.match(/script-src/g)).toHaveLength(1);
});

it("allows no host at all by default, so that nothing forgotten gets through", () => {
	const policy = contentSecurityPolicy("nonce", { url });
	expect(policy.startsWith("default-src 'none'")).toBe(true);
	expect(policy).not.toContain("*");
	expect(policy).not.toContain("unsafe-eval");
	const scripts = policy.split("; ").find((directive) => directive.startsWith("script-src"));
	expect(scripts).not.toContain("unsafe-inline");
});
