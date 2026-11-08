import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "../db";
import { createAuth } from "./config";

/**
 * Every route answering over HTTP, with every feature on, since some only exist with one. An upgrade
 * of Better Auth or a plugin can add a route, and nothing else would notice it being served. A route
 * failing this needs a decision: close it in `disabledPaths`, give it a limit of its own, or add it
 * here because it is fine as it is.
 */
const SERVED = [
	// Signing up, in and out, and what follows from them.
	"GET /error",
	"GET /ok",
	"GET /reset-password/:token",
	"GET /verify-email",
	"GET,POST /callback/:id",
	"GET,POST /get-session",
	"POST /backchannel-logout/:id",
	"POST /request-password-reset",
	"POST /reset-password",
	"POST /send-verification-email",
	"POST /sign-in/email",
	"POST /sign-in/social",
	"POST /sign-out",
	"POST /sign-up/email",

	// Someone's own account and sessions.
	"POST /account/delete",
	"POST /change-password",
	"POST /revoke-other-sessions",
	"POST /revoke-session",
	"POST /revoke-sessions",
	"POST /update-session",
	"POST /update-user",

	// Off unless configured, and they are not: `user.changeEmail` and `user.deleteUser`.
	"GET /delete-user/callback",
	"POST /change-email",
	"POST /delete-user",

	// Workspaces. Each checks membership and role for itself.
	"GET /organization/get-active-member",
	"GET /organization/get-active-member-role",
	"GET /organization/get-invitation",
	"GET /organization/get-organization",
	"GET /organization/list",
	"GET /organization/list-invitations",
	"GET /organization/list-members",
	"GET /organization/list-user-invitations",
	"POST /organization/accept-invitation",
	"POST /organization/cancel-invitation",
	"POST /organization/check-slug",
	"POST /organization/create",
	"POST /organization/delete",
	"POST /organization/has-permission",
	"POST /organization/invite-member",
	"POST /organization/leave",
	"POST /organization/reject-invitation",
	"POST /organization/remove-member",
	"POST /organization/set-active",
	"POST /organization/update",
	"POST /organization/update-member-role",

	// Agents, their keys and what they may send, for owners and admins (`agents.ts`). Making an
	// agent or a key, each a credential, has a limit of its own.
	"GET /agents/list",
	"POST /agents/create",
	"POST /agents/create-key",
	"POST /agents/delete",
	"POST /agents/revoke-key",
	"POST /agents/set-policy",
	"POST /agents/update",
];

let mf: Miniflare;
let db: Database;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "auth-routes-test" },
		}),
	);
	const d1 = await mf.getD1Database("DB");
	const migrations = resolve(import.meta.dirname, "../../../migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await d1.batch(statements.map((statement) => d1.prepare(statement)));
	}
	// Miniflare's D1 type is its own; it is the same binding a Worker gets.
	db = createDb(d1 as unknown as D1Database);
});

afterAll(async () => {
	await mf?.dispose();
});

describe("What Better Auth serves", () => {
	const everyFeature = () =>
		createAuth({
			db,
			secret: "a-test-secret-that-is-long-enough-for-better-auth",
			baseURL: "https://mail.test",
			github: { clientId: "id", clientSecret: "secret" },
			oidc: { issuer: "https://id.test", clientId: "id", clientSecret: "secret" },
			mailer: { send: async () => {} },
		});

	/**
	 * Where a new route is found. Better Auth has no public list of its routes, so this reads what its
	 * router is built from. Only the first test below takes its word for anything; the other two ask
	 * the handler. A route without a path is only ever called in-process.
	 */
	function routes(auth: ReturnType<typeof everyFeature>) {
		const closed = new Set<string>(auth.options.disabledPaths);
		return Object.values(auth.api).flatMap((value) => {
			const endpoint = value as unknown as {
				path?: string;
				options: { method: string | string[]; metadata?: { SERVER_ONLY?: boolean } };
			};
			if (!endpoint.path) return [];
			const { method, metadata } = endpoint.options;
			const open = !metadata?.SERVER_ONLY && !closed.has(endpoint.path);
			return [{ path: endpoint.path, methods: [method].flat(), open }];
		});
	}

	/** What the handler says to someone with no cookie and an empty body. */
	function ask(auth: ReturnType<typeof everyFeature>, method: string, path: string) {
		return auth.handler(
			new Request(`https://mail.test/api/auth${path.replaceAll(/:\w+/g, "x")}`, {
				method,
				headers: { origin: "https://mail.test", "content-type": "application/json" },
				...(method === "GET" ? {} : { body: "{}" }),
			}),
		);
	}

	it("has the routes listed here, and no others", () => {
		const served = routes(everyFeature())
			.filter(({ open }) => open)
			.map(({ path, methods }) => `${methods.join(",")} ${path}`);

		expect(
			{
				added: served.filter((route) => !SERVED.includes(route)),
				gone: SERVED.filter((route) => !served.includes(route)),
			},
			"A route Better Auth serves has changed. See the comment on SERVED for what to decide.",
		).toEqual({ added: [], gone: [] });
	});

	it("answers on every route listed here", async () => {
		const auth = everyFeature();
		for (const route of SERVED) {
			const [methods = "", path = ""] = route.split(" ");
			for (const method of methods.split(",")) {
				expect((await ask(auth, method, path)).status, route).not.toBe(404);
			}
		}
	});

	it("answers 404 on every route closed to HTTP", async () => {
		const auth = everyFeature();
		const unreachable = routes(auth).filter(({ open }) => !open);
		// A closed path no route has any more would be a sign of a renamed one, still open.
		expect(unreachable.map(({ path }) => path)).toEqual(
			expect.arrayContaining([...new Set<string>(auth.options.disabledPaths)]),
		);

		for (const { path, methods } of unreachable) {
			for (const method of methods) {
				expect((await ask(auth, method, path)).status, `${method} ${path}`).toBe(404);
			}
		}
	});
});
