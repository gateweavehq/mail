import { expect, test } from "./fixtures";
import { startWorkspace, waitForHydration } from "./helpers";

// The app reads this resolver from `DNS_RESOLVER_URL`, which `server.mjs` sets to the same port.
const dnsStandIn = `http://localhost:${(Number(process.env.MAIL_E2E_PORT) || 4752) + 20}`;

test("mail that arrives at an address shows in its mailbox, and opens as text", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug } = await startWorkspace(page);
	const domain = `inbox-${Date.now().toString(36)}.example.com`;

	// The directory is set up through its API, which `directory.spec.ts` covers through the page.
	const change = async (action: object) => {
		const response = await page.request.post(`/api/directory/${slug}`, {
			headers: { origin: baseURL ?? "" },
			data: action,
		});
		expect(response.ok()).toBe(true);
	};
	const read = async () =>
		(await (await page.request.get(`/api/directory/${slug}`)).json()) as {
			domains: { id: string; proof: { value: string } | null }[];
			mailboxes: { id: string }[];
		};
	await change({ action: "add-domain", name: domain });
	const [added] = (await read()).domains;
	const set = await request.post(`${dnsStandIn}/records`, {
		data: { domain, txt: [added?.proof?.value], mx: ["route1.mx.cloudflare.net"] },
	});
	expect(set.ok()).toBe(true);
	await change({ action: "check-domain", id: added?.id });
	await change({ action: "add-mailbox", name: "Support" });
	const [box] = (await read()).mailboxes;
	await change({
		action: "add-address",
		domainId: added?.id,
		mailboxId: box?.id,
		localPart: "help",
		expiresInDays: null,
	});

	// Delivered as Email Routing would, through the local runtime's stand-in for it.
	const to = `help@${domain}`;
	const raw = [
		"From: A Customer <customer@example.org>",
		`To: ${to}`,
		"Subject: My order hasn't come",
		"Date: Sun, 08 Nov 2026 09:00:00 +0000",
		`Message-ID: <${Date.now()}@example.org>`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		"It was due on Friday.",
		"",
	].join("\r\n");
	const delivered = await request.post(
		`/cdn-cgi/local/email?from=customer@example.org&to=${encodeURIComponent(to)}`,
		{ data: raw },
	);
	expect(delivered.status()).toBe(200);

	await page.goto(`/${slug}`);
	await waitForHydration(page);
	await page.getByRole("link", { name: "Support" }).click();
	await expect(page).toHaveURL(`/${slug}/mailboxes/${box?.id}`);
	await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
	const messages = page.getByRole("list", { name: "Messages in Support" });
	await expect(messages).toBeVisible();
	await messages.getByRole("link", { name: /My order hasn't come/ }).click();

	await expect(page.getByRole("heading", { name: "My order hasn't come" })).toBeVisible();
	await expect(page.getByText("It was due on Friday.")).toBeVisible();
	await expect(page.getByText("A Customer <customer@example.org>")).toBeVisible();
	await expect(page.getByText(/Nothing proves who sent this message/)).toBeVisible();

	const download = page.waitForEvent("download");
	await page.getByRole("link", { name: /Download the original/ }).click();
	expect((await download).suggestedFilename()).toBe("message.eml");
});
