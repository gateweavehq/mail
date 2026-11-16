import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECKS, type Deployment, isOwnAnswer, smokeChecks } from "../smoke/checks";
import { startMail } from "./mail-worker";
import { OIDC_VARS } from "./oidc-provider";

// The smoke tests ask a live deployment (smoke/smoke.test.ts), where a check that is wrong would
// stop a release, or pass one it should stop. Here the same checks meet the built Worker, and
// stand-ins for deployments that are wrong.

const origin = "https://mail.test";

type Mail = Awaited<ReturnType<typeof startMail>>;

describe("the smoke checks, on an open deployment with a sign-in provider", () => {
	let mail: Mail;

	beforeAll(async () => {
		mail = await startMail(origin, { settings: OIDC_VARS });
	});

	afterAll(async () => {
		await mail?.dispose();
	});

	smokeChecks(() => ({ origin, fetch: mail.fetch, sso: true, closed: false }));

	it("makes nothing of what the checks send", async () => {
		const made = await mail.db.prepare("SELECT count(*) AS n FROM user").first<{ n: number }>();
		expect(made?.n).toBe(0);
	});
});

// Closing sign-up (`SIGN_UP_ALLOW`) came in its own pull request, which merges before this one.
// Until the Worker has it, a deployment with the setting is open, and there is nothing closed to
// check: the stand-ins below hold the checks to their word meanwhile.
const closes = existsSync(resolve(import.meta.dirname, "../src/lib/sign-up-allow.ts"));

describe.runIf(closes)("the smoke checks, on a deployment that closed sign-up", () => {
	let mail: Mail;

	beforeAll(async () => {
		mail = await startMail(origin, {
			settings: { ...OIDC_VARS, SIGN_UP_ALLOW: "ada@example.com" },
		});
	});

	afterAll(async () => {
		await mail?.dispose();
	});

	smokeChecks(() => ({ origin, fetch: mail.fetch, sso: true, closed: true }));

	it("would fail if it were told the deployment is open", async () => {
		const told: Deployment = { origin, fetch: mail.fetch, sso: true, closed: false };
		await expect(CHECKS["makes no account for a stranger"]?.(told)).rejects.toThrow();
	});
});

/** A deployment that answers as Mail does, as far as the checks about sign-up ask. */
function standIn({ page, signUp }: { page: "closed" | "open"; signUp: "closed" | "open" }) {
	const fetch = async (input: string, init?: RequestInit) => {
		const { pathname } = new URL(input);
		if (pathname === "/login") {
			const offer = page === "open" ? "<button>Create an account</button>" : "";
			return new Response(`<h1>Sign in to Gateweave Mail</h1>${offer}`, {
				headers: { "content-type": "text/html" },
			});
		}
		if (pathname === "/api/auth/sign-up/email" && init?.method === "POST") {
			return signUp === "closed"
				? Response.json({ code: "SIGN_UP_CLOSED", message: "By invitation." }, { status: 403 })
				: Response.json({ code: "VALIDATION_ERROR" }, { status: 400 });
		}
		return new Response("Not found", { status: 404 });
	};
	return (closed: boolean): Deployment => ({ origin, fetch, sso: false, closed });
}

const PAGE = "offers a stranger an account only where sign-up is open";
const FORM = "makes no account for a stranger";

describe("the checks that sign-up is closed", () => {
	it("pass a deployment that is closed, when told it must be", async () => {
		const closed = standIn({ page: "closed", signUp: "closed" });
		await CHECKS[PAGE]?.(closed(true));
		await CHECKS[FORM]?.(closed(true));
	});

	it("fail a deployment that is open, when told it must be closed", async () => {
		// What a release without `SIGN_UP_ALLOW` would be.
		const open = standIn({ page: "open", signUp: "open" });
		await expect(CHECKS[PAGE]?.(open(true))).rejects.toThrow();
		await expect(CHECKS[FORM]?.(open(true))).rejects.toThrow();
	});

	it("fail a deployment whose page hides sign-up while its server still takes it", async () => {
		const hidden = standIn({ page: "closed", signUp: "open" });
		await CHECKS[PAGE]?.(hidden(true));
		await expect(CHECKS[FORM]?.(hidden(true))).rejects.toThrow();
	});

	it("fail a deployment that set a session cookie", async () => {
		const leaky: Deployment = {
			origin,
			sso: false,
			closed: true,
			fetch: async () =>
				Response.json(
					{ code: "SIGN_UP_CLOSED" },
					{ status: 403, headers: { "set-cookie": "session=1" } },
				),
		};
		await expect(CHECKS[FORM]?.(leaky)).rejects.toThrow();
	});
});

describe("whether an answer is the deployment's own", () => {
	it.each([
		["a page", new Response("<h1>Sign in to Gateweave Mail</h1>"), true],
		["a refusal of its own", Response.json({ code: "SIGN_UP_CLOSED" }, { status: 403 }), true],
		["a failure of its own", new Response("Internal Server Error", { status: 500 }), false],
		["the edge with no certificate yet", new Response("error code: 526", { status: 526 }), false],
		["the edge's own refusal", new Response("error code: 1042", { status: 403 }), false],
		["the edge with no such host", new Response("error code: 1001", { status: 409 }), false],
		[
			"the edge's error page",
			new Response('<div id="cf-error-details">Web server is down</div>', { status: 404 }),
			false,
		],
	])("%s", async (_what, response, own) => {
		expect(await isOwnAnswer(response)).toBe(own);
	});
});
