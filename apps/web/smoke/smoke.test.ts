import { beforeAll, describe } from "vitest";
import { isOwnAnswer, smokeChecks } from "./checks";

// A live deployment, from outside: `MAIL_SMOKE_URL=https://mail.example.com pnpm test:smoke`.
// Gateweave Cloud's deploy runs this after production (.github/workflows/deploy.yml). With
// `MAIL_SMOKE_SSO=1` the sign-in page must also offer an OpenID Connect provider, and with
// `MAIL_SMOKE_CLOSED=1` the deployment must take no new account from a stranger.

const address = process.env.MAIL_SMOKE_URL;
if (!address) throw new Error("Set MAIL_SMOKE_URL to the deployment's address");
const { origin, protocol } = new URL(address);
if (protocol !== "https:") throw new Error("MAIL_SMOKE_URL must be an https address");

/** How long a new deployment gets to answer as itself, such as while its domain's certificate is made. */
const SETTLES_WITHIN_MS = 180_000;
const PAUSE_MS = 5_000;

// A redirect would be a deployment that answers somewhere else: it is the answer, not followed.
const ask = (input: string, init?: RequestInit) =>
	fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });

describe(`the deployment at ${origin}`, () => {
	beforeAll(async () => {
		// Until the sign-in page is the deployment's own answer: no connection yet, a 5xx and the
		// edge's own error pages are all a domain that has not settled, and are asked again after
		// a pause. What the answer says is for the checks, which then run once, without retries.
		const deadline = Date.now() + SETTLES_WITHIN_MS;
		for (;;) {
			let last: string;
			try {
				const response = await ask(`${origin}/login`);
				if (await isOwnAnswer(response)) return;
				last = `status ${response.status}`;
			} catch (error) {
				last = error instanceof Error ? error.message : String(error);
			}
			if (Date.now() > deadline) {
				throw new Error(`${origin} did not answer as itself within three minutes: ${last}`);
			}
			await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
		}
	}, SETTLES_WITHIN_MS + 60_000);

	smokeChecks(() => ({
		origin,
		fetch: ask,
		sso: process.env.MAIL_SMOKE_SSO === "1",
		closed: process.env.MAIL_SMOKE_CLOSED === "1",
	}));
});
