import { beforeAll, describe } from "vitest";
import { smokeChecks } from "./checks";

// A live deployment, from outside: `MAIL_SMOKE_URL=https://mail.example.com pnpm test:smoke`.
// Gateweave Cloud's deploy runs this after production (.github/workflows/deploy.yml). With
// `MAIL_SMOKE_SSO=1` the sign-in page must also offer an OpenID Connect provider.

const address = process.env.MAIL_SMOKE_URL;
if (!address) throw new Error("Set MAIL_SMOKE_URL to the deployment's address");
const { origin, protocol } = new URL(address);
if (protocol !== "https:") throw new Error("MAIL_SMOKE_URL must be an https address");

/** How long a deployment gets to answer at all, such as while a new domain's certificate is made. */
const REACHABLE_WITHIN_MS = 180_000;

// A redirect would be a deployment that answers somewhere else: it is the answer, not followed.
const ask = (input: string, init?: RequestInit) =>
	fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });

describe(`the deployment at ${origin}`, () => {
	beforeAll(async () => {
		// Only that something answers, whatever it says: the checks decide whether it is right.
		const deadline = Date.now() + REACHABLE_WITHIN_MS;
		for (;;) {
			try {
				await ask(`${origin}/login`);
				return;
			} catch (error) {
				if (Date.now() > deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 5_000));
			}
		}
	}, REACHABLE_WITHIN_MS + 30_000);

	smokeChecks(() => ({ origin, fetch: ask, sso: process.env.MAIL_SMOKE_SSO === "1" }));
});
