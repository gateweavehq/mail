import { expect, test } from "./fixtures";
import { createWorkspace, signUp, waitForHydration } from "./helpers";

// The app reads this resolver from `DNS_RESOLVER_URL`, which `server.mjs` sets to the same port.
const dnsStandIn = `http://localhost:${(Number(process.env.MAIL_E2E_PORT) || 4752) + 20}`;

test("an owner proves a domain, makes a mailbox and gives it an address that can end", async ({
	page,
	request,
}) => {
	const stamp = Date.now().toString(36);
	await signUp(page);
	const { slug } = await createWorkspace(page);
	const domain = `mail-${stamp}.example.com`;

	await page.goto(`/${slug}`);
	await waitForHydration(page);
	await expect(page.getByRole("heading", { name: "No mailboxes yet" })).toBeVisible();
	await page.getByLabel("New mailbox").fill("Support");
	await page.getByRole("button", { name: "Make mailbox" }).click();
	const box = page
		.getByRole("listitem")
		.filter({ has: page.getByRole("heading", { name: "Support" }) });
	await expect(box).toBeVisible();
	await expect(box.getByRole("link", { name: "prove a domain" })).toBeVisible();

	await box.getByRole("link", { name: "prove a domain" }).click();
	await expect(page).toHaveURL(new RegExp(`/${slug}/settings/domains$`));
	await waitForHydration(page);
	await page.getByLabel("Domain name").fill(domain.toUpperCase());
	await page.getByRole("button", { name: "Add domain" }).click();
	const row = page.getByRole("listitem").filter({ hasText: domain });
	await expect(row.getByText("Waiting for proof")).toBeVisible();

	// Checking before the record exists changes nothing.
	await row.getByRole("button", { name: "Check DNS" }).click();
	await expect(row.getByRole("status")).toContainText("No matching TXT record yet");
	await expect(row.getByText("Waiting for proof")).toBeVisible();

	const proof = (await row.locator("dd").nth(1).textContent()) ?? "";
	expect(proof).toMatch(/^gateweave-mail-verification=/);
	const set = await request.post(`${dnsStandIn}/records`, {
		data: { domain, txt: [proof], mx: ["route1.mx.cloudflare.net"] },
	});
	expect(set.ok()).toBe(true);

	await row.getByRole("button", { name: "Check DNS" }).click();
	await expect(row.getByRole("status")).toContainText("Its MX records point to Cloudflare");
	await expect(row.getByText("Proved", { exact: true })).toBeVisible();
	// Folded away once proved, and still there to keep: mail from this server's mailboxes goes
	// straight to the domain only while DNS shows it.
	await expect(row.locator("dd").first()).toBeHidden();
	await row.getByText("Its TXT record").click();
	await expect(row.locator("dd").nth(1)).toHaveText(proof);

	await page.goto(`/${slug}`);
	await waitForHydration(page);
	await expect(page.getByRole("heading", { name: "No mailboxes yet" })).toBeHidden();
	await box.getByLabel("New address").fill("Help");
	await box.getByLabel("How long").selectOption({ label: "7 days" });
	await box.getByRole("button", { name: "Add address" }).click();
	await expect(box.getByText(`help@${domain}`)).toBeVisible();
	await expect(box.getByText(/^Ends /)).toBeVisible();

	// Taken, whatever case it comes in.
	await box.getByLabel("New address").fill("HELP");
	await box.getByRole("button", { name: "Add address" }).click();
	await expect(box.getByRole("alert")).toContainText("That address is taken");

	await box.getByRole("button", { name: `Remove help@${domain}` }).click();
	const confirm = page.getByRole("dialog", { name: `Remove help@${domain}?` });
	await expect(confirm).toContainText("People can use the name again straight away");
	await confirm.getByRole("button", { name: "Remove address" }).click();
	await expect(box.getByText(`help@${domain}`)).toBeHidden();

	await page.reload();
	await waitForHydration(page);
	await expect(box.getByText("No addresses yet.")).toBeVisible();
});
