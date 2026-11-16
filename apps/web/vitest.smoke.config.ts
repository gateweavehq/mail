import { defineConfig } from "vitest/config";

// The smoke tests ask a live deployment, so they are no part of `pnpm test`: see smoke/smoke.test.ts.
export default defineConfig({
	test: {
		include: ["smoke/**/*.test.ts"],
		testTimeout: 30_000,
		// A deployment that has only just gone live may need a moment at each place it answers from.
		retry: 2,
	},
});
