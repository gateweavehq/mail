import { expect, type Page } from "@playwright/test";

/** Short and unique per call, so tests never share users or workspaces. */
export function unique(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface Person {
	name: string;
	email: string;
	password: string;
}

export function newPerson(label = "user"): Person {
	const id = unique(label);
	return { name: `Test ${id}`, email: `${id}@example.test`, password: "correct-horse-battery" };
}

/**
 * Waits until React has taken over a server-rendered page. Before that, a click on a submit
 * button is a plain form submission that reloads the page and throws away what was typed.
 */
export async function waitForHydration(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const main = document.querySelector("main");
		return Boolean(main && Object.keys(main).some((key) => key.startsWith("__reactProps")));
	});
}

/**
 * Signs up on the sign-up form of `/login`. Email is off in the test setup, so there is nothing
 * to verify, and the app lands on `/`.
 */
export async function signUp(page: Page, person: Person = newPerson()): Promise<Person> {
	await page.goto("/login?mode=sign-up");
	await waitForHydration(page);
	await page.getByLabel("Name").fill(person.name);
	await page.getByLabel("Email").fill(person.email);
	await page.getByLabel("Password").fill(person.password);
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	return person;
}

/** Creates a workspace from `/` and waits for its first page. */
export async function createWorkspace(page: Page): Promise<{ name: string; slug: string }> {
	const slug = unique("ws");
	const name = `Workspace ${slug}`;
	await page.getByLabel("Name").fill(name);
	await page.getByLabel("URL").fill(slug);
	await page.getByRole("button", { name: "Create workspace" }).click();
	await expect(page).toHaveURL(new RegExp(`/${slug}(/|$)`));
	return { name, slug };
}

/** Signs up and creates a workspace: the start of most tests. */
export async function startWorkspace(page: Page) {
	const person = await signUp(page);
	const workspace = await createWorkspace(page);
	return { person, ...workspace };
}
