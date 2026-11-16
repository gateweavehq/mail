import { expect, it } from "vitest";

/** A deployment as a stranger reaches it. */
export interface Deployment {
	/** Its address, such as `https://mail.example.com`. */
	origin: string;
	fetch: (input: string, init?: RequestInit) => Promise<Response>;
	/** Whether its sign-in page must offer an OpenID Connect provider, as Gateweave Cloud's does. */
	sso: boolean;
}

/** A key in Mail's shape that no agent has. */
const NOBODYS_KEY = `gwm_${"A".repeat(43)}`;

/**
 * What a deployment must do for someone who is nobody to it. Every check is a request without a
 * session or a key: it signs in to nothing and changes nothing, so it can run against production.
 * `test/smoke.test.ts` runs the same checks against the built Worker, so they are known to pass
 * on a deployment that works.
 */
export function smokeChecks(deployment: () => Deployment) {
	it("serves the sign-in page", async () => {
		const { origin, fetch, sso } = deployment();
		const response = await fetch(`${origin}/login`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		const html = await response.text();
		// Not the page a Worker without its secret or its database serves instead.
		expect(html).toContain("Sign in to Gateweave Mail");
		const providers = [...html.matchAll(/>Continue with ([^<]+)</g)].map(([, name]) => name);
		if (sso) expect(providers.filter((name) => name !== "GitHub")).toHaveLength(1);
	});

	it("knows nobody without a session", async () => {
		const { origin, fetch } = deployment();
		const response = await fetch(`${origin}/api/auth/get-session`);
		expect(response.status).toBe(200);
		expect(await response.json()).toBeNull();
	});

	it("turns a stranger away from /mcp", async () => {
		const { origin, fetch } = deployment();
		const asked: Record<string, string>[] = [{}, { authorization: `Bearer ${NOBODYS_KEY}` }];
		for (const headers of asked) {
			const response = await fetch(`${origin}/mcp`, {
				method: "POST",
				headers: {
					...headers,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "smoke", version: "1.0.0" },
					},
				}),
			});
			expect(response.status).toBe(401);
		}
	});

	it("turns a stranger away from /api/v1", async () => {
		const { origin, fetch } = deployment();
		const none = await fetch(`${origin}/api/v1/mailboxes`);
		expect(none.status).toBe(401);
		expect(none.headers.get("www-authenticate")).toContain("Bearer");
		// A key in the right shape is looked up, so this also says the database answers and has
		// its tables: a deployment whose migrations did not run fails here, not with a 401.
		const wrong = await fetch(`${origin}/api/v1/mailboxes`, {
			headers: { authorization: `Bearer ${NOBODYS_KEY}` },
		});
		expect(wrong.status).toBe(401);
		expect(wrong.headers.get("www-authenticate")).toContain("invalid_token");
	});
}
