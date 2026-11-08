import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { startWorkspace, waitForHydration } from "./helpers";

// The app reads this resolver from `DNS_RESOLVER_URL`, which `server.mjs` sets to the same port.
const dnsStandIn = `http://localhost:${(Number(process.env.MAIL_E2E_PORT) || 4752) + 20}`;

/** A new workspace with a proved domain and a mailbox, "Support", that has an address there. */
async function supportMailbox(page: Page, request: APIRequestContext, baseURL: string | undefined) {
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
	const deliver = async (from: string, lines: string[]) => {
		const answer = await request.post(
			`/cdn-cgi/local/email?from=${from}&to=${encodeURIComponent(to)}`,
			{ data: lines.join("\r\n") },
		);
		expect(answer.status()).toBe(200);
	};
	return { slug, mailboxId: box?.id ?? "", to, deliver };
}

test("mail that arrives at an address shows in its mailbox, and opens as text", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId, to, deliver } = await supportMailbox(page, request, baseURL);
	const firstId = `<${Date.now()}@example.org>`;
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
	await expect(page).toHaveURL(`/${slug}/mailboxes/${mailboxId}`);
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
	await expect(page).toHaveURL(new RegExp(`/${slug}/mailboxes/${mailboxId}/threads/`));
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
	await expect(page).toHaveURL(`/${slug}/mailboxes/${mailboxId}`);
	await expect(threads.getByRole("link", { name: /Your order has shipped/ })).toBeVisible();
	await expect(threads.getByRole("link", { name: /My order hasn't come/ })).toHaveCount(0);
});

test("a long thread pages from its newest messages", async ({ page, request, baseURL }) => {
	const { slug, mailboxId, to, deliver } = await supportMailbox(page, request, baseURL);
	const rootId = `<${Date.now()}.root@example.org>`;
	await deliver("customer@example.org", [
		"From: A Customer <customer@example.org>",
		`To: ${to}`,
		"Subject: Long one",
		`Message-ID: ${rootId}`,
		"",
		"Where it began.",
		"",
	]);
	for (let n = 1; n <= 50; n++) {
		await deliver("desk@example.org", [
			"From: Help Desk <desk@example.org>",
			`To: ${to}`,
			"Subject: Re: Long one",
			`Message-ID: <${Date.now()}.${n}.desk@example.org>`,
			`In-Reply-To: ${rootId}`,
			"",
			`Update ${n}.`,
			"",
		]);
	}

	await page.goto(`/${slug}/mailboxes/${mailboxId}`);
	await waitForHydration(page);
	await page.getByRole("link", { name: /Long one/ }).click();
	const heading = page.getByRole("heading", { level: 1, name: "Long one" });
	await expect(heading).toBeVisible();
	await expect(page.getByText("51 messages", { exact: true })).toBeVisible();
	const thread = page.getByRole("list", { name: "Messages in this thread" });
	await expect(thread.getByRole("article")).toHaveCount(50);
	await expect(thread.getByText("Update 50.")).toBeVisible();

	await page.getByRole("link", { name: "Older messages" }).click();
	await expect(page.getByRole("link", { name: "Newest messages" })).toBeVisible();
	await expect(thread.getByRole("article")).toHaveCount(1);
	await expect(thread.getByText("Where it began.")).toBeVisible();

	// Deleting the only message of an older page goes back to the newest, not to an empty page.
	await thread.getByRole("button", { name: "Delete" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete message" }).click();
	await expect(page.getByText("50 messages", { exact: true })).toBeVisible();
	await expect(page).not.toHaveURL(/beforeId/);
	await expect(thread.getByRole("article")).toHaveCount(50);
	await expect(page.getByRole("link", { name: "Newest messages" })).toHaveCount(0);
	await expect(heading).toBeFocused();
});

test("searching a mailbox finds the threads with every word", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId, to, deliver } = await supportMailbox(page, request, baseURL);
	await deliver("customer@example.org", [
		"From: A Customer <customer@example.org>",
		`To: ${to}`,
		"Subject: Broken kettle",
		`Message-ID: <${Date.now()}.kettle@example.org>`,
		"",
		"It stopped heating after a week.",
		"",
	]);
	await deliver("orders@example.org", [
		"From: Shop <orders@example.org>",
		`To: ${to}`,
		"Subject: Your order has shipped",
		`Message-ID: <${Date.now()}.shop@example.org>`,
		"",
		"It's on its way.",
		"",
	]);
	// Mail is indexed a moment after it arrives.
	await expect
		.poll(async () => {
			const found = await page.request.get(
				`/api/mail/${slug}/${mailboxId}/threads?q=${encodeURIComponent("way")}`,
			);
			return ((await found.json()) as { threads: unknown[] }).threads.length;
		})
		.toBe(1);

	await page.goto(`/${slug}/mailboxes/${mailboxId}`);
	await waitForHydration(page);
	const box = page.getByRole("searchbox", { name: "Search Support" });
	await box.fill("heat");
	await box.press("Enter");
	await expect(page).toHaveURL(/q=heat/);
	const found = page.getByRole("list", { name: "Threads in Support that match" });
	await expect(found.getByRole("link", { name: /Broken kettle/ })).toBeVisible();
	await expect(found.getByRole("link")).toHaveCount(1);
	await expect(box).toHaveValue("heat");
	// Said to a screen reader, as the focus stays in the box.
	const said = page.getByRole("status").filter({ hasText: /match/ });
	await expect(said).toHaveText("1 thread matches “heat”.");

	await box.fill("kettle shipped");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(page.getByText(/No thread has all of those words/)).toBeVisible();
	await expect(said).toHaveText("No thread matches “kettle shipped”.");

	await page.getByRole("link", { name: "Clear" }).click();
	await expect(page).not.toHaveURL(/q=/);
	const all = page.getByRole("list", { name: "Threads in Support" });
	await expect(all.getByRole("link")).toHaveCount(2);
	await expect(box).toHaveValue("");
});
