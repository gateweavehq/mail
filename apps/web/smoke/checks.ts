import { expect, it } from "vitest";

/** A deployment as a stranger reaches it. */
export interface Deployment {
	/** Its address, such as `https://mail.example.com`. */
	origin: string;
	fetch: (input: string, init?: RequestInit) => Promise<Response>;
	/** Whether its sign-in page must offer an OpenID Connect provider, as Gateweave Cloud's does. */
	sso: boolean;
	/**
	 * Whether it must take no new account from a stranger (`SIGN_UP_ALLOW`), as Gateweave Cloud's
	 * must. Otherwise it must be open, as a deployment without the setting is.
	 */
	closed: boolean;
}

/** A key in Mail's shape that no agent has. */
const NOBODYS_KEY = `gwm_${"A".repeat(43)}`;

/**
 * What a deployment must do for someone who is nobody to it. Every check is a request without a
 * session or a key: it signs in to nothing and changes nothing, so it can run against production.
 * `test/smoke.test.ts` runs the same checks against the built Worker, so they are known to pass
 * on a deployment that works, and against stand-ins that are wrong, so they are known to fail.
 */
export const CHECKS: Record<string, (deployment: Deployment) => Promise<void>> = {
	"serves the sign-in page": async ({ origin, fetch, sso }) => {
		const response = await fetch(`${origin}/login`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		const html = await response.text();
		// Not the page a Worker without its secret or its database serves instead.
		expect(html).toContain("Sign in to Gateweave Mail");
		const providers = [...html.matchAll(/>Continue with ([^<]+)</g)].map(([, name]) => name);
		if (sso) expect(providers.filter((name) => name !== "GitHub")).toHaveLength(1);
	},

	"offers a stranger an account only where sign-up is open": async ({ origin, fetch, closed }) => {
		const html = await (await fetch(`${origin}/login`)).text();
		if (closed) expect(html).not.toContain("Create an account");
		else expect(html).toContain("Create an account");
	},

	"makes no account for a stranger": async ({ origin, fetch, closed }) => {
		// Nothing a form could use, so this makes no account on any server. A closed one refuses
		// before it reads what was sent, which is what says it is closed. An open one reads it and
		// finds nothing to make an account from.
		const response = await fetch(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { origin, "content-type": "application/json" },
			body: "{}",
		});
		if (closed) {
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: "SIGN_UP_CLOSED" });
		} else {
			expect(response.status).toBe(400);
		}
		expect(response.headers.getSetCookie()).toEqual([]);
	},

	"knows nobody without a session": async ({ origin, fetch }) => {
		const response = await fetch(`${origin}/api/auth/get-session`);
		expect(response.status).toBe(200);
		expect(await response.json()).toBeNull();
	},

	"turns a stranger away from /mcp": async ({ origin, fetch }) => {
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
	},

	"turns a stranger away from /api/v1": async ({ origin, fetch }) => {
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
	},
};

/** Makes a test of each check, for the deployment `deployment` gives once the tests run. */
export function smokeChecks(deployment: () => Deployment) {
	for (const [name, check] of Object.entries(CHECKS)) {
		it(name, () => check(deployment()));
	}
}

/**
 * Whether an answer is the deployment's own, and not the network's in front of it while a new
 * domain settles: a 5xx, or one of the edge's own error pages, which come with other statuses too
 * (a 403 with "error code: 1xxx", a 404 or 409 for a host it does not serve yet).
 */
export async function isOwnAnswer(response: Response): Promise<boolean> {
	if (response.status >= 500) return false;
	const text = await response.clone().text();
	return !/error code: 1\d{3}\b|cf-error-details|cloudflare-nginx/i.test(text);
}
