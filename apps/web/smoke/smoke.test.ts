import { describe } from "vitest";
import { smokeChecks } from "./checks";

// A live deployment, from outside: `MAIL_SMOKE_URL=https://mail.example.com pnpm test:smoke`.
// Gateweave Cloud's deploy runs this after production (.github/workflows/deploy.yml). With
// `MAIL_SMOKE_SSO=1` the sign-in page must also offer an OpenID Connect provider.

const address = process.env.MAIL_SMOKE_URL;
if (!address) throw new Error("Set MAIL_SMOKE_URL to the deployment's address");
const { origin, protocol } = new URL(address);
if (protocol !== "https:") throw new Error("MAIL_SMOKE_URL must be an https address");

describe(`the deployment at ${origin}`, () => {
	smokeChecks(() => ({
		origin,
		// A redirect would be a deployment that answers somewhere else: it is the answer, not followed.
		fetch: (input, init) =>
			fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) }),
		sso: process.env.MAIL_SMOKE_SSO === "1",
	}));
});
