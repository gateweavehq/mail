import { expect, newBrowserContext, test } from "./fixtures";
import { signUp, startWorkspace, unique, waitForHydration } from "./helpers";

// Changing a name and a password on the account page. What the server refuses, and why, is in
// test/account-changes.test.ts; these show what people see of it.

test("someone changes their name", async ({ page }) => {
	const { person } = await startWorkspace(page);
	await page.goto("/settings/account");
	await waitForHydration(page);

	const save = page.getByRole("button", { name: "Save name" });
	const field = page.getByLabel("Your name");
	await expect(field).toHaveValue(person.name);
	await expect(save).toBeDisabled();

	const name = unique("Renamed");
	await field.fill(`  ${name}  `);
	await save.click();
	await expect(page.getByText("Your name is changed.")).toBeVisible();
	await expect(field).toHaveValue(name);
	await expect(save).toBeDisabled();

	await page.reload();
	await expect(page.getByLabel("Your name")).toHaveValue(name);
});

test("someone changes their password, and only this browser stays signed in", async ({
	page,
	browser,
}) => {
	const person = await signUp(page);

	const elsewhereContext = await newBrowserContext(browser);
	try {
		const elsewhere = await elsewhereContext.newPage();
		const signIn = async (password: string) => {
			await elsewhere.goto("/login");
			await waitForHydration(elsewhere);
			await elsewhere.getByLabel("Email").fill(person.email);
			await elsewhere.getByLabel("Password").fill(password);
			await elsewhere.getByRole("button", { name: "Sign in", exact: true }).click();
		};
		await signIn(person.password);
		await expect(elsewhere).not.toHaveURL(/\/login/);

		await page.goto("/settings/account");
		await waitForHydration(page);
		await page.getByRole("button", { name: "Change password" }).click();
		const newPassword = "a-new-correct-horse";
		const fill = async (current: string, again: string) => {
			await page.getByLabel("Current password").fill(current);
			await page.getByLabel("New password", { exact: true }).fill(newPassword);
			await page.getByLabel("New password again").fill(again);
			await page.getByRole("button", { name: "Save password" }).click();
		};

		// Neither of these changes anything.
		await fill(person.password, "something-else-again");
		await expect(page.getByRole("alert")).toHaveText("The new passwords do not match.");
		await fill("not-the-password", newPassword);
		await expect(page.getByRole("alert")).toHaveText("That password is not right.");
		await elsewhere.goto("/");
		await expect(elsewhere).not.toHaveURL(/\/login/);

		await fill(person.password, newPassword);
		await expect(
			page.getByText("Your password is changed, and your other devices are signed out."),
		).toBeVisible();
		await expect(page.getByLabel("Current password")).toHaveCount(0);

		await elsewhere.goto("/");
		await expect(elsewhere).toHaveURL(/\/login/);

		await page.reload();
		await expect(page).toHaveURL(/\/settings\/account/);

		// The old password opens nothing now.
		await signIn(person.password);
		await expect(elsewhere.getByRole("alert")).toBeVisible();
		await expect(elsewhere).toHaveURL(/\/login/);
		await signIn(newPassword);
		await expect(elsewhere).not.toHaveURL(/\/login/);
	} finally {
		await elsewhereContext.close();
	}
});

test("someone signs out everywhere with no password, and a copy of their cookie stops working", async ({
	page,
	context,
	browser,
}) => {
	const person = await signUp(page);

	const elsewhereContext = await newBrowserContext(browser);
	const copyContext = await newBrowserContext(browser);
	try {
		// Whoever stole this browser's cookie has the same session as this browser.
		await copyContext.addCookies(await context.cookies());
		const copy = await copyContext.newPage();
		await copy.goto("/");
		await expect(copy).not.toHaveURL(/\/login/);

		const elsewhere = await elsewhereContext.newPage();
		const signIn = async (where: typeof elsewhere) => {
			await where.goto("/login");
			await waitForHydration(where);
			await where.getByLabel("Email").fill(person.email);
			await where.getByLabel("Password").fill(person.password);
			await where.getByRole("button", { name: "Sign in", exact: true }).click();
			await expect(where).not.toHaveURL(/\/login/);
		};
		await signIn(elsewhere);

		await page.goto("/settings/account");
		await waitForHydration(page);
		await page.getByRole("button", { name: "Sign out everywhere" }).click();
		await expect(
			page.getByRole("heading", { name: "You are signed out everywhere" }),
		).toBeVisible();

		for (const device of [elsewhere, copy]) {
			await device.goto("/");
			await expect(device).toHaveURL(/\/login/);
		}

		await page.getByRole("link", { name: "Back to sign-in" }).click();
		await expect(page).toHaveURL(/\/login/);
		await signIn(page);
	} finally {
		await elsewhereContext.close();
		await copyContext.close();
	}
});
