import { type Browser, type BrowserContext, test as base, expect } from "@playwright/test";

/**
 * Better Auth limits sign-ups and sign-ins to a few per 10 seconds per client address, and
 * identifies the client by Cloudflare's `cf-connecting-ip` header. Every request in a local run
 * comes from one address, so tests that sign up in parallel would be throttled (429). Each
 * browser context therefore presents itself as a different client, as real people would.
 */
function clientHeaders(): Record<string, string> {
	const octet = () => Math.floor(Math.random() * 256);
	return { "cf-connecting-ip": `10.${octet()}.${octet()}.${1 + (octet() % 254)}` };
}

export const test = base.extend<{ nothingRefused: undefined }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the pattern to see that no fixture is used
	extraHTTPHeaders: async ({}, use) => {
		await use(clientHeaders());
	},
	// A script a page's policy blocks leaves a page that can look right and do nothing, and the Worker
	// tests see the same HTML either way. So in every test here, a refusal is a failure.
	nothingRefused: [
		async ({ context }, use) => {
			const refused: string[] = [];
			context.on("console", (message) => {
				if (message.text().includes("Content Security Policy")) refused.push(message.text());
			});
			await use(undefined);
			expect(refused).toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };

/** A second, separate browser: its own storage, cookies and client address. */
export function newBrowserContext(browser: Browser): Promise<BrowserContext> {
	return browser.newContext({ extraHTTPHeaders: clientHeaders() });
}
