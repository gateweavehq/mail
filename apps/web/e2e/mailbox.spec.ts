import type { APIRequestContext, Page } from "@playwright/test";
import { expect, newBrowserContext, test } from "./fixtures";
import { newPerson, signUp, startWorkspace, unique, waitForHydration } from "./helpers";

// The app reads this resolver from `DNS_RESOLVER_URL`, which `server.mjs` sets to the same port,
// and Resend's API from `RESEND_API_URL`, the port after.
const dnsStandIn = `http://localhost:${(Number(process.env.MAIL_E2E_PORT) || 4752) + 20}`;
const resendStandIn = `http://localhost:${(Number(process.env.MAIL_E2E_PORT) || 4752) + 21}`;
/** A key the Resend stand-in takes, as one that may only send. */
const RESEND_STAND_IN_KEY = "re_e2eSendingOnly_0123456789";

/** A new workspace with a proved domain and a mailbox, "Support", that has an address there. */
async function supportMailbox(page: Page, request: APIRequestContext, baseURL: string | undefined) {
	const { slug, person } = await startWorkspace(page);
	// Unique even for tests that start in the same millisecond: a domain two workspaces prove is
	// the later one's, and the first test would find it gone.
	const domain = `${unique("inbox")}.example.com`;

	// The directory is set up through its API, which `directory.spec.ts` covers through the page.
	const change = async (action: object) => {
		const response = await page.request.post(`/api/directory/${slug}`, {
			headers: { origin: baseURL ?? "" },
			data: action,
		});
		expect(response.ok(), `${JSON.stringify(action)}: ${await response.text()}`).toBe(true);
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
	return { slug, person, mailboxId: box?.id ?? "", to, domain, deliver };
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

test("a reply and a new message go from the mailbox, and their copies show in its threads", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, person, mailboxId, to, deliver } = await supportMailbox(page, request, baseURL);
	await deliver("customer@example.org", [
		"From: A Customer <customer@example.org>",
		`To: ${to}`,
		"Subject: Where is my parcel?",
		`Message-ID: <${Date.now()}.parcel@example.org>`,
		"",
		"It hasn't come.",
		"",
	]);

	await page.goto(`/${slug}/mailboxes/${mailboxId}`);
	await waitForHydration(page);
	await page.getByRole("link", { name: /Where is my parcel\?/ }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Where is my parcel?" })).toBeVisible();

	// A reply starts from the message it answers: to its sender, from the address it came to,
	// quoting it.
	await page.getByRole("button", { name: "Reply" }).click();
	const reply = page.getByRole("region", { name: "Reply" });
	await expect(reply.getByText(to, { exact: true })).toBeVisible();
	await expect(reply.getByLabel("To")).toHaveValue("customer@example.org");
	await expect(reply.getByLabel("Subject")).toHaveValue("Re: Where is my parcel?");
	const text = reply.getByLabel("Message");
	await expect(text).toHaveValue(/wrote:\n> It hasn't come\.$/);
	await text.focus();
	await text.press("Control+Home");
	await text.pressSequentially("It left on Monday.");
	await reply.getByRole("button", { name: "Send" }).click();

	// Its copy is the thread's newest message, open, and says who wrote it. The focus is back on
	// Reply.
	await expect(reply.getByRole("status")).toHaveText("Your reply is sent.");
	await expect(page.getByText("2 messages", { exact: true })).toBeVisible();
	const thread = page.getByRole("list", { name: "Messages in this thread" });
	const copy = thread.getByRole("article", { name: /Support/ });
	await expect(copy.getByText("Sent", { exact: true })).toBeVisible();
	await expect(copy.getByText(/^It left on Monday\./)).toBeVisible();
	await expect(copy.getByText(`Written in this mailbox by ${person.name}.`)).toBeVisible();
	await expect(reply.getByRole("button", { name: "Reply" })).toBeFocused();

	// A new message, written from the mailbox's page, opens its own thread once sent.
	await page.getByRole("link", { name: "Support" }).click();
	await page.getByRole("button", { name: "Write" }).click();
	const dialog = page.getByRole("dialog", { name: "New message" });
	await dialog.getByLabel("To").fill("someone@example.net");
	await dialog.getByLabel("Subject").fill("A note from support");
	await dialog.getByRole("button", { name: "Send" }).click();
	await expect(dialog.getByRole("alert")).toHaveText("Write something to send.");
	await dialog.getByLabel("Message").fill("Just saying hello.");
	await dialog.getByRole("button", { name: "Send" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "A note from support" })).toBeVisible();
	await expect(
		thread.getByRole("article", { name: /Support/ }).getByText("Sent", { exact: true }),
	).toBeVisible();
	await expect(thread.getByText("Just saying hello.")).toBeVisible();
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

test("a message's HTML shows in a frame that runs nothing and loads only what is asked for", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId, to, deliver } = await supportMailbox(page, request, baseURL);
	await deliver("news@example.org", [
		"From: Shop News <news@example.org>",
		`To: ${to}`,
		"Subject: This week's offers",
		`Message-ID: <${Date.now()}.news@example.org>`,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=utf-8",
		"",
		'<h1 style="color: teal">Offers</h1><p>Half price kettles.</p>',
		'<img src="https://images.example/logo.png" alt="Shop logo">',
		'<a href="https://shop.example/offers">See the offers</a>',
		"",
	]);
	// Stands in for the sender's server, which would learn that the message was opened.
	const asked: string[] = [];
	await page.route("https://images.example/**", (route) => {
		asked.push(route.request().url());
		return route.fulfill({ contentType: "image/png", body: Buffer.from(PIXEL, "base64") });
	});

	await page.goto(`/${slug}/mailboxes/${mailboxId}`);
	await waitForHydration(page);
	await page.getByRole("link", { name: /This week's offers/ }).click();
	const framed = page.getByTitle("The message, as its sender formatted it");
	await expect(framed).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
	const message = page.frameLocator('iframe[title="The message, as its sender formatted it"]');
	await expect(message.getByRole("heading", { name: "Offers" })).toBeVisible();
	await expect(message.getByRole("link", { name: "See the offers" })).toHaveAttribute(
		"target",
		"_blank",
	);

	// An opaque origin, so none of the app's cookies, and no script runs, even one put there later.
	const frame = await (await framed.elementHandle())?.contentFrame();
	const inside = await frame?.evaluate(() => {
		const script = document.createElement("script");
		script.textContent = "document.body.dataset.ran = 'yes'";
		document.body.append(script);
		let cookies = "";
		try {
			cookies = document.cookie;
		} catch {
			cookies = "refused";
		}
		return { origin: window.origin, ran: document.body.dataset.ran ?? "no", cookies };
	});
	expect(inside).toEqual({ origin: "null", ran: "no", cookies: "refused" });

	expect(asked).toEqual([]);
	await page.getByRole("button", { name: "Show remote images" }).click();
	await expect.poll(() => asked).toEqual(["https://images.example/logo.png"]);
	// The button says what it would do now, and keeps the focus.
	await expect(page.getByRole("button", { name: "Hide remote images" })).toBeFocused();

	// The text made from it is a click away.
	await page.getByRole("button", { name: "Show as text" }).click();
	await expect(page.getByText(/Half price kettles\./)).toBeVisible();
	await expect(framed).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Show formatted" })).toBeFocused();
	await page.getByRole("button", { name: "Show formatted" }).click();
	await expect(message.getByRole("heading", { name: "Offers" })).toBeVisible();
});

test("an owner chooses who reads a mailbox, and only they find it", async ({
	page,
	browser,
	request,
	baseURL,
}) => {
	const { slug, to, deliver } = await supportMailbox(page, request, baseURL);
	await deliver("customer@example.org", [
		"From: A Customer <customer@example.org>",
		`To: ${to}`,
		"Subject: Where is my parcel",
		"Date: Sun, 08 Nov 2026 09:00:00 +0000",
		`Message-ID: <${Date.now()}.access@example.org>`,
		"",
		"Still waiting.",
		"",
	]);

	// Someone joins as a member, through an invite link.
	const reader = newPerson("reader");
	await page.goto(`/${slug}/settings/members`);
	await waitForHydration(page);
	await page.getByLabel("Email address").fill(reader.email);
	await page.getByRole("button", { name: "Create invite link" }).click();
	const link = await page.getByLabel("Invite link").inputValue();

	const context = await newBrowserContext(browser);
	const theirs = await context.newPage();
	await signUp(theirs, reader);
	await theirs.goto(link);
	await waitForHydration(theirs);
	await theirs.getByRole("button", { name: /^Join / }).click();
	await expect(theirs).toHaveURL(new RegExp(`/${slug}$`));
	await expect(theirs.getByRole("heading", { name: "No mailboxes you can read" })).toBeVisible();
	await expect(theirs.getByRole("link", { name: "Support" })).toHaveCount(0);

	// A new mailbox is for owners and admins until someone says otherwise.
	await page.goto(`/${slug}`);
	await waitForHydration(page);
	const card = page
		.getByRole("listitem")
		.filter({ has: page.getByRole("heading", { name: "Support" }) });
	await expect(card.getByText("Only owners and admins can read it.")).toBeVisible();
	await card.getByRole("button", { name: "Choose who can read Support" }).click();
	const dialog = page.getByRole("dialog", { name: "Who can read Support" });
	await dialog.getByLabel(reader.name).check();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	await expect(card.getByText("Owners, admins and 1 other person can read it.")).toBeVisible();

	await theirs.reload();
	await theirs.getByRole("link", { name: "Support" }).click();
	await expect(theirs.getByText("Where is my parcel")).toBeVisible();

	// Opened to everyone, nobody needs a grant of their own, so closing it again leaves none.
	await card.getByRole("button", { name: "Choose who can read Support" }).click();
	await dialog.getByLabel("Everyone in the workspace").check();
	await expect(dialog.getByLabel(reader.name)).toBeDisabled();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(card.getByText("Everyone in the workspace can read it.")).toBeVisible();
	await card.getByRole("button", { name: "Choose who can read Support" }).click();
	await dialog.getByLabel("Everyone in the workspace").uncheck();
	await expect(dialog.getByLabel(reader.name)).not.toBeChecked();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(card.getByText("Only owners and admins can read it.")).toBeVisible();
	await theirs.reload();
	await expect(theirs.getByText("Where is my parcel")).toHaveCount(0);
	await context.close();
});

test("an admin makes an agent, gives it a mailbox, and its key reads the mail until revoked", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId, to, deliver } = await supportMailbox(page, request, baseURL);
	await deliver("customer@example.org", [
		"From: A Customer <customer@example.org>",
		`To: ${to}`,
		"Subject: Sort me",
		"Date: Sun, 08 Nov 2026 09:00:00 +0000",
		`Message-ID: <${Date.now()}.agent@example.org>`,
		"",
		"Which queue am I in?",
		"",
	]);

	await page.goto(`/${slug}/settings/agents`);
	await waitForHydration(page);
	await page.getByLabel("Agent name").fill("Sorter");
	await page.getByRole("button", { name: "Create agent" }).click();
	const key = await page.getByLabel("Agent key").inputValue();
	expect(key).toMatch(/^gwm_/);
	// The MCP server the page names takes the key.
	const mcpUrl = new URL("/mcp", page.url()).href;
	await expect(
		page.getByText(
			`claude mcp add --transport http gateweave-mail ${mcpUrl} --header "Authorization: Bearer ${key}"`,
		),
	).toBeVisible();
	const started = await request.post(mcpUrl, {
		headers: { authorization: `Bearer ${key}`, accept: "application/json, text/event-stream" },
		data: {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "e2e", version: "1.0.0" },
			},
		},
	});
	expect(started.status()).toBe(200);
	await page.getByRole("button", { name: "Done" }).click();
	// The API, as the agent calls it: its key and nothing else, no cookie.
	const api = () =>
		request.get(`/api/mail/${slug}/${mailboxId}`, { headers: { authorization: `Bearer ${key}` } });
	expect((await api()).status()).toBe(404);

	// It has a page of its own, not a place among the people.
	await page.goto(`/${slug}/settings/members`);
	await waitForHydration(page);
	await expect(page.getByText("Sorter")).toHaveCount(0);

	// Opening the mailbox to everyone doesn't open it to the agent; ticking the agent does.
	await page.goto(`/${slug}`);
	await waitForHydration(page);
	const card = page
		.getByRole("listitem")
		.filter({ has: page.getByRole("heading", { name: "Support" }) });
	await card.getByRole("button", { name: "Choose who can read Support" }).click();
	const dialog = page.getByRole("dialog", { name: "Who can read Support" });
	await dialog.getByLabel("Everyone in the workspace").check();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(card.getByText("Everyone in the workspace can read it.")).toBeVisible();
	expect((await api()).status()).toBe(404);

	await card.getByRole("button", { name: "Choose who can read Support" }).click();
	await expect(dialog.getByLabel("Sorter", { exact: true })).toBeEnabled();
	await dialog.getByLabel("Sorter", { exact: true }).check();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(card.getByText("Everyone in the workspace can read it, and 1 agent.")).toBeVisible();
	const listed = await api();
	expect(listed.status()).toBe(200);
	const page1 = (await listed.json()) as { messages: { subject: string }[] };
	expect(page1.messages.map((message) => message.subject)).toEqual(["Sort me"]);

	// Revoked, its key reads nothing.
	await page.goto(`/${slug}/settings/agents`);
	await waitForHydration(page);
	await page.getByRole("button", { name: /^Revoke key / }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
	await expect(page.getByText("No keys. It can't read anything until you make one.")).toBeVisible();
	expect((await api()).status()).toBe(404);
});

test("an agent's mail to someone its settings don't name waits until a person approves it", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, person, mailboxId } = await supportMailbox(page, request, baseURL);

	await page.goto(`/${slug}/settings/agents`);
	await waitForHydration(page);
	await page.getByLabel("Agent name").fill("Sorter");
	await page.getByRole("button", { name: "Create agent" }).click();
	const key = await page.getByLabel("Agent key").inputValue();
	await page.getByRole("button", { name: "Done" }).click();
	await expect(
		page.getByText("Writes up to 20 messages a day, each waiting for approval."),
	).toBeVisible();

	// An admin lets it mail a partner's domain on its own, and fewer a day.
	await page.getByRole("button", { name: "More for Sorter" }).click();
	await page.getByRole("menuitem", { name: "Sending" }).click();
	const policy = page.getByRole("dialog", { name: "What Sorter can send" });
	await policy.getByLabel("Messages a day").fill("5");
	await policy.getByLabel("Goes without approval to").fill("@Partner.example");
	await policy.getByRole("button", { name: "Save" }).click();
	await expect(policy).toBeHidden();
	await expect(
		page.getByText(
			"Writes up to 5 messages a day. To @partner.example it goes on its own; anything else waits for approval.",
		),
	).toBeVisible();

	// The mailbox lets it send as well as read.
	await page.goto(`/${slug}`);
	await waitForHydration(page);
	const card = page
		.getByRole("listitem")
		.filter({ has: page.getByRole("heading", { name: "Support" }) });
	await card.getByRole("button", { name: "Choose who can read Support" }).click();
	const access = page.getByRole("dialog", { name: "Who can read Support" });
	await expect(access.getByLabel("Sorter can send")).toBeDisabled();
	await access.getByLabel("Sorter", { exact: true }).check();
	await access.getByLabel("Sorter can send").check();
	await access.getByRole("button", { name: "Save" }).click();
	await expect(
		card.getByText("Owners, admins and 1 agent can read it. 1 agent can send from it too."),
	).toBeVisible();

	// It writes, with its key, to a customer, which waits.
	const written = await request.post(`/api/mail/${slug}/${mailboxId}/outbox`, {
		headers: { authorization: `Bearer ${key}` },
		data: {
			action: "send",
			draft: crypto.randomUUID(),
			to: ["customer@example.org"],
			subject: "Your parcel",
			text: "It left on Monday.",
		},
	});
	expect(written.status()).toBe(200);
	expect(await written.json()).toMatchObject({ state: "held" });

	// The mailbox's page says what waits, and a person approves it from its thread.
	await page.goto(`/${slug}/mailboxes/${mailboxId}`);
	await waitForHydration(page);
	const waiting = page.getByRole("region", { name: "1 message waits for approval" });
	await expect(waiting.getByText("Sorter")).toBeVisible();
	await waiting.getByRole("link", { name: "Your parcel" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "Your parcel" })).toBeVisible();
	const thread = page.getByRole("list", { name: "Messages in this thread" });
	const copy = thread.getByRole("article", { name: /Support/ });
	await expect(copy.getByText("Waiting for approval", { exact: true })).toBeVisible();
	await copy.getByRole("button", { name: "Approve and send" }).click();
	await expect(copy.getByText("Sent", { exact: true })).toBeVisible();
	await expect(
		copy.getByText(`Written in this mailbox by Sorter, approved by ${person.name}.`),
	).toBeVisible();

	// The page may first show what it had, waiting list and all, while it asks again; the thread's
	// row is there either way, and the waiting list goes once the new answer is in.
	await page.getByRole("link", { name: "Support" }).click();
	await expect(page.getByRole("link", { name: /^Support Your parcel/ })).toBeVisible();
	await expect(
		page.getByRole("region", { name: /wait for approval|waits for approval/ }),
	).toHaveCount(0);
});

/** Long enough that, on a phone, it has to give way to the rest of an address's row. */
const SORTER = "Sorter for the shop's sign-ups";

test("an admin lets an agent make addresses, and the workspace's page says which it made", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId, domain } = await supportMailbox(page, request, baseURL);

	await page.goto(`/${slug}/settings/agents`);
	await waitForHydration(page);
	await page.getByLabel("Agent name").fill(SORTER);
	await page.getByRole("button", { name: "Create agent" }).click();
	const key = await page.getByLabel("Agent key").inputValue();
	await page.getByRole("button", { name: "Done" }).click();
	await expect(page.getByText("Can't make addresses.")).toBeVisible();

	// An admin lets it hold a few, for two weeks each, on the workspace's domain.
	await page.getByRole("button", { name: `More for ${SORTER}` }).click();
	await page.getByRole("menuitem", { name: "Addresses" }).click();
	const limits = page.getByRole("dialog", { name: `Addresses ${SORTER} can make` });
	await limits.getByLabel("How many at once").fill("3");
	await limits.getByLabel("Each lasts at most, in days").fill("14");
	await limits.getByLabel(domain).check();
	await limits.getByRole("button", { name: "Save" }).click();
	await expect(limits).toBeHidden();
	await expect(
		page.getByText(`Makes up to 3 addresses at once on ${domain}, each lasting up to 14 days.`),
	).toBeVisible();

	// The mailbox lets it send, which an address of its own needs.
	await page.goto(`/${slug}`);
	await waitForHydration(page);
	const card = page
		.getByRole("listitem")
		.filter({ has: page.getByRole("heading", { name: "Support" }) });
	await card.getByRole("button", { name: "Choose who can read Support" }).click();
	const access = page.getByRole("dialog", { name: "Who can read Support" });
	await access.getByLabel(SORTER, { exact: true }).check();
	await access.getByLabel(`${SORTER} can send`).check();
	await access.getByRole("button", { name: "Save" }).click();
	await expect(access).toBeHidden();

	// It makes one with its key, for a sign-up, and mail to it arrives.
	const made = await request.post(`/api/mail/${slug}/${mailboxId}/addresses`, {
		headers: { authorization: `Bearer ${key}` },
		data: { action: "make", domain, localPart: "signup-1" },
	});
	expect(made.status(), await made.text()).toBe(200);
	const address = `signup-1@${domain}`;
	expect(await made.json()).toMatchObject({ ok: true, address: { address } });
	const delivered = await request.post(
		`/cdn-cgi/local/email?from=shop@example.org&to=${encodeURIComponent(address)}`,
		{
			data: [
				"From: A Shop <shop@example.org>",
				`To: ${address}`,
				"Subject: Confirm your account",
				"Date: Mon, 09 Nov 2026 09:00:00 +0000",
				`Message-ID: <${Date.now()}.signup@example.org>`,
				"",
				"Click to confirm.",
				"",
			].join("\r\n"),
		},
	);
	expect(delivered.status()).toBe(200);

	// The workspace's page lists it with who made it, and when it ends.
	await page.reload();
	await waitForHydration(page);
	const listed = card
		.getByRole("list", { name: "Addresses of Support" })
		.getByRole("listitem")
		.filter({
			hasText: address,
		});
	await expect(listed.getByText(`Made by ${SORTER}`)).toBeVisible();
	await expect(listed.getByRole("button", { name: `Remove ${address}` })).toBeVisible();
	// On a phone the agent's name gives way, and when it ends stays on one line.
	await page.setViewportSize({ width: 390, height: 844 });
	const ends = listed.getByText(/^Ends /);
	const lineHeight = await ends.evaluate((element) =>
		Number.parseFloat(getComputedStyle(element).lineHeight),
	);
	expect((await ends.boundingBox())?.height).toBeLessThan(lineHeight * 1.5);
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto(`/${slug}/settings/agents`);
	await waitForHydration(page);
	await expect(page.getByText("Holds 1 now.", { exact: false })).toBeVisible();
});

/** A one-pixel PNG. */
const PIXEL =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("an admin adds the workspace's Resend key, and a domain set to Resend sends through it", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId, domain } = await supportMailbox(page, request, baseURL);
	await page.goto(`/${slug}/settings/domains`);
	await waitForHydration(page);
	const row = page.getByRole("listitem").filter({ hasText: domain });
	const sendsWith = row.getByLabel("Sends with");
	await expect(sendsWith).toHaveValue("cloudflare");
	await expect(sendsWith.getByRole("option", { name: "Resend (add a key first)" })).toBeDisabled();

	await page.getByLabel("Resend key").fill("re_notOneResendKnows_1234");
	await page.getByRole("button", { name: "Add key" }).click();
	await expect(page.getByRole("alert")).toContainText("Resend doesn't take this key");
	await page.getByLabel("Resend key").fill(RESEND_STAND_IN_KEY);
	await page.getByRole("button", { name: "Add key" }).click();
	await expect(page.getByRole("status")).toContainText("It can only send");
	await expect(page.getByText(`re_…${RESEND_STAND_IN_KEY.slice(-4)}`)).toBeVisible();
	await expect(page.getByLabel("Resend key")).toHaveCount(0);

	await sendsWith.selectOption("resend");
	await expect(sendsWith).toHaveValue("resend");
	// It sends, but a key that can only send can't make the webhook that tells what became of it.
	await expect(row.getByRole("alert")).toContainText(
		"can't learn what became of mail sent through Resend",
	);
	await page.reload();
	await waitForHydration(page);
	await expect(row.getByLabel("Sends with")).toHaveValue("resend");

	const subject = `Through Resend ${unique("note")}`;
	await page.goto(`/${slug}/mailboxes/${mailboxId}`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "Write" }).click();
	const dialog = page.getByRole("dialog", { name: "New message" });
	await dialog.getByLabel("To").fill("someone@example.net");
	await dialog.getByLabel("Subject").fill(subject);
	await dialog.getByLabel("Message").fill("Sent by Resend.");
	await dialog.getByRole("button", { name: "Send" }).click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	const thread = page.getByRole("list", { name: "Messages in this thread" });
	await expect(
		thread.getByRole("article", { name: /Support/ }).getByText("Sent", { exact: true }),
	).toBeVisible();

	const sent = (await (await request.get(`${resendStandIn}/sent`)).json()) as {
		from: string;
		to: string[];
		subject: string;
		text: string;
	}[];
	expect(sent.filter((one) => one.subject === subject)).toEqual([
		expect.objectContaining({
			from: `Support <help@${domain}>`,
			to: ["someone@example.net"],
			text: "Sent by Resend.",
		}),
	]);
});
