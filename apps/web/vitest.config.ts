import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				// The app's pure logic, in Node. The Cloudflare and TanStack Start plugins from
				// vite.config.ts are deliberately left out.
				resolve: { tsconfigPaths: true },
				test: { name: "unit", include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] },
			},
			{
				// The built Worker in workerd (see test/mail-worker.ts). Building takes a while.
				test: {
					name: "worker",
					include: ["test/**/*.test.ts"],
					globalSetup: ["./test/global-setup.ts"],
					testTimeout: 30_000,
					hookTimeout: 60_000,
				},
			},
		],
	},
});
