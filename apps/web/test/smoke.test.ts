import { afterAll, beforeAll, describe } from "vitest";
import { smokeChecks } from "../smoke/checks";
import { startMail } from "./mail-worker";
import { OIDC_VARS } from "./oidc-provider";

// The smoke tests ask a live deployment (smoke/smoke.test.ts), where a check that is wrong would
// stop a release, or pass one it should stop. Here the same checks meet the built Worker.

const origin = "https://mail.test";

type Mail = Awaited<ReturnType<typeof startMail>>;

describe("the smoke checks, on a deployment with a sign-in provider", () => {
	let mail: Mail;

	beforeAll(async () => {
		mail = await startMail(origin, { settings: OIDC_VARS });
	});

	afterAll(async () => {
		await mail?.dispose();
	});

	smokeChecks(() => ({ origin, fetch: mail.fetch, sso: true }));
});
