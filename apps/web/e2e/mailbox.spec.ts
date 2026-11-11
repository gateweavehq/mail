import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
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
	// Its quote goes as one, in HTML beside the text as it was written.
	const replied = copy.frameLocator('iframe[title="The message, as its sender formatted it"]');
	await expect(replied.getByText(/^It left on Monday\./)).toBeVisible();
	await expect(replied.locator("blockquote")).toHaveText("It hasn't come.");
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
	// Without formatting it goes as text alone.
	await expect(thread.getByRole("button", { name: "Show as text" })).toHaveCount(0);
});

test("a message's formatting and files go with it, and its copy shows them", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId } = await supportMailbox(page, request, baseURL);
	await page.goto(`/${slug}/mailboxes/${mailboxId}`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "Write" }).click();
	const dialog = page.getByRole("dialog", { name: "New message" });
	await dialog.getByLabel("To").fill("someone@example.net");
	await dialog.getByLabel("Subject").fill("The plan");

	// The toolbar marks what is selected, as something typed that can be undone; its keys do too.
	const text = dialog.getByLabel("Message");
	const select = (from: number, to: number) =>
		text.evaluate(
			(field: HTMLTextAreaElement, range) => field.setSelectionRange(range.from, range.to),
			{ from, to },
		);
	await text.fill("Read this first");
	await select(5, 9);
	await dialog.getByRole("button", { name: "Bold" }).click();
	await expect(text).toHaveValue("Read **this** first");
	await text.press("Control+z");
	await expect(text).toHaveValue("Read this first");
	await select(5, 9);
	await text.press("Control+b");
	await expect(text).toHaveValue("Read **this** first");
	await text.press("End");
	await text.pressSequentially(" and ");
	await text.press("Control+i");
	await text.pressSequentially("soon");
	// The caret is still inside the marks.
	await text.press("End");
	await text.press("Enter");
	await text.pressSequentially("one");
	await dialog.getByRole("button", { name: "Bulleted list" }).click();
	await expect(text).toHaveValue("Read **this** first and *soon*\n- one");
	// The caret stays where it was in its line, and a new line takes the mark before its words.
	await text.pressSequentially("!");
	await text.press("Enter");
	await dialog.getByRole("button", { name: "Bulleted list" }).click();
	await text.pressSequentially("two");
	await text.press("Enter");
	await text.pressSequentially(`[home](${baseURL}/)`);
	await expect(text).toHaveValue(
		`Read **this** first and *soon*\n- one!\n- two\n[home](${baseURL}/)`,
	);

	// The preview shows it formatted, and nothing changes it there.
	await dialog.getByRole("button", { name: "Preview" }).click();
	const preview = dialog.getByRole("region", { name: "Preview" });
	await expect(preview.locator("strong")).toHaveText("this");
	await expect(preview.locator("em")).toHaveText("soon");
	await expect(preview.getByRole("listitem")).toHaveText(["one!", "two"]);
	await expect(dialog.getByRole("button", { name: "Bold" })).toBeDisabled();
	// A link there opens in a tab of its own, and what is being written stays.
	const opened = page.context().waitForEvent("page");
	await preview.getByRole("link", { name: "home" }).click();
	await (await opened).close();
	await expect(preview).toBeVisible();
	await dialog.getByRole("button", { name: "Preview" }).click();
	await expect(text).toBeVisible();

	// A kind of file Mail doesn't send is refused as it is added.
	const files = dialog.locator('input[type="file"]');
	await files.setInputFiles({
		name: "setup.exe",
		mimeType: "application/x-msdownload",
		buffer: Buffer.from("MZ"),
	});
	await expect(dialog.getByRole("alert")).toHaveText(
		"Mail doesn't send .exe files, which many mail servers refuse.",
	);
	await files.setInputFiles([
		{ name: "plan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") },
		{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Bring snacks.\n") },
	]);
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	const list = dialog.getByRole("list", { name: "Files" });
	await expect(list.getByRole("listitem")).toHaveCount(2);
	await list.getByRole("button", { name: "Remove notes.txt" }).click();
	await expect(list.getByRole("listitem")).toHaveText([/plan\.pdf/]);
	await expect(dialog.getByRole("button", { name: "Attach files" })).toBeFocused();

	// Its copy shows the HTML that went, the file, and the text as it was written.
	await dialog.getByRole("button", { name: "Send" }).click();
	await expect(page.getByRole("heading", { level: 1, name: "The plan" })).toBeVisible();
	const copy = page
		.getByRole("list", { name: "Messages in this thread" })
		.getByRole("article", { name: /Support/ });
	await expect(copy.getByText("Sent", { exact: true })).toBeVisible();
	const message = copy.frameLocator('iframe[title="The message, as its sender formatted it"]');
	await expect(message.locator("strong")).toHaveText("this");
	await expect(message.locator("li")).toHaveText(["one!", "two"]);
	const attachments = copy.getByRole("region", { name: "Attachments" });
	await expect(attachments.getByRole("listitem")).toHaveText([/plan\.pdf/]);
	// The file downloads by itself, as it went, and the page stays where it was.
	const saved = page.waitForEvent("download");
	await attachments.getByRole("link", { name: "plan.pdf" }).click();
	const file = await saved;
	expect(file.suggestedFilename()).toBe("plan.pdf");
	const path = await file.path();
	expect(readFileSync(path, "utf8")).toBe("%PDF-1.4\n%%EOF\n");
	await expect(page.getByRole("heading", { level: 1, name: "The plan" })).toBeVisible();
	await copy.getByRole("button", { name: "Show as text" }).click();
	await expect(copy.getByText("Read **this** first and *soon*")).toBeVisible();
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

test("a reader lets a proved sender's images show by themselves, and takes it back", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId, to, deliver } = await supportMailbox(page, request, baseURL);
	const offer = (subject: string, proved: boolean) => [
		...(proved ? PROVED : []),
		"From: Shop News <news@example.org>",
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: <${unique("offer")}@example.org>`,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=utf-8",
		"",
		`<h1>${subject}</h1><img src="https://images.example/logo.png" alt="Shop logo">`,
		"",
	];
	await deliver("news@example.org", offer("Kettles", true));
	// Stands in for the sender's server, which learns each time the message is opened.
	let asked = 0;
	await page.route("https://images.example/**", (route) => {
		asked++;
		return route.fulfill({ contentType: "image/png", body: Buffer.from(PIXEL, "base64") });
	});
	const message = page.frameLocator('iframe[title="The message, as its sender formatted it"]');
	const openOffer = async (subject: string) => {
		await page.goto(`/${slug}/mailboxes/${mailboxId}`);
		await waitForHydration(page);
		await page.getByRole("link", { name: new RegExp(subject) }).click();
		await expect(message.getByRole("heading", { name: subject })).toBeVisible();
	};

	await openOffer("Kettles");
	expect(asked).toBe(0);
	await page.getByRole("button", { name: "Always show images from example.org" }).click();
	await expect.poll(() => asked).toBe(1);
	await expect(
		page.getByText(/Images show by themselves for any mail proved to come from example.org/),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Stop showing images from example.org" }),
	).toBeFocused();

	// The next one from the domain shows them without asking.
	await deliver("news@example.org", offer("Toasters", true));
	await openOffer("Toasters");
	await expect.poll(() => asked).toBe(2);

	// One that only says it is from there doesn't, and can't be the reason to allow it.
	await deliver("news@example.org", offer("Forged", false));
	await openOffer("Forged");
	await expect(page.getByRole("button", { name: "Show remote images" })).toBeVisible();
	await expect(page.getByRole("button", { name: /Always show images/ })).toHaveCount(0);
	expect(asked).toBe(2);

	// The settings list what was allowed, and take it back.
	await page.goto(`/${slug}/settings/images`);
	await waitForHydration(page);
	const list = page.getByRole("list", { name: "Domains whose images show" });
	await expect(list.getByText("example.org")).toBeVisible();
	await list.getByRole("button", { name: "Stop showing images from example.org" }).click();
	await expect(page.getByText(/None yet/)).toBeVisible();
	await expect(page.getByRole("status")).toHaveText(
		"Images from example.org no longer show by themselves.",
	);
	// Its button went with it, so the focus is on what stays.
	await expect(page.getByRole("heading", { name: "Images" })).toBeFocused();

	await openOffer("Toasters");
	await expect(
		page.getByRole("button", { name: "Always show images from example.org" }),
	).toBeVisible();
	expect(asked).toBe(2);
});

test("a choice about a sender's images reaches a thread's older messages at once", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId, to, deliver } = await supportMailbox(page, request, baseURL);
	const firstId = `<${unique("deal")}@example.org>`;
	const deal = (subject: string, heading: string, more: string[]) => [
		...PROVED,
		"From: Shop News <news@example.org>",
		`To: ${to}`,
		`Subject: ${subject}`,
		...more,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=utf-8",
		"",
		`<h1>${heading}</h1><img src="https://images.example/logo.png" alt="Shop logo">`,
		"",
	];
	await deliver(
		"news@example.org",
		deal("Kettle deal", "First deal", [
			"Date: Sun, 08 Nov 2026 09:00:00 +0000",
			`Message-ID: ${firstId}`,
		]),
	);
	await deliver(
		"news@example.org",
		deal("Re: Kettle deal", "Second deal", [
			"Date: Sun, 08 Nov 2026 10:00:00 +0000",
			`Message-ID: <${unique("deal")}@example.org>`,
			`In-Reply-To: ${firstId}`,
			`References: ${firstId}`,
		]),
	);
	let asked = 0;
	await page.route("https://images.example/**", (route) => {
		asked++;
		return route.fulfill({ contentType: "image/png", body: Buffer.from(PIXEL, "base64") });
	});

	await page.goto(`/${slug}/mailboxes/${mailboxId}`);
	await waitForHydration(page);
	await page.getByRole("link", { name: /\(2 messages\).*Kettle deal/ }).click();
	const thread = page.getByRole("list", { name: "Messages in this thread" });
	const [older, newest] = [
		thread.locator(":scope > li").first(),
		thread.locator(":scope > li").last(),
	];
	const frame = '[title="The message, as its sender formatted it"]';
	await expect(
		newest.frameLocator(frame).getByRole("heading", { name: "Second deal" }),
	).toBeVisible();
	expect(asked).toBe(0);

	// Allowed from the newest, the older one shows them when opened.
	await newest.getByRole("button", { name: "Always show images from example.org" }).click();
	await expect.poll(() => asked).toBe(1);
	await older.getByRole("button", { name: /Shop News/ }).click();
	await expect(
		older.frameLocator(frame).getByRole("heading", { name: "First deal" }),
	).toBeVisible();
	await expect.poll(() => asked).toBe(2);

	// Taken back from the newest, the older one, loaded before, follows at once.
	await newest.getByRole("button", { name: "Stop showing images from example.org" }).click();
	await expect(
		older.getByRole("button", { name: "Always show images from example.org" }),
	).toBeVisible();
	await expect(older.getByRole("button", { name: "Show remote images" })).toBeVisible();
	await expect(
		newest.getByText("Remote images are off, so the sender can't tell you opened this."),
	).toBeVisible();
	// Closed and opened again, it stays as it was told.
	await older.getByRole("button", { name: /Shop News/ }).click();
	await older.getByRole("button", { name: /Shop News/ }).click();
	await expect(
		older.frameLocator(frame).getByRole("heading", { name: "First deal" }),
	).toBeVisible();
	await expect(
		older.getByRole("button", { name: "Always show images from example.org" }),
	).toBeVisible();
	expect(asked).toBe(2);
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
	// So does the API the page names, whose document it links.
	const restUrl = new URL("/api/v1", page.url()).href;
	await expect(
		page.getByText(`curl -H "Authorization: Bearer ${key}" ${restUrl}/mailboxes`),
	).toBeVisible();
	const mailboxes = await request.get(`${restUrl}/mailboxes`, {
		headers: { authorization: `Bearer ${key}` },
	});
	expect(mailboxes.status()).toBe(200);
	const document = page.getByRole("link", { name: "OpenAPI document" });
	expect((await request.get((await document.getAttribute("href")) ?? "")).status()).toBe(200);
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

	// Paused, its key reads nothing, and its page says who paused it; resumed, it reads again.
	await page.goto(`/${slug}/settings/agents`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "Pause" }).click();
	await expect(page.getByText(/^Paused by .+ just now\.$/)).toBeVisible();
	const paused = await request.get(`${restUrl}/mailboxes`, {
		headers: { authorization: `Bearer ${key}` },
	});
	expect(paused.status()).toBe(403);
	expect(((await paused.json()) as { error: string }).error).toMatch(/^This agent is paused\./);
	await page.getByRole("button", { name: "Resume" }).click();
	await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
	await expect(page.getByText(/^Paused by /)).toHaveCount(0);
	expect((await api()).status()).toBe(200);

	// Revoked, its key reads nothing.
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

	// The agent's page, from its name, says where it reads and sends, what it wrote, and what waits.
	await page.goto(`/${slug}/settings/agents`);
	await waitForHydration(page);
	await page.getByRole("link", { name: "Sorter", exact: true }).click();
	await expect(page.getByRole("heading", { level: 2, name: "Sorter" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Mailboxes" }).getByRole("listitem")).toHaveText([
		"SupportReads and sends",
	]);
	const held = page.getByRole("region", { name: "Waiting for approval" });
	await expect(held.getByRole("link", { name: /^Your parcel/ })).toContainText(
		"To customer@example.org",
	);
	await expect(
		page.getByRole("region", { name: "What it wrote" }).getByRole("link", { name: /^Your parcel/ }),
	).toContainText("Waiting for approval");

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

	// On the agent's page, it no longer waits, and it was sent.
	await page.goto(`/${slug}/settings/agents`);
	await waitForHydration(page);
	await page.getByRole("link", { name: "Sorter", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "What it wrote" }).getByRole("link", { name: /^Your parcel/ }),
	).toContainText("Sent");
	await expect(page.getByRole("region", { name: "Waiting for approval" })).toHaveCount(0);

	// Its log says what it wrote and who approved it, and, of one kind, what people changed.
	const activity = page.getByRole("region", { name: "Activity" });
	await expect(activity.getByRole("listitem").first()).toContainText(
		`${person.name} approved its message`,
	);
	await expect(activity.getByText("Sorter wrote a message that waits for approval")).toBeVisible();
	const byPeople = activity.getByRole("button", { name: "Changes by people" });
	await byPeople.click();
	await expect(byPeople).toHaveAttribute("aria-pressed", "true");
	await expect(activity.getByText(`${person.name} changed what it may send`)).toBeVisible();
	await expect(activity.getByText(/wrote a message/)).toHaveCount(0);
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
	// The home lists the agent first, for an admin, with what it holds and did.
	const glance = page
		.getByRole("list", { name: "Agents" })
		.getByRole("listitem")
		.filter({ hasText: SORTER });
	await expect(glance.getByText("No addresses of its own")).toBeVisible();
	await expect(glance.getByText("Hasn't used its key yet")).toBeVisible();

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

	// The home, still open, sees it within a look, with no reload: it asks every 15 seconds.
	await expect(glance.getByText("Holds 1 address")).toBeVisible({ timeout: 20_000 });
	await expect(glance.getByText(/^Last made an address, /)).toBeVisible();

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
/** What Email Routing puts above a message whose sender Cloudflare proved to be example.org. */
const PROVED = [
	"Received: from mail.example.org (mail.example.org [192.0.2.1]) by cloudflare-email.net (unknown) id A for <x@example.com>",
	"Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.org; dmarc=pass header.from=example.org; spf=pass",
];

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

test("an admin adds a webhook, which hears of mail as it arrives, signed, and can send a test", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug, mailboxId, to, deliver } = await supportMailbox(page, request, baseURL);
	// The receiver, elsewhere: another host than the app's, as a webhook can't point at Mail.
	const received: { headers: IncomingHttpHeaders; body: string }[] = [];
	const receiver = createServer((incoming, answer) => {
		let body = "";
		incoming.on("data", (chunk) => {
			body += chunk;
		});
		incoming.on("end", () => {
			received.push({ headers: incoming.headers, body });
			answer.end("ok");
		});
	});
	await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
	const port = (receiver.address() as AddressInfo).port;
	const url = `http://127.0.0.1:${port}/mail`;
	try {
		await page.goto(`/${slug}/settings/webhooks`);
		await waitForHydration(page);
		await page.getByRole("button", { name: "Add webhook" }).click();
		const dialog = page.getByRole("dialog", { name: "Add webhook" });
		await dialog.getByLabel("URL").fill(url);
		await expect(dialog.getByLabel("Mail received")).toBeChecked();
		// What becomes of mail the workspace sends is heard only when chosen.
		await expect(dialog.getByLabel("Mail sent")).not.toBeChecked();
		await expect(dialog.getByLabel("Mail bounced")).not.toBeChecked();
		await expect(dialog.getByLabel("Every mailbox, those made later too")).toBeChecked();
		await dialog.getByRole("button", { name: "Add webhook" }).click();
		const secret = await page.getByLabel("Signing secret").inputValue();
		expect(secret).toMatch(/^whsec_/);
		await page.getByRole("button", { name: "Done" }).click();
		const row = page.getByRole("list", { name: "Webhooks" }).getByRole("listitem").first();
		await expect(row.getByText(url)).toBeVisible();
		await expect(row.getByText("Mail received · Every mailbox")).toBeVisible();

		await deliver("customer@example.org", [
			"From: A Customer <customer@example.org>",
			`To: ${to}`,
			"Subject: Tell the hook",
			"Date: Mon, 09 Nov 2026 09:00:00 +0000",
			`Message-ID: <${Date.now()}.hook@example.org>`,
			"",
			"Not in the webhook.",
			"",
		]);
		await expect.poll(() => received.length, { timeout: 15_000 }).toBe(1);
		const [delivery] = received;
		const id = delivery?.headers["webhook-id"];
		const timestamp = delivery?.headers["webhook-timestamp"];
		const mac = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
			.update(`${id}.${timestamp}.${delivery?.body}`)
			.digest("base64");
		expect(delivery?.headers["webhook-signature"]).toBe(`v1,${mac}`);
		const payload = JSON.parse(delivery?.body ?? "{}");
		expect(payload).toMatchObject({
			type: "message.received",
			data: { mailbox: { id: mailboxId, name: "Support" }, message: { subject: "Tell the hook" } },
		});
		expect(delivery?.body).not.toContain("Not in the webhook.");

		// The page shows what was delivered, and sends a test.
		await page.reload();
		await waitForHydration(page);
		await row.getByText("Recent deliveries").click();
		await expect(row.getByRole("list", { name: "Recent deliveries" })).toContainText("Delivered");
		await row.getByRole("button", { name: "Send test" }).click();
		await expect(page.getByText("Test event queued")).toBeVisible();
		await expect.poll(() => received.length, { timeout: 15_000 }).toBe(2);
		expect(JSON.parse(received[1]?.body ?? "{}").type).toBe("webhook.test");
	} finally {
		await new Promise((resolve) => receiver.close(resolve));
	}
});

test("an agent makes a webhook of its own, which an admin sees as the agent's and can pause or delete", async ({
	page,
	request,
	baseURL,
}) => {
	const { slug } = await supportMailbox(page, request, baseURL);
	await page.goto(`/${slug}/settings/agents`);
	await waitForHydration(page);
	await page.getByLabel("Agent name").fill("Listener");
	await page.getByRole("button", { name: "Create agent" }).click();
	const key = await page.getByLabel("Agent key").inputValue();
	const headers = { authorization: `Bearer ${key}` };
	const url = "https://hooks.example.net/agent";
	const made = await request.post("/api/v1/webhooks", {
		headers,
		data: { url, events: ["message.received"] },
	});
	expect(made.status()).toBe(200);

	await page.goto(`/${slug}/settings/webhooks`);
	await waitForHydration(page);
	const row = page.getByRole("list", { name: "Webhooks" }).getByRole("listitem").first();
	await expect(row.getByText(url)).toBeVisible();
	await expect(row.getByText("Mail received · Every mailbox it may read")).toBeVisible();
	await expect(row.getByText(/^Made by Listener, for itself/)).toBeVisible();
	// Where it goes and its secret are the agent's; pausing and deleting it are the admin's.
	await row.getByRole("button", { name: `More for ${url}` }).click();
	await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
	await expect(page.getByRole("menuitem", { name: "New secret" })).toHaveCount(0);
	await page.getByRole("menuitem", { name: "Pause" }).click();
	await expect(row.getByText("Paused")).toBeVisible();
	const listed = await (await request.get("/api/v1/webhooks", { headers })).json();
	expect(listed.webhooks).toEqual([expect.objectContaining({ url, active: false })]);

	await row.getByRole("button", { name: `More for ${url}` }).click();
	await page.getByRole("menuitem", { name: "Delete webhook" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
	await expect(page.getByText("No webhooks yet.")).toBeVisible();
	expect((await (await request.get("/api/v1/webhooks", { headers })).json()).webhooks).toEqual([]);
});
