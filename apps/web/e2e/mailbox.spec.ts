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
	const firstId = `<${Date.now()}@example.org>`;
	const deliver = async (from: string, lines: string[]) => {
		const answer = await request.post(
			`/cdn-cgi/local/email?from=${from}&to=${encodeURIComponent(to)}`,
			{ data: lines.join("\r\n") },
		);
		expect(answer.status()).toBe(200);
	};
	const raw = [
		"From: A Customer <customer@example.org>",
		`To: ${to}`,
		"Subject: My order hasn't come",
		"Date: Sun, 08 Nov 2026 09:00:00 +0000",
		`Message-ID: ${firstId}`,
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

	// One whose sender Cloudflare proved, with the headers Email Routing puts above it.
	const proved = [
		"Received: from mail.example.org (mail.example.org [192.0.2.1]) by cloudflare-email.net (unknown) id A for <x@example.com>",
		"Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.org; dmarc=pass header.from=example.org; spf=pass",
		"From: Shop <orders@example.org>",
		`To: ${to}`,
		"Subject: Your order has shipped",
		"Date: Sun, 08 Nov 2026 10:00:00 +0000",
		`Message-ID: <${Date.now()}.shop@example.org>`,
		"",
		"It's on its way.",
		"",
	].join("\r\n");
	const second = await request.post(
		`/cdn-cgi/local/email?from=orders@example.org&to=${encodeURIComponent(to)}`,
		{ data: proved },
	);
	expect(second.status()).toBe(200);

	// A reply to the first, which joins its thread.
	await deliver("desk@example.org", [
		"From: Help Desk <desk@example.org>",
		`To: ${to}`,
		"Subject: Re: My order hasn't come",
		"Date: Sun, 08 Nov 2026 11:00:00 +0000",
		`Message-ID: <${Date.now()}.desk@example.org>`,
		`In-Reply-To: ${firstId}`,
		`References: ${firstId}`,
		"",
		"We're looking into it.",
		"",
	]);

	await page.goto(`/${slug}`);
	await waitForHydration(page);
	await page.getByRole("link", { name: "Support" }).click();
	await expect(page).toHaveURL(`/${slug}/mailboxes/${box?.id}`);
	await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
	const threads = page.getByRole("list", { name: "Threads in Support" });
	await expect(threads).toBeVisible();
	// The proved domain shows beside the mark, as the name in front of an address proves nothing.
	await expect(
		threads.getByRole("link", { name: /Your order has shipped.*Sent from example\.org/ }),
	).toBeVisible();
	await threads
		.getByRole("link", { name: /A Customer, Help Desk \(2 messages\) My order hasn't come/ })
		.click();

	// The thread, oldest first, with the newest message open.
	await expect(page).toHaveURL(new RegExp(`/${slug}/mailboxes/${box?.id}/threads/`));
	await expect(page.getByRole("heading", { level: 1, name: "My order hasn't come" })).toBeVisible();
	const thread = page.getByRole("list", { name: "Messages in this thread" });
	const first = thread.getByRole("article", { name: /A Customer/ });
	const reply = thread.getByRole("article", { name: /Help Desk/ });
	await expect(reply.getByText("We're looking into it.")).toBeVisible();
	await expect(first.getByText("It was due on Friday.")).toHaveCount(0);

	await first.getByRole("button", { name: /A Customer/ }).click();
	await expect(first.getByText("It was due on Friday.")).toBeVisible();
	await expect(first.getByText("A Customer <customer@example.org>")).toBeVisible();
	await expect(first.getByText(/Nothing proves who sent this message/)).toBeVisible();

	const download = page.waitForEvent("download");
	await first.getByRole("link", { name: /Download the original/ }).click();
	expect((await download).suggestedFilename()).toBe("message.eml");
	await first.getByRole("button", { name: /A Customer/ }).click();
	await expect(first.getByText("It was due on Friday.")).toHaveCount(0);

	// The owner can delete a message, after saying so, and the thread keeps the rest. The message
	// that is newest now opens, and the focus goes to the thread's heading.
	await reply.getByRole("button", { name: "Delete" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete message" }).click();
	await expect(reply).toHaveCount(0);
	await expect(page.getByText("1 message", { exact: true })).toBeVisible();
	await expect(first.getByText("It was due on Friday.")).toBeVisible();
	await expect(page.getByRole("heading", { level: 1, name: "My order hasn't come" })).toBeFocused();

	// Deleting its last message takes the thread with it, back to the mailbox.
	await first.getByRole("button", { name: "Delete" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete message" }).click();
	await expect(page).toHaveURL(`/${slug}/mailboxes/${box?.id}`);
	await expect(threads.getByRole("link", { name: /Your order has shipped/ })).toBeVisible();
	await expect(threads.getByRole("link", { name: /My order hasn't come/ })).toHaveCount(0);
});
