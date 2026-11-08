import { expect, test } from "./fixtures";
import { startWorkspace, waitForHydration } from "./helpers";

// The suppression list in Settings. Only Email Service's delivery events fill it, through the
// queue, which a preview has no way to publish to, so the list the page loads is answered here;
// the Worker tests cover how events fill it. Removing goes to the real server.

const HOUR = 60 * 60 * 1000;

test("an owner sees which addresses mailboxes won't send to, and removes one", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/suppressions`);
	await waitForHydration(page);
	await expect(page.getByRole("heading", { name: "Suppressions" })).toBeVisible();
	await expect(page.getByText("No address is suppressed.")).toBeVisible();

	const now = Date.now();
	const entry = (address: string, reason: string, expiresAt: number | null, at: number) => ({
		id: crypto.randomUUID(),
		address,
		reason,
		provider: "cloudflare",
		detail:
			reason === "bounced"
				? "550 5.1.1 The email account that you tried to reach does not exist"
				: null,
		firstAt: at,
		lastAt: at,
		expiresAt,
	});
	const first = entry("ada@example.org", "complained", null, now - HOUR);
	const second = entry("grace@example.org", "bounced", now + 7 * 24 * HOUR, now - 2 * HOUR);
	const asked: string[] = [];
	await page.route(
		(url) => url.pathname === `/api/suppressions/${slug}`,
		(route) => {
			if (route.request().method() !== "GET") return route.continue();
			const url = new URL(route.request().url());
			asked.push(url.search);
			const query = url.searchParams.get("q");
			const body = query
				? { suppressions: [second].filter(({ address }) => address.includes(query)), next: null }
				: url.searchParams.get("before")
					? { suppressions: [second], next: null }
					: { suppressions: [first], next: `${first.lastAt}:${first.id}` };
			return route.fulfill({ json: body });
		},
	);
	await page.reload();
	await waitForHydration(page);
	const list = page.getByRole("list", { name: "Suppressions" });
	const ada = list.getByRole("listitem").filter({ hasText: "ada@example.org" });
	await expect(ada.getByText("Marked as spam")).toBeVisible();
	await expect(ada.getByText(/Until it is removed\./)).toBeVisible();

	await page.getByRole("button", { name: "Show more" }).click();
	const grace = list.getByRole("listitem").filter({ hasText: "grace@example.org" });
	await expect(grace.getByText(/^Bounced ·/)).toBeVisible();
	await expect(grace.getByText(/does not exist/)).toBeVisible();
	await expect(page.getByRole("button", { name: "Show more" })).toBeHidden();
	expect(asked).toEqual(["", `?before=${encodeURIComponent(`${first.lastAt}:${first.id}`)}`]);

	await page.getByLabel("Address").fill("grace");
	await page.getByRole("button", { name: "Search" }).click();
	await expect(list.getByRole("listitem")).toHaveCount(1);
	await expect(grace).toBeVisible();

	// The server no longer has it (it never had, here), which the page takes as removed too.
	await grace.getByRole("button", { name: "Remove" }).click();
	const dialog = page.getByRole("dialog", { name: "Remove grace@example.org?" });
	await expect(dialog).toContainText("Email Service keeps a list of its own");
	await dialog.getByRole("button", { name: "Remove" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("No suppressed address matches.")).toBeVisible();
});

test("the list fits a phone", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 720 });
	const { slug } = await startWorkspace(page);
	const address = `a.very.long.address.that.has.to.wrap.somewhere@${"sub.".repeat(6)}example.org`;
	await page.route(
		(url) => url.pathname === `/api/suppressions/${slug}`,
		(route) =>
			route.fulfill({
				json: {
					suppressions: [
						{
							id: crypto.randomUUID(),
							address,
							reason: "rejected",
							provider: "cloudflare",
							detail: "Recipient is suppressed",
							firstAt: Date.now() - HOUR,
							lastAt: Date.now(),
							expiresAt: Date.now() + 7 * 24 * HOUR,
						},
					],
					next: null,
				},
			}),
	);
	await page.goto(`/${slug}/settings/suppressions`);
	await waitForHydration(page);
	await expect(page.getByText(address)).toBeVisible();
	await expect(page.getByText("On the provider's list")).toBeVisible();
	const scrolls = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
	);
	expect(scrolls).toBe(false);
});
