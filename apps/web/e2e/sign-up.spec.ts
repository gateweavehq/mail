import { expect, test } from "./fixtures";
import { signUp, startWorkspace, waitForHydration } from "./helpers";

// What every page's policy could break without any other suite noticing: `nothingRefused` in
// fixtures.ts fails any of these if a page was refused something.

test("someone signs up, starts a workspace and sees that it has no mailboxes", async ({ page }) => {
	const { name } = await startWorkspace(page);
	await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "No mailboxes yet" })).toBeVisible();
	await expect(page.getByText("it refuses all incoming mail")).toBeVisible();
});

test("the other pages of a workspace load", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const pages: [string, string][] = [
		["settings/members", "Members"],
		["settings/workspace", "Delete this workspace"],
	];
	for (const [path, heading] of pages) {
		await page.goto(`/${slug}/${path}`);
		await waitForHydration(page);
		await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
	}
});

test("someone signs out, and signs back in", async ({ page }) => {
	const person = await signUp(page);
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page).toHaveURL(/\/login/);

	await waitForHydration(page);
	await page.getByLabel("Email").fill(person.email);
	await page.getByLabel("Password").fill(person.password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
});
