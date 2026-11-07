import { defineConfig, devices } from "@playwright/test";

// Port 4752 keeps clear of `pnpm dev` (4750). The tests run against the production build, which
// is what ships. MAIL_E2E_PORT moves them, so two checkouts can run them at once.
const PORT = Number(process.env.MAIL_E2E_PORT) || 4752;

export default defineConfig({
	testDir: "e2e",
	timeout: 60_000,
	expect: { timeout: 10_000 },
	// Tests share one server but never data: every test signs up its own user and workspace.
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "node e2e/server.mjs",
		url: `http://localhost:${PORT}/login`,
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
