import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMail } from "./mail-worker";

// What the built Worker tells a browser about its pages. Without these, any site can put Mail in
// a frame under its own buttons, and a script that got into a page could do as it liked.

const origin = "https://mail.test";

let mail: Awaited<ReturnType<typeof startMail>>;
let cookie: string;

function nonceOf(policy: string | null): string {
	const nonce = /'nonce-([^']+)'/.exec(policy ?? "")?.[1];
	if (!nonce) throw new Error(`No nonce in: ${policy}`);
	return nonce;
}

/** Every script tag in a page, as the opening tag. */
function scriptTags(html: string): string[] {
	return html.match(/<script\b[^>]*>/gi) ?? [];
}

function post(path: string, body: object) {
	return mail.fetch(`${origin}${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": "203.0.113.95",
			"content-type": "application/json",
			...(cookie && { cookie }),
		},
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	mail = await startMail(origin);
	const signedUp = await post("/api/auth/sign-up/email", {
		name: "Hana",
		email: "hana@headers.test",
		password: "a-long-test-password",
	});
	expect(signedUp.status).toBe(200);
	cookie = signedUp.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
	const created = await post("/api/auth/organization/create", {
		name: "Headers",
		slug: "headers",
	});
	expect(created.status).toBe(200);
});

afterAll(async () => {
	await mail?.dispose();
});

describe("a page", () => {
	it("cannot be framed or sniffed, and is not cached", async () => {
		const response = await mail.fetch(`${origin}/login`);
		expect(response.status).toBe(200);
		const policy = response.headers.get("content-security-policy");
		expect(policy).toContain("default-src 'none'");
		expect(policy).toContain("frame-ancestors 'none'");
		expect(policy).toContain("base-uri 'none'");
		expect(policy).toContain("form-action 'self'");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
	});

	it("runs only scripts that carry its nonce", async () => {
		const response = await mail.fetch(`${origin}/login`);
		const policy = response.headers.get("content-security-policy") ?? "";
		const scripts = policy.split("; ").find((each) => each.startsWith("script-src"));
		expect(scripts).toBe(`script-src 'self' 'nonce-${nonceOf(policy)}'`);
	});

	it.each(["/login", "/forgot-password"])(
		"lets every script of %s run, because each one has this response's nonce",
		async (path) => {
			const response = await mail.fetch(`${origin}${path}`);
			const nonce = nonceOf(response.headers.get("content-security-policy"));
			const html = await response.text();
			const tags = scriptTags(html);
			expect(tags.length).toBeGreaterThan(0);
			for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
			// The router reads it back from here in the browser.
			expect(html).toContain(`property="csp-nonce" content="${nonce}"`);
		},
	);

	it("gives a signed-in page's scripts the nonce too", async () => {
		const response = await mail.fetch(`${origin}/headers`, { headers: { cookie } });
		expect(response.status).toBe(200);
		const nonce = nonceOf(response.headers.get("content-security-policy"));
		const tags = scriptTags(await response.text());
		expect(tags.length).toBeGreaterThan(0);
		for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
	});

	it("gets a nonce of its own every time", async () => {
		const first = await mail.fetch(`${origin}/login`);
		const second = await mail.fetch(`${origin}/login`);
		expect(nonceOf(first.headers.get("content-security-policy"))).not.toBe(
			nonceOf(second.headers.get("content-security-policy")),
		);
	});

	it("names the socket the page opens, on the host it came from", async () => {
		const secure = await mail.fetch(`${origin}/login`);
		expect(secure.headers.get("content-security-policy")).toContain(
			"connect-src 'self' wss://mail.test",
		);
		const plain = await mail.fetch("http://localhost:4750/login");
		expect(plain.headers.get("content-security-policy")).toContain(
			"connect-src 'self' ws://localhost:4750",
		);
	});

	it("keeps a browser on plain HTTP free to stay there", async () => {
		const plain = await mail.fetch("http://localhost:4750/login");
		expect(plain.headers.get("strict-transport-security")).toBeNull();
		expect(plain.headers.get("x-frame-options")).toBe("DENY");
	});
});

describe("an answer that is not a page", () => {
	it("gets the headers that apply to it, and no policy for pages", async () => {
		const response = await mail.fetch(`${origin}/api/auth/get-session`, { headers: { origin } });
		expect(response.status).toBe(200);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
		expect(response.headers.get("content-security-policy")).toBeNull();
		expect(response.headers.get("x-frame-options")).toBeNull();
	});
});
