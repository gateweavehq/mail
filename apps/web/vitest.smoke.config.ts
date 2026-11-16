import { defineConfig } from "vitest/config";

// The smoke tests ask a live deployment, so they are no part of `pnpm test`: see smoke/smoke.test.ts,
// which waits for a new deployment to settle itself. Nothing is tried again after that: a check
// that fails once on a settled deployment is a failure.
export default defineConfig({
	test: {
		include: ["smoke/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
