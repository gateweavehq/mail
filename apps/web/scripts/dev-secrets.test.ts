import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { devSecrets, OPTIONAL_SECRETS } from "./dev-secrets";

// A setting missing from the list works once deployed and silently does nothing in `pnpm dev`.
it("lets local dev load every optional setting the Worker reads", () => {
	const declared = readFileSync(new URL("../src/server/env.d.ts", import.meta.url), "utf8");
	const optional = [...declared.matchAll(/^\s+([A-Z][A-Z0-9_]+)\?:/gm)].map((match) => match[1]);
	expect(optional).toContain("OIDC_ISSUER");
	expect(new Set(OPTIONAL_SECRETS)).toEqual(new Set(optional));
});

it("adds only the optional settings that .dev.vars sets", () => {
	expect(devSecrets(["BETTER_AUTH_SECRET"], new Set(["OIDC_ISSUER", "SOMETHING_ELSE"]))).toEqual([
		"BETTER_AUTH_SECRET",
		"OIDC_ISSUER",
	]);
});
