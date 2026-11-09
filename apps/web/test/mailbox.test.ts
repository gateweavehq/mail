import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startMail } from "./mail-worker";

// Mailboxes, reached the way Email Routing and a browser reach them: through the built Worker's
// entry, in workerd, with a stand-in for the DNS resolver that proves domains.

const origin = "https://mail.test";

const proofs = new Map<string, string>();

function dns(request: Request): Response {
	const url = new URL(request.url);
	const value = proofs.get(url.searchParams.get("name") ?? "");
	if (!value || url.searchParams.get("type") !== "TXT") return Response.json({ Status: 3 });
	return Response.json({
		Status: 0,
		Answer: [{ name: url.searchParams.get("name"), type: 16, data: `"${value}"` }],
	});
}

let mail: Awaited<ReturnType<typeof startMail>>;
let owner: Awaited<ReturnType<typeof signUp>>;
let outsider: Awaited<ReturnType<typeof signUp>>;
let counter = 0;

interface Listed {
	domains: { id: string; proof: { value: string } | null }[];
	mailboxes: {
		id: string;
		name: string;
		access: { everyone: boolean; memberIds: string[]; agentIds: string[] } | null;
	}[];
}

interface Page {
	name: string;
	messages: {
		id: string;
		arrivedAt: number;
		from: { name: string; address: string } | null;
		subject: string;
		verifiedDomain: string | null;
		size: number;
	}[];
	next: { arrivedAt: number; id: string } | null;
}

interface Opened {
	id: string;
	from: { name: string; address: string } | null;
	to: { name: string; address: string }[];
	subject: string;
	verifiedDomain: string | null;
	dmarc: string | null;
	text: string;
	hasHtml: boolean;
	remoteImages: boolean;
	imagesAllowed: boolean;
	htmlCut: boolean;
	attachments: { name: string | null; type: string; size: number }[];
}

async function directory(slug: string, headers: Record<string, string>, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers,
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as Listed & { ok?: boolean; proved?: boolean };
}

/** How much a mailbox holds in these tests: room for a message whose HTML is cut to be shown. */
const MAILBOX_BYTES = 3_000_000;

/** A workspace with a proved domain and a mailbox with one address. */
async function mailboxWithAddress(person = owner) {
	const n = ++counter;
	const slug = `box-${n}`;
	const domain = `box${n}.example.com`;
	const headers = { ...person.headers, "cf-connecting-ip": `198.51.100.${n}` };
	const workspaceId = await createWorkspace(mail, origin, headers, slug);
	await directory(slug, person.headers, { action: "add-domain", name: domain });
	const [added] = (await directory(slug, person.headers)).domains;
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
	expect(
		(await directory(slug, person.headers, { action: "check-domain", id: added.id })).proved,
	).toBe(true);
	const mailbox = await addMailbox(slug, person, added.id, `help@${domain}`);
	return {
		slug,
		workspaceId,
		domain,
		domainId: added.id,
		mailboxId: mailbox,
		address: `help@${domain}`,
	};
}

async function addMailbox(
	slug: string,
	person: typeof owner,
	domainId: string,
	address: string,
	everyone = false,
): Promise<string> {
	const name = `Box ${++counter}`;
	await directory(slug, person.headers, { action: "add-mailbox", name, everyone });
	const made = (await directory(slug, person.headers)).mailboxes.find((box) => box.name === name);
	if (!made) throw new Error("expected a mailbox");
	const localPart = address.split("@")[0];
	const added = await directory(slug, person.headers, {
		action: "add-address",
		domainId,
		mailboxId: made.id,
		localPart,
		expiresInDays: null,
	});
	expect(added.ok).toBe(true);
	return made.id;
}

/** Cloudflare's own headers, as Email Routing puts them above a message. */
const fromCloudflare = (dmarc: string) => [
	"Received: from mail.example.org (mail.example.org [192.0.2.1]) by cloudflare-email.net (unknown) id ABC for <x@example.com>; Sun, 08 Nov 2026 09:00:00 +0000",
	"ARC-Seal: i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none; b=abc",
	"ARC-Authentication-Results: i=1; mx.cloudflare.net; dmarc=pass",
	"Received-SPF: pass (mx.cloudflare.net: domain of sender@example.org designates 192.0.2.1 as permitted sender)",
	`Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.org; dmarc=${dmarc} header.from=example.org; spf=pass`,
	"X-CF-SpamH-Score: 1",
];

function message(
	to: string,
	{
		from = "Sender Person <sender@example.org>",
		subject = "Hello",
		body = "Hello there.",
		messageId = `<${crypto.randomUUID()}@example.org>`,
		above = [] as string[],
		extra = [] as string[],
	} = {},
) {
	return [
		...above,
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		"Date: Sun, 08 Nov 2026 09:00:00 +0000",
		`Message-ID: ${messageId}`,
		...extra,
		"",
		body,
		"",
	].join("\r\n");
}

const deliver = (to: string, raw: string) => mail.deliver("sender@example.org", to, raw);

async function kept(to: string, raw: string) {
	const answer = await deliver(to, raw);
	expect(answer.status).toBe(200);
}

function readMailbox(slug: string, mailboxId: string, headers?: Record<string, string>) {
	return mail.fetch(`${origin}/api/mail/${slug}/${mailboxId}`, { headers });
}

/** Whoever asks: a person with their cookie, or an agent with its key. */
type Asker = { headers: Record<string, string> };

async function messages(slug: string, mailboxId: string, person: Asker = owner) {
	const response = await readMailbox(slug, mailboxId, person.headers);
	expect(response.status).toBe(200);
	return (await response.json()) as Page;
}

async function open(slug: string, mailboxId: string, id: string, person = owner) {
	const response = await mail.fetch(`${origin}/api/mail/${slug}/${mailboxId}/${id}`, {
		headers: person.headers,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as Opened;
}

async function objects(prefix: string) {
	return (await mail.bucket.list({ prefix })).objects.map((object) => object.key);
}

beforeAll(async () => {
	mail = await startMail(origin, {
		hosts: { "cloudflare-dns.com": dns },
		settings: { MAILBOX_BYTES: String(MAILBOX_BYTES) },
		// The second copy has no SECRETS_KEY, as a deployment before sealing, and keeps mail as it came.
		isolates: 2,
		isolateSettings: [{}, { SECRETS_KEY: "" }],
	});
	owner = await signUp(mail, origin, "Owner");
	outsider = await signUp(mail, origin, "Outsider");
});

afterAll(async () => {
	await mail?.dispose();
});

describe("storing mail", () => {
	it("keeps a message to an address that exists, and lists it", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "First" }));

		const page = await messages(box.slug, box.mailboxId);
		expect(page.messages).toHaveLength(1);
		expect(page.messages[0]).toMatchObject({
			from: { name: "Sender Person", address: "sender@example.org" },
			subject: "First",
			verifiedDomain: null,
		});
		expect(page.next).toBeNull();
		expect(await objects(`${box.workspaceId}/${box.mailboxId}/`)).toHaveLength(1);
	});

	// Email Routing delivers at least once, and a sender retries after a temporary refusal.
	it("keeps the same message once, however many times it arrives", async () => {
		const box = await mailboxWithAddress();
		const raw = message(box.address);
		await kept(box.address, raw);
		await kept(box.address, raw);
		await kept(box.address, raw);

		expect((await messages(box.slug, box.mailboxId)).messages).toHaveLength(1);
		expect(await objects(`${box.workspaceId}/${box.mailboxId}/`)).toHaveLength(1);
	});

	// Otherwise someone who guessed a message's headers could send one first and have it dropped.
	it("keeps a message with the same headers and another body as a message of its own", async () => {
		const box = await mailboxWithAddress();
		const messageId = "<same@example.org>";
		await kept(box.address, message(box.address, { messageId, body: "The real one." }));
		await kept(box.address, message(box.address, { messageId, body: "Someone else's." }));

		expect((await messages(box.slug, box.mailboxId)).messages).toHaveLength(2);
	});

	it("keeps one message apart for each mailbox it reaches", async () => {
		const box = await mailboxWithAddress();
		const other = await addMailbox(box.slug, owner, box.domainId, `sales@${box.domain}`);
		const messageId = "<both@example.org>";
		await kept(box.address, message(box.address, { messageId }));
		await kept(`sales@${box.domain}`, message(`sales@${box.domain}`, { messageId }));

		expect((await messages(box.slug, box.mailboxId)).messages).toHaveLength(1);
		expect((await messages(box.slug, other)).messages).toHaveLength(1);
	});

	it("lists the newest first, a page at a time", async () => {
		const box = await mailboxWithAddress();
		for (let n = 0; n < 52; n++) {
			await kept(box.address, message(box.address, { subject: `Number ${n}` }));
		}
		const first = await messages(box.slug, box.mailboxId);
		expect(first.messages).toHaveLength(50);
		expect(first.messages[0]?.subject).toBe("Number 51");
		expect(first.next).not.toBeNull();

		const more = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}?beforeAt=${first.next?.arrivedAt}&beforeId=${first.next?.id}`,
			{ headers: owner.headers },
		);
		const second = (await more.json()) as Page;
		expect(second.messages.map((one) => one.subject)).toEqual(["Number 1", "Number 0"]);
		expect(second.next).toBeNull();
	});
});

/** What R2 holds for a message, read as bytes one for one. */
async function inBucket(box: { workspaceId: string; mailboxId: string }, id: string | undefined) {
	const object = await mail.bucket.get(`${box.workspaceId}/${box.mailboxId}/${id}.eml`);
	if (!object) throw new Error("expected the message's mail in R2");
	return Buffer.from(await object.arrayBuffer());
}

describe("raw mail in R2", () => {
	it("is sealed: the bucket holds nothing of a message, which still reads as it came", async () => {
		const box = await mailboxWithAddress();
		const raw = message(box.address, {
			subject: "Harbour plans",
			body: "The harbour opens at nine.",
		});
		await kept(box.address, raw);
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		const stored = await inBucket(box, listed?.id);
		expect(stored.length).toBeGreaterThan(raw.length);
		for (const part of ["arbour", box.address, "sender@example.org", "Message-ID"]) {
			expect(stored.toString("latin1")).not.toContain(part);
		}
		const opened = await open(box.slug, box.mailboxId, listed?.id ?? "");
		expect(opened.subject).toBe("Harbour plans");
		expect(opened.text.trim()).toBe("The harbour opens at nine.");
		const original = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/${listed?.id}/original`,
			{ headers: owner.headers },
		);
		expect(await original.text()).toBe(raw);
	});

	it("doesn't open one message's mail put over another's", async () => {
		const box = await mailboxWithAddress();
		// The same length, so only the seal tells them apart.
		await kept(box.address, message(box.address, { subject: "First", body: "Meet at the gate." }));
		await kept(box.address, message(box.address, { subject: "Other", body: "Meet at the dock." }));
		const [second, first] = (await messages(box.slug, box.mailboxId)).messages;
		const firstMail = await inBucket(box, first?.id);
		expect((await inBucket(box, second?.id)).length).toBe(firstMail.length);
		await mail.bucket.put(
			`${box.workspaceId}/${box.mailboxId}/${second?.id}.eml`,
			new Uint8Array(firstMail).buffer,
		);
		const path = `${origin}/api/mail/${box.slug}/${box.mailboxId}/${second?.id}`;
		const opened = await mail.fetch(path, { headers: owner.headers });
		expect(opened.status).toBe(500);
		expect(await opened.json()).toEqual({ error: "This message can't be opened on this server." });
		// Before a download begins, so it isn't one cut short.
		for (const page of ["original", "html"]) {
			const answer = await mail.fetch(`${path}/${page}`, { headers: owner.headers });
			expect(answer.status).toBe(500);
			expect(await answer.text()).toBe("This message can't be opened on this server.");
		}
		// Its thread still shows, without it opened.
		const threadId = (second as { threadId?: string } | undefined)?.threadId;
		const thread = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${threadId}`,
			{ headers: owner.headers },
		);
		expect(thread.status).toBe(200);
		expect(await thread.json()).toMatchObject({ count: 1, subject: "Other", latest: null });
		// The message it came from still opens.
		expect((await open(box.slug, box.mailboxId, first?.id ?? "")).text.trim()).toBe(
			"Meet at the gate.",
		);
	});

	it("is searched by the start of a message bigger than search reads, from only that part", async () => {
		const box = await mailboxWithAddress();
		// Over SEARCH_READ_BYTES (2 MiB), so search reads its start as a range of the sealed object.
		const filler = Array.from({ length: 30_000 }, () => "x".repeat(76)).join("\r\n");
		await kept(
			box.address,
			message(box.address, { subject: "Notes", body: `Lighthouse keeper.\r\n${filler}` }),
		);
		const until = Date.now() + 15_000;
		let threads: { subject: string }[] = [];
		while (threads.length === 0 && Date.now() < until) {
			const response = await mail.fetch(
				`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads?q=lighthouse`,
				{ headers: owner.headers },
			);
			threads = ((await response.json()) as { threads: { subject: string }[] }).threads;
			if (threads.length === 0) await new Promise((resolve) => setTimeout(resolve, 200));
		}
		expect(threads.map((thread) => thread.subject)).toEqual(["Notes"]);
	});

	it("reads mail kept as it came, before sealing, beside sealed mail", async () => {
		const box = await mailboxWithAddress();
		const before = message(box.address, { subject: "Before", body: "Kept as it came." });
		expect((await mail.deliver("sender@example.org", box.address, before, 1)).status).toBe(200);
		const after = message(box.address, { subject: "After", body: "Kept sealed." });
		await kept(box.address, after);
		const [sealed, plain] = (await messages(box.slug, box.mailboxId)).messages;
		expect((await inBucket(box, plain?.id)).toString("latin1")).toBe(before);
		expect((await inBucket(box, sealed?.id)).toString("latin1")).not.toContain("Kept");
		for (const [listed, raw, text] of [
			[plain, before, "Kept as it came."],
			[sealed, after, "Kept sealed."],
		] as const) {
			expect((await open(box.slug, box.mailboxId, listed?.id ?? "")).text.trim()).toBe(text);
			const original = await mail.fetch(
				`${origin}/api/mail/${box.slug}/${box.mailboxId}/${listed?.id}/original`,
				{ headers: owner.headers },
			);
			expect(await original.text()).toBe(raw);
		}
	});
});

describe("reading a message", () => {
	it("shows its text, who it names and what is attached", async () => {
		const box = await mailboxWithAddress();
		const boundary = "b1";
		await kept(
			box.address,
			message(box.address, {
				subject: "=?UTF-8?B?w5xiZXIgdW5z?=",
				extra: ["MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`],
				body: [
					`--${boundary}`,
					"Content-Type: text/plain; charset=utf-8",
					"",
					"The text of it.",
					`--${boundary}`,
					'Content-Type: application/pdf; name="plan.pdf"',
					'Content-Disposition: attachment; filename="plan.pdf"',
					"Content-Transfer-Encoding: base64",
					"",
					"JVBERi0xLjQK",
					`--${boundary}--`,
				].join("\r\n"),
			}),
		);
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		expect(listed?.subject).toBe("Über uns");
		const opened = await open(box.slug, box.mailboxId, listed?.id ?? "");
		expect(opened.subject).toBe("Über uns");
		expect(opened.text.trim()).toBe("The text of it.");
		expect(opened.to).toEqual([{ name: "", address: box.address }]);
		expect(opened.attachments).toEqual([{ name: "plan.pdf", type: "application/pdf", size: 9 }]);
	});

	it("gives the original as a download, byte for byte", async () => {
		const box = await mailboxWithAddress();
		const raw = message(box.address);
		await kept(box.address, raw);
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		const original = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/${listed?.id}/original`,
			{ headers: owner.headers },
		);
		expect(original.status).toBe(200);
		expect(original.headers.get("content-type")).toBe("message/rfc822");
		expect(original.headers.get("content-disposition")).toMatch(/^attachment;/);
		expect(original.headers.get("cache-control")).toBe("private, no-store");
		expect(await original.text()).toBe(raw);
	});

	// A page shows mail someone else wrote. Its HTML must never reach a page as markup.
	it("shows an HTML message's text, and none of its markup", async () => {
		const box = await mailboxWithAddress();
		await kept(
			box.address,
			message(box.address, {
				extra: ["MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8"],
				body: '<p>Visible words</p><script>alert("mail")</script><img src="x" onerror="alert(1)">',
			}),
		);
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		const opened = await open(box.slug, box.mailboxId, listed?.id ?? "");
		expect(opened.hasHtml).toBe(true);
		expect(opened.text).toContain("Visible words");
		expect(opened.text).not.toContain("alert");

		const page = await mail.fetch(
			`${origin}/${box.slug}/mailboxes/${box.mailboxId}/${listed?.id}`,
			{ headers: owner.headers },
		);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("Visible words");
		expect(html).not.toContain('alert("mail")');
		expect(html).not.toContain("onerror");
	});

	it("shows a mailbox's page with its messages", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "On the page" }));
		const page = await mail.fetch(`${origin}/${box.slug}/mailboxes/${box.mailboxId}`, {
			headers: owner.headers,
		});
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("On the page");
	});
});

describe("who sent it", () => {
	async function verdict(above: string[], extra: string[] = [], from?: string) {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { above, extra, ...(from ? { from } : {}) }));
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		return { listed, opened: await open(box.slug, box.mailboxId, listed?.id ?? "") };
	}

	it("trusts the sender when Cloudflare's own check passed", async () => {
		const { listed, opened } = await verdict(fromCloudflare("pass"));
		expect(listed?.verifiedDomain).toBe("example.org");
		expect(opened).toMatchObject({ verifiedDomain: "example.org", dmarc: "pass" });
	});

	// The domain is what a reader can trust, not the name in front of the address.
	it("names the domain that was proved, whatever the From's name says", async () => {
		const { listed } = await verdict(
			fromCloudflare("pass"),
			[],
			'"ceo@bank.example" <a@example.org>',
		);
		expect(listed?.verifiedDomain).toBe("example.org");
	});

	it("doesn't when Cloudflare checked another domain than the From shows", async () => {
		const { opened } = await verdict(fromCloudflare("pass"), [], "Your Bank <ceo@bank.example>");
		expect(opened).toMatchObject({ verifiedDomain: null, dmarc: "pass" });
	});

	it("doesn't when the message has a second From", async () => {
		const second = await verdict(fromCloudflare("pass"), ["From: ceo@bank.example"]);
		expect(second.opened.verifiedDomain).toBeNull();
		const odd = await verdict(fromCloudflare("pass"), ["From : ceo@bank.example"]);
		expect(odd.opened.verifiedDomain).toBeNull();
	});

	it("doesn't when Cloudflare's check didn't pass", async () => {
		const { opened } = await verdict(fromCloudflare("fail"));
		expect(opened).toMatchObject({ verifiedDomain: null, dmarc: "fail" });
	});

	// A sender can put any header in a message, Authentication-Results included.
	it("doesn't believe a verdict that came with the message", async () => {
		const forged = "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.org";
		const below = await verdict(fromCloudflare("none"), [forged]);
		expect(below.opened).toMatchObject({ verifiedDomain: null, dmarc: "none" });

		const alone = await verdict([forged]);
		expect(alone.opened).toMatchObject({ verifiedDomain: null, dmarc: null });
	});
});

/** Someone new in the workspace, with this role, and the id of their membership. */
async function join(workspaceId: string, role = "member", person?: typeof owner) {
	const who = person ?? (await signUp(mail, origin, `Reader${++counter}`));
	const memberId = crypto.randomUUID();
	await mail.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(memberId, workspaceId, who.userId, role, Date.now())
		.run();
	return { ...who, memberId };
}

function changeDirectory(slug: string, headers: Record<string, string>, action: unknown) {
	return mail.fetch(`${origin}/api/directory/${slug}`, {
		method: "POST",
		headers: { ...headers, origin },
		body: JSON.stringify(action),
	});
}

async function giveAccess(
	box: { slug: string; mailboxId: string },
	access: { everyone?: boolean; memberIds?: string[] },
) {
	const response = await changeDirectory(box.slug, owner.headers, {
		action: "set-mailbox-access",
		mailboxId: box.mailboxId,
		everyone: access.everyone ?? false,
		memberIds: access.memberIds ?? [],
	});
	expect(response.status).toBe(200);
}

/** The status of every way into a mailbox and its one message, for this person. */
async function reach(box: { slug: string; mailboxId: string }, person: Asker) {
	const [listed] = (await messages(box.slug, box.mailboxId)).messages;
	const id = listed?.id ?? "";
	const base = `${origin}/api/mail/${box.slug}/${box.mailboxId}`;
	const threads = await mail.fetch(`${base}/threads`, { headers: owner.headers });
	const [thread] = ((await threads.json()) as { threads: { id: string }[] }).threads;
	const paths = [
		"",
		"/threads",
		`/threads/${thread?.id}`,
		`/${id}`,
		`/${id}/original`,
		`/${id}/html`,
	];
	const statuses = [];
	for (const path of paths) {
		statuses.push((await mail.fetch(`${base}${path}`, { headers: person.headers })).status);
	}
	return statuses;
}

const opened = [200, 200, 200, 200, 200, 200];
const hidden = [404, 404, 404, 404, 404, 404];

describe("who can read a mailbox", () => {
	it("is its owners and admins, until others are given it", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { extra: ["Content-Type: text/html"] }));
		const reader = await join(box.workspaceId);
		const admin = await join(box.workspaceId, "admin");

		expect(await reach(box, owner)).toEqual(opened);
		expect(await reach(box, admin)).toEqual(opened);
		expect(await reach(box, reader)).toEqual(hidden);
		// The directory doesn't name it to them either, nor its addresses.
		expect((await directory(box.slug, reader.headers)).mailboxes).toEqual([]);
		expect((await directory(box.slug, owner.headers)).mailboxes).toEqual([
			expect.objectContaining({
				id: box.mailboxId,
				access: { everyone: false, memberIds: [], agentIds: [], senderIds: [] },
			}),
		]);
	});

	it("is someone given it, until it's taken back", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { extra: ["Content-Type: text/html"] }));
		const reader = await join(box.workspaceId);
		const other = await join(box.workspaceId);

		await giveAccess(box, { memberIds: [reader.memberId] });
		expect(await reach(box, reader)).toEqual(opened);
		expect(await reach(box, other)).toEqual(hidden);
		const theirs = (await directory(box.slug, reader.headers)).mailboxes;
		expect(theirs.map((m) => m.id)).toEqual([box.mailboxId]);
		// Who else reads it is for those who can change it.
		expect(theirs[0]?.access).toBeNull();
		const [seen] = (await directory(box.slug, owner.headers)).mailboxes;
		expect(seen?.access).toEqual({
			everyone: false,
			memberIds: [reader.memberId],
			agentIds: [],
			senderIds: [],
		});

		await giveAccess(box, { memberIds: [other.memberId] });
		expect(await reach(box, reader)).toEqual(hidden);
		expect(await reach(box, other)).toEqual(opened);

		// Made an admin, they read it anyway, so their grant isn't counted among those chosen.
		await mail.db
			.prepare("UPDATE member SET role = 'admin' WHERE id = ?")
			.bind(other.memberId)
			.run();
		const [after] = (await directory(box.slug, owner.headers)).mailboxes;
		expect(after?.access).toEqual({ everyone: false, memberIds: [], agentIds: [], senderIds: [] });
		expect(await reach(box, other)).toEqual(opened);
	});

	// "Everyone" means people. An agent, or a role this version doesn't know, reads a mailbox only
	// when it is given that one, and gets no more than that.
	it("isn't an agent's, nor an unknown role's, unless it is given them", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { extra: ["Content-Type: text/html"] }));
		await giveAccess(box, { everyone: true });
		const person = await join(box.workspaceId);
		const agent = await join(box.workspaceId, "agent");
		const unknown = await join(box.workspaceId, "viewer");

		expect(await reach(box, person)).toEqual(opened);
		expect(await reach(box, agent)).toEqual(hidden);
		expect(await reach(box, unknown)).toEqual(hidden);
		expect((await directory(box.slug, agent.headers)).mailboxes).toEqual([]);

		await giveAccess(box, { everyone: true, memberIds: [agent.memberId] });
		expect(await reach(box, agent)).toEqual(opened);
		expect(await reach(box, unknown)).toEqual(hidden);
		for (const who of [agent, unknown]) {
			const write = await changeDirectory(box.slug, who.headers, {
				action: "add-mailbox",
				name: "Theirs",
			});
			expect(write.status).toBe(403);
		}

		// Admins see them sorted by the role they were given: an unknown one isn't an agent's.
		await giveAccess(box, { everyone: true, memberIds: [agent.memberId, unknown.memberId] });
		expect(await reach(box, unknown)).toEqual(opened);
		const [seen] = (await directory(box.slug, owner.headers)).mailboxes;
		expect(seen?.access).toEqual({
			everyone: true,
			memberIds: [unknown.memberId],
			agentIds: [agent.memberId],
			senderIds: [],
		});
	});

	it("is everyone in the workspace, when the mailbox is open to them", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { extra: ["Content-Type: text/html"] }));
		const reader = await join(box.workspaceId);

		await giveAccess(box, { everyone: true });
		expect(await reach(box, reader)).toEqual(opened);
		await giveAccess(box, { everyone: false });
		expect(await reach(box, reader)).toEqual(hidden);

		const open = await addMailbox(box.slug, owner, box.domainId, `open@${box.domain}`, true);
		await kept(`open@${box.domain}`, message(`open@${box.domain}`));
		expect((await messages(box.slug, open, reader)).messages).toHaveLength(1);
		expect((await directory(box.slug, reader.headers)).mailboxes.map((m) => m.id)).toEqual([open]);
	});

	// Access belongs to the membership, so whoever leaves loses it with the rest of the workspace.
	it("ends when they leave, and doesn't come back when they join again", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const reader = await join(box.workspaceId);
		await giveAccess(box, { memberIds: [reader.memberId] });
		expect((await messages(box.slug, box.mailboxId, reader)).messages).toHaveLength(1);

		await mail.db.prepare("DELETE FROM member WHERE id = ?").bind(reader.memberId).run();
		const grants = await mail.db
			.prepare("SELECT count(*) AS total FROM mailbox_access WHERE mailbox_id = ?")
			.bind(box.mailboxId)
			.first<{ total: number }>();
		expect(grants?.total).toBe(0);

		const back = await join(box.workspaceId, "member", reader);
		expect((await readMailbox(box.slug, box.mailboxId, back.headers)).status).toBe(404);
	});

	it("takes only people in the mailbox's workspace", async () => {
		const box = await mailboxWithAddress();
		const reader = await join(box.workspaceId);
		const elsewhere = await mailboxWithAddress(outsider);
		const stranger = await mail.db
			.prepare("SELECT id FROM member WHERE organization_id = ? AND user_id = ?")
			.bind(elsewhere.workspaceId, outsider.userId)
			.first<{ id: string }>();
		if (!stranger) throw new Error("expected the outsider's membership");

		for (const memberIds of [[stranger.id], [reader.memberId, stranger.id], ["no-such-member"]]) {
			const refused = await changeDirectory(box.slug, owner.headers, {
				action: "set-mailbox-access",
				mailboxId: box.mailboxId,
				everyone: false,
				memberIds,
			});
			expect(refused.status).toBe(409);
		}
		const [seen] = (await directory(box.slug, owner.headers)).mailboxes;
		expect(seen?.access).toEqual({ everyone: false, memberIds: [], agentIds: [], senderIds: [] });

		// However a grant comes to be written, the database holds to it too.
		await expect(
			mail.db
				.prepare("INSERT INTO mailbox_access (mailbox_id, member_id, created_at) VALUES (?, ?, ?)")
				.bind(box.mailboxId, stranger.id, Date.now())
				.run(),
		).rejects.toThrow(/one workspace/);
	});

	it("is changed only by an owner or admin, and only in their workspace", async () => {
		const box = await mailboxWithAddress();
		const reader = await join(box.workspaceId);
		const action = {
			action: "set-mailbox-access",
			mailboxId: box.mailboxId,
			everyone: false,
			memberIds: [reader.memberId],
		};
		expect((await changeDirectory(box.slug, reader.headers, action)).status).toBe(403);

		const theirs = await mailboxWithAddress(outsider);
		const across = await changeDirectory(theirs.slug, outsider.headers, action);
		expect(across.status).toBe(404);
		await kept(box.address, message(box.address, { extra: ["Content-Type: text/html"] }));
		expect(await reach(box, reader)).toEqual(hidden);
	});

	it("is nobody else, who finds nothing there", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		const paths = [
			`${box.slug}/${box.mailboxId}`,
			`${box.slug}/${box.mailboxId}/${listed?.id}`,
			`${box.slug}/${box.mailboxId}/${listed?.id}/original`,
		];
		for (const path of paths) {
			expect(
				(await mail.fetch(`${origin}/api/mail/${path}`, { headers: outsider.headers })).status,
			).toBe(404);
			expect((await mail.fetch(`${origin}/api/mail/${path}`)).status).toBe(404);
		}
	});

	// The mailbox id is checked against the caller's own workspace, not only their membership.
	it("can't be reached through another workspace the caller belongs to", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		const theirs = await mailboxWithAddress(outsider);
		for (const path of [
			`${theirs.slug}/${box.mailboxId}`,
			`${theirs.slug}/${box.mailboxId}/${listed?.id}`,
			`${theirs.slug}/${box.mailboxId}/${listed?.id}/original`,
		]) {
			expect(
				(await mail.fetch(`${origin}/api/mail/${path}`, { headers: outsider.headers })).status,
			).toBe(404);
		}
	});

	it("doesn't open one mailbox's message through another", async () => {
		const box = await mailboxWithAddress();
		const other = await addMailbox(box.slug, owner, box.domainId, `other@${box.domain}`);
		await kept(box.address, message(box.address));
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		const response = await mail.fetch(`${origin}/api/mail/${box.slug}/${other}/${listed?.id}`, {
			headers: owner.headers,
		});
		expect(response.status).toBe(404);
	});
});

function auth(path: string, person: Asker, body?: unknown) {
	return mail.fetch(
		`${origin}/api/auth${path}`,
		body === undefined
			? { headers: person.headers }
			: { method: "POST", headers: person.headers, body: JSON.stringify(body) },
	);
}

/** An agent in the workspace, made by its owner, and the key it was given. */
async function makeAgent(workspaceId: string, name = "Sorter") {
	const response = await auth("/agents/create", owner, { organizationId: workspaceId, name });
	expect(response.status).toBe(200);
	const { agent, key } = (await response.json()) as {
		agent: { id: string; memberId: string };
		key: string;
	};
	expect(key).toMatch(/^gwm_[A-Za-z0-9_-]{43}$/);
	return { ...agent, key, headers: { authorization: `Bearer ${key}` } };
}

/** The workspace's agents, as its owner sees them in settings. */
async function agentsOf(workspaceId: string) {
	const response = await auth(`/agents/list?organizationId=${workspaceId}`, owner);
	expect(response.status).toBe(200);
	return (await response.json()) as { id: string; name: string; keys: { id: string }[] }[];
}

describe("an agent", () => {
	it("reads with its key only the mailboxes it is given, never through everyone", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { extra: ["Content-Type: text/html"] }));
		const other = await addMailbox(box.slug, owner, box.domainId, `other@${box.domain}`, true);
		const agent = await makeAgent(box.workspaceId);

		expect(await reach(box, agent)).toEqual(hidden);
		await giveAccess(box, { everyone: true });
		expect(await reach(box, agent)).toEqual(hidden);
		expect((await directory(box.slug, agent.headers)).mailboxes).toEqual([]);

		await giveAccess(box, { everyone: true, memberIds: [agent.memberId] });
		expect(await reach(box, agent)).toEqual(opened);
		const theirs = (await directory(box.slug, agent.headers)).mailboxes;
		expect(theirs.map((m) => m.id)).toEqual([box.mailboxId]);
		expect(theirs[0]?.access).toBeNull();
		expect((await readMailbox(box.slug, other, agent.headers)).status).toBe(404);

		// Admins see it among the agents, apart from the people.
		const seen = (await directory(box.slug, owner.headers)).mailboxes.find(
			(m) => m.id === box.mailboxId,
		);
		expect(seen?.access).toEqual({
			everyone: true,
			memberIds: [],
			agentIds: [agent.memberId],
			senderIds: [],
		});
	});

	it("is turned away with a key that doesn't work, whatever cookies come with it", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const agent = await makeAgent(box.workspaceId);
		await giveAccess(box, { memberIds: [agent.memberId] });
		const elsewhere = await mailboxWithAddress();
		const strangers = await makeAgent(elsewhere.workspaceId);

		const turnedAway = [
			`Bearer ${agent.key}x`,
			`Bearer gwm_${"A".repeat(43)}`,
			`Bearer ${strangers.key}`,
			`Bearer ${agent.key} ${agent.key}`,
			"Bearer gwm_",
			`bearer GWM_${"A".repeat(43)}`,
		];
		for (const authorization of turnedAway) {
			// The owner's cookie would open it, but a request with a key is the key's alone.
			const headers = { ...owner.headers, authorization };
			expect((await readMailbox(box.slug, box.mailboxId, headers)).status).toBe(404);
		}
		expect((await readMailbox(box.slug, box.mailboxId, agent.headers)).status).toBe(200);
		const lowercase = { authorization: `bearer ${agent.key}` };
		expect((await readMailbox(box.slug, box.mailboxId, lowercase)).status).toBe(200);
		// A token of another shape or another scheme carries no key, such as an ID token or Basic
		// auth from a proxy in front of the app: the session decides, and without one nobody is
		// let in.
		for (const authorization of [
			"Basic b3duZXI6cGFzc3dvcmQ=",
			"Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJl",
			"Bearer",
		]) {
			const withCookie = { ...owner.headers, authorization };
			expect((await readMailbox(box.slug, box.mailboxId, withCookie)).status).toBe(200);
			expect((await readMailbox(box.slug, box.mailboxId, { authorization })).status).toBe(404);
		}
		// Its key works only in its own workspace.
		const across = { headers: agent.headers };
		expect((await readMailbox(elsewhere.slug, elsewhere.mailboxId, across.headers)).status).toBe(
			404,
		);
	});

	it("loses access when its key is revoked or it is deleted", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const agent = await makeAgent(box.workspaceId);
		await giveAccess(box, { memberIds: [agent.memberId] });
		const made = await auth("/agents/create-key", owner, { agentId: agent.id });
		const { key: second, secret } = (await made.json()) as { key: { id: string }; secret: string };
		const spare = { headers: { authorization: `Bearer ${secret}` } };
		expect((await messages(box.slug, box.mailboxId, spare)).messages).toHaveLength(1);

		expect((await auth("/agents/revoke-key", owner, { keyId: second.id })).status).toBe(200);
		expect((await readMailbox(box.slug, box.mailboxId, spare.headers)).status).toBe(404);
		expect((await readMailbox(box.slug, box.mailboxId, agent.headers)).status).toBe(200);

		expect((await auth("/agents/delete", owner, { agentId: agent.id })).status).toBe(200);
		expect((await readMailbox(box.slug, box.mailboxId, agent.headers)).status).toBe(404);
		const grants = await mail.db
			.prepare("SELECT count(*) AS total FROM mailbox_access WHERE member_id = ?")
			.bind(agent.memberId)
			.first<{ total: number }>();
		expect(grants?.total).toBe(0);
	});

	it("changes nothing: no directory change, no deletion", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const agent = await makeAgent(box.workspaceId);
		await giveAccess(box, { memberIds: [agent.memberId] });
		const [listed] = (await messages(box.slug, box.mailboxId, agent)).messages;
		const headers = { ...agent.headers, origin, "content-type": "application/json" };

		const change = await mail.fetch(`${origin}/api/directory/${box.slug}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ action: "add-mailbox", name: "Theirs" }),
		});
		expect(change.status).toBe(404);
		const removal = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/${listed?.id}`,
			{ method: "DELETE", headers },
		);
		expect(removal.status).toBe(403);
		expect((await messages(box.slug, box.mailboxId)).messages).toHaveLength(1);
		// Better Auth's endpoints need a session, which a key never is.
		const made = await auth(
			"/agents/create",
			{ headers },
			{
				organizationId: box.workspaceId,
				name: "Another",
			},
		);
		expect(made.status).toBe(401);
	});

	it("is made, keyed and managed only by owners and admins", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box.workspaceId);
		const keyId = (await agentsOf(box.workspaceId))[0]?.keys[0]?.id;
		const member = await join(box.workspaceId);
		const asMember = [
			auth(`/agents/list?organizationId=${box.workspaceId}`, member),
			auth("/agents/create", member, { organizationId: box.workspaceId, name: "Mine" }),
			auth("/agents/create-key", member, { agentId: agent.id }),
			auth("/agents/update", member, { agentId: agent.id, name: "Mine" }),
			auth("/agents/revoke-key", member, { keyId }),
			auth("/agents/delete", member, { agentId: agent.id }),
		];
		for (const response of await Promise.all(asMember)) expect(response.status).toBe(403);
		// Nor through the endpoints for people: an agent's role never changes, and it is
		// deleted, keys and all, from its own settings.
		const asPerson = [
			auth("/organization/update-member-role", owner, {
				memberId: agent.memberId,
				role: "admin",
				organizationId: box.workspaceId,
			}),
			auth("/organization/remove-member", owner, {
				memberIdOrEmail: agent.memberId,
				organizationId: box.workspaceId,
			}),
		];
		for (const response of await Promise.all(asPerson)) expect(response.status).toBe(403);
		const [listed] = await agentsOf(box.workspaceId);
		expect(listed).toMatchObject({ id: agent.id, name: "Sorter", keys: [{ id: keyId }] });
	});

	it("is only what the agents plugin made: a person given its role by hand is managed as people are", async () => {
		const box = await mailboxWithAddress();
		const person = await join(box.workspaceId, "agent");
		const others = await join(box.workspaceId, "agent");
		const fixed = await auth("/organization/update-member-role", owner, {
			memberId: person.memberId,
			role: "member",
			organizationId: box.workspaceId,
		});
		expect(fixed.status).toBe(200);
		const removed = await auth("/organization/remove-member", owner, {
			memberIdOrEmail: others.memberId,
			organizationId: box.workspaceId,
		});
		expect(removed.status).toBe(200);
		const left = await mail.db
			.prepare("SELECT id, role FROM member WHERE organization_id = ? AND id IN (?, ?)")
			.bind(box.workspaceId, person.memberId, others.memberId)
			.all();
		expect(left.results).toEqual([{ id: person.memberId, role: "member" }]);
	});

	it("is out of reach for an admin of another workspace", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box.workspaceId);
		const keyId = (await agentsOf(box.workspaceId))[0]?.keys[0]?.id;
		const elsewhere = await mailboxWithAddress();
		const stranger = await join(elsewhere.workspaceId, "admin");
		const attempts = [
			auth(`/agents/list?organizationId=${box.workspaceId}`, stranger),
			auth("/agents/create", stranger, { organizationId: box.workspaceId, name: "Theirs" }),
			auth("/agents/create-key", stranger, { agentId: agent.id }),
			auth("/agents/update", stranger, { agentId: agent.id, name: "Theirs" }),
			auth("/agents/revoke-key", stranger, { keyId }),
			auth("/agents/delete", stranger, { agentId: agent.id }),
		];
		for (const response of await Promise.all(attempts)) expect(response.status).toBe(403);
		const [listed] = await agentsOf(box.workspaceId);
		expect(listed).toMatchObject({ id: agent.id, name: "Sorter", keys: [{ id: keyId }] });
		expect((await directory(box.slug, agent.headers)).mailboxes).toEqual([]);
	});

	it("needs a recent sign-in to be made or given a key", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box.workspaceId);
		const admin = await join(box.workspaceId, "admin");
		await mail.db
			.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
			.bind(Date.now() - 2 * 24 * 60 * 60 * 1000, admin.userId)
			.run();
		// A key outlives the session that made it, so an old or stolen cookie can't leave one behind.
		const refused = [
			await auth("/agents/create", admin, { organizationId: box.workspaceId, name: "Late" }),
			await auth("/agents/create-key", admin, { agentId: agent.id }),
		];
		for (const response of refused) {
			expect(response.status).toBe(403);
			expect(((await response.json()) as { code?: string }).code).toBe("SESSION_NOT_FRESH");
		}
		// What makes no key still works on an older sign-in.
		expect((await auth("/agents/update", admin, { agentId: agent.id, name: "Kept" })).status).toBe(
			200,
		);
		const listed = await agentsOf(box.workspaceId);
		expect(listed.map((a) => [a.name, a.keys.length])).toEqual([["Kept", 1]]);
	});

	it("is only an account made as one, never a person's given the role", async () => {
		const box = await mailboxWithAddress();
		const person = await join(box.workspaceId, "agent");
		const attempts = [
			auth("/agents/create-key", owner, { agentId: person.userId }),
			auth("/agents/update", owner, { agentId: person.userId, name: "Renamed" }),
			auth("/agents/delete", owner, { agentId: person.userId }),
		];
		for (const response of await Promise.all(attempts)) expect(response.status).toBe(404);
		expect(await agentsOf(box.workspaceId)).toEqual([]);
		const kept = await mail.db
			.prepare(
				"SELECT u.name AS name, (SELECT count(*) FROM agent_key WHERE user_id = u.id) AS keys FROM user u WHERE u.id = ?",
			)
			.bind(person.userId)
			.first<{ name: string; keys: number }>();
		expect(kept).toEqual({ name: expect.not.stringMatching(/^Renamed$/), keys: 0 });
	});

	it("has an address nobody can sign up, sign in or be invited under", async () => {
		const box = await mailboxWithAddress();
		const agent = await makeAgent(box.workspaceId);
		const address = `${agent.id}@agents.invalid`;
		const signUp = await mail.fetch(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { ...owner.headers, cookie: "", "cf-connecting-ip": "203.0.113.250" },
			body: JSON.stringify({ name: "Not an agent", email: address, password: "a-long-password" }),
		});
		expect(signUp.status).toBe(400);
		const invite = await auth("/organization/invite-member", owner, {
			email: address,
			role: "member",
			organizationId: box.workspaceId,
		});
		expect(invite.status).toBe(400);
	});

	it("goes with its workspace", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const agent = await makeAgent(box.workspaceId);
		await giveAccess(box, { memberIds: [agent.memberId] });
		const deleted = await auth("/organization/delete", owner, { organizationId: box.workspaceId });
		expect(deleted.status).toBe(200);
		const left = await mail.db
			.prepare("SELECT count(*) AS total FROM user WHERE id = ?")
			.bind(agent.id)
			.first<{ total: number }>();
		expect(left?.total).toBe(0);
		expect((await readMailbox(box.slug, box.mailboxId, agent.headers)).status).toBe(404);
	});
});

describe("removing mail", () => {
	it("goes with its mailbox", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const prefix = `${box.workspaceId}/${box.mailboxId}/`;
		expect(await objects(prefix)).toHaveLength(1);

		await directory(box.slug, owner.headers, { action: "remove-mailbox", id: box.mailboxId });
		expect(await objects(prefix)).toEqual([]);
		expect((await readMailbox(box.slug, box.mailboxId, owner.headers)).status).toBe(404);
	});

	it("goes with its workspace", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const prefix = `${box.workspaceId}/`;
		expect(await objects(prefix)).toHaveLength(1);

		const deleted = await mail.fetch(`${origin}/api/auth/organization/delete`, {
			method: "POST",
			headers: owner.headers,
			body: JSON.stringify({ organizationId: box.workspaceId }),
		});
		expect(deleted.status).toBe(200);
		// It is removed after the answer, as the workspace's mail can take a while.
		await expect.poll(() => objects(prefix), { timeout: 5000 }).toEqual([]);
	});

	/** Makes D1's records of removals look older, as the daily run only finishes those. */
	async function ageRemovals() {
		await mail.db
			.prepare("UPDATE mailbox_removal SET removed_at = removed_at - ?")
			.bind(2 * 60 * 60 * 1000)
			.run();
	}

	async function removals(mailboxId: string) {
		const row = await mail.db
			.prepare("SELECT count(*) AS n FROM mailbox_removal WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	// As if the Worker stopped right after the mailbox's row went, before removing its mail.
	it("is finished by the daily run when a removal stopped part way", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const prefix = `${box.workspaceId}/${box.mailboxId}/`;
		await mail.db.prepare("DELETE FROM mailbox WHERE id = ?").bind(box.mailboxId).run();
		expect(await removals(box.mailboxId)).toBe(1);

		// A delivery that found the mailbox just before it went may still land, so the run waits.
		await mail.runScheduled();
		expect(await objects(prefix)).toHaveLength(1);

		await ageRemovals();
		await mail.runScheduled();
		expect(await objects(prefix)).toEqual([]);
		expect(await removals(box.mailboxId)).toBe(0);
	});

	it("is finished by the daily run for every mailbox of a workspace that went", async () => {
		const box = await mailboxWithAddress();
		const other = await addMailbox(box.slug, owner, box.domainId, `sales@${box.domain}`);
		await kept(box.address, message(box.address));
		await kept(`sales@${box.domain}`, message(`sales@${box.domain}`));
		await mail.db.prepare("DELETE FROM organization WHERE id = ?").bind(box.workspaceId).run();
		expect(await removals(box.mailboxId)).toBe(1);
		expect(await removals(other)).toBe(1);

		await ageRemovals();
		await mail.runScheduled();
		expect(await objects(`${box.workspaceId}/`)).toEqual([]);
	});

	// The bucket may be shared, and only what a mailbox stored is Mail's to remove.
	it("touches nothing in the bucket that no removed mailbox stored", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const elsewhere = ["notes/today.txt", `${box.workspaceId}/${crypto.randomUUID()}/kept.eml`];
		for (const key of elsewhere) await mail.bucket.put(key, "not Mail's");

		await ageRemovals();
		await mail.runScheduled();
		for (const key of elsewhere) expect(await objects(key)).toEqual([key]);
		expect((await messages(box.slug, box.mailboxId)).messages).toHaveLength(1);
	});
});

describe("deleting a message", () => {
	function remove(slug: string, mailboxId: string, id: string, headers: Record<string, string>) {
		return mail.fetch(`${origin}/api/mail/${slug}/${mailboxId}/${id}`, {
			method: "DELETE",
			headers,
		});
	}

	it("is for an owner or admin, and its mail goes", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "Going" }));
		await kept(box.address, message(box.address, { subject: "Staying" }));
		const going = (await messages(box.slug, box.mailboxId)).messages.find(
			(one) => one.subject === "Going",
		);

		const response = await remove(box.slug, box.mailboxId, going?.id ?? "", owner.headers);
		expect(response.status).toBe(200);
		expect((await messages(box.slug, box.mailboxId)).messages.map((one) => one.subject)).toEqual([
			"Staying",
		]);
		expect(await objects(`${box.workspaceId}/${box.mailboxId}/`)).toHaveLength(1);
		expect((await remove(box.slug, box.mailboxId, going?.id ?? "", owner.headers)).status).toBe(
			404,
		);
	});

	it("isn't for a member, nor from another site, and nobody else finds the message", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		const id = listed?.id ?? "";
		const reader = await join(box.workspaceId);
		// Without the mailbox, a member finds nothing to delete; with it, they still may not.
		expect((await remove(box.slug, box.mailboxId, id, reader.headers)).status).toBe(404);
		await giveAccess(box, { memberIds: [reader.memberId] });
		expect((await remove(box.slug, box.mailboxId, id, reader.headers)).status).toBe(403);
		expect(
			(
				await remove(box.slug, box.mailboxId, id, {
					...owner.headers,
					origin: "https://elsewhere.test",
				})
			).status,
		).toBe(403);
		expect((await remove(box.slug, box.mailboxId, id, outsider.headers)).status).toBe(404);
		expect((await messages(box.slug, box.mailboxId)).messages).toHaveLength(1);
	});
});

describe("a full mailbox", () => {
	const big = (to: string, subject: string) =>
		message(to, { subject, body: "x".repeat(MAILBOX_BYTES * 0.6) });

	// The sender keeps the message and tries again later, by when there may be room.
	it("tells the sender to try again, and takes the mail once a message is deleted", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, big(box.address, "First"));
		const refused = await deliver(box.address, big(box.address, "Second"));
		expect(refused.status).toBeGreaterThanOrEqual(500);
		expect(refused.text).not.toContain("No such address");

		const [first] = (await messages(box.slug, box.mailboxId)).messages;
		const deleted = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/${first?.id}`,
			{ method: "DELETE", headers: owner.headers },
		);
		expect(deleted.status).toBe(200);
		await kept(box.address, big(box.address, "Second"));
		expect((await messages(box.slug, box.mailboxId)).messages.map((one) => one.subject)).toEqual([
			"Second",
		]);
	});
});

describe("threads", () => {
	interface Threads {
		threads: {
			id: string;
			latestAt: number;
			count: number;
			subject: string;
			senders: { name: string; address: string }[];
			latestVerifiedDomain: string | null;
		}[];
		next: { latestAt: number; id: string } | null;
	}

	interface Thread {
		mailbox: string;
		subject: string;
		count: number;
		messages: { id: string; threadId: string; subject: string }[];
		older: { arrivedAt: number; id: string } | null;
		latest: (Opened & { threadId: string }) | null;
	}

	async function threads(slug: string, mailboxId: string, query = "") {
		const response = await mail.fetch(`${origin}/api/mail/${slug}/${mailboxId}/threads${query}`, {
			headers: owner.headers,
		});
		expect(response.status).toBe(200);
		return (await response.json()) as Threads;
	}

	function thread(
		slug: string,
		mailboxId: string,
		id: string,
		headers = owner.headers,
		query = "",
	) {
		return mail.fetch(`${origin}/api/mail/${slug}/${mailboxId}/threads/${id}${query}`, {
			headers,
		});
	}

	async function openThread(slug: string, mailboxId: string, id: string, query = "") {
		const response = await thread(slug, mailboxId, id, owner.headers, query);
		expect(response.status).toBe(200);
		return (await response.json()) as Thread;
	}

	const subjects = async (slug: string, mailboxId: string) =>
		(await threads(slug, mailboxId)).threads.map((one) => [one.subject, one.count]);

	it("puts a reply in the thread of the message it answers, newest news first", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "Older", messageId: "<old@x>" }));
		await kept(box.address, message(box.address, { subject: "Plan", messageId: "<plan@x>" }));
		await kept(
			box.address,
			message(box.address, {
				from: "Second Person <second@example.org>",
				subject: "Re: Plan",
				messageId: "<reply@x>",
				extra: ["In-Reply-To: <plan@x>", "References: <plan@x>"],
				above: fromCloudflare("pass"),
			}),
		);

		const page = await threads(box.slug, box.mailboxId);
		expect(page.threads.map((one) => [one.subject, one.count])).toEqual([
			["Plan", 2],
			["Older", 1],
		]);
		const [plan] = page.threads;
		expect(plan?.senders.map((one) => one.address)).toEqual([
			"sender@example.org",
			"second@example.org",
		]);
		expect(plan?.latestVerifiedDomain).toBe("example.org");
		expect(page.threads[1]?.latestVerifiedDomain).toBeNull();

		const body = await openThread(box.slug, box.mailboxId, plan?.id ?? "");
		expect(body.subject).toBe("Plan");
		expect(body.messages.map((one) => one.subject)).toEqual(["Plan", "Re: Plan"]);
		expect(body.latest?.subject).toBe("Re: Plan");
		expect(body.latest?.threadId).toBe(plan?.id);
		expect(body.count).toBe(2);
		expect(body.older).toBeNull();

		// Each message knows its thread, in the listing of messages too.
		const listed = (await messages(box.slug, box.mailboxId)).messages as { threadId?: string }[];
		expect(listed.filter((one) => one.threadId === plan?.id)).toHaveLength(2);
	});

	it("keeps a reply apart when its subject is another", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "Invoice 42", messageId: "<inv@x>" }));
		await kept(
			box.address,
			message(box.address, { subject: "Something else entirely", extra: ["In-Reply-To: <inv@x>"] }),
		);
		await kept(
			box.address,
			message(box.address, {
				subject: "RE: [billing] invoice  42",
				extra: ["References: <inv@x>"],
			}),
		);

		// The reply with the same subject made its thread the one with the newest news, and a thread
		// shows its newest message's subject.
		expect(await subjects(box.slug, box.mailboxId)).toEqual([
			["invoice 42", 2],
			["Something else entirely", 1],
		]);
	});

	it("never joins a thread on its subject alone", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "Plan", messageId: "<plan@x>" }));
		await kept(box.address, message(box.address, { subject: "Re: Plan" }));
		await kept(
			box.address,
			message(box.address, { subject: "Re: Plan", extra: ["References: <elsewhere@x>"] }),
		);

		expect(await subjects(box.slug, box.mailboxId)).toEqual([
			["Plan", 1],
			["Plan", 1],
			["Plan", 1],
		]);
	});

	it("takes in a reply that arrived before the message it answers", async () => {
		const box = await mailboxWithAddress();
		await kept(
			box.address,
			message(box.address, { subject: "Re: Late", extra: ["In-Reply-To: <late@x>"] }),
		);
		await kept(box.address, message(box.address, { subject: "Late", messageId: "<late@x>" }));

		const page = await threads(box.slug, box.mailboxId);
		expect(page.threads.map((one) => [one.subject, one.count])).toEqual([["Late", 2]]);
		const body = await openThread(box.slug, box.mailboxId, page.threads[0]?.id ?? "");
		// In the order they arrived.
		expect(body.messages.map((one) => one.subject)).toEqual(["Re: Late", "Late"]);
	});

	it("puts together replies to a message the mailbox never got", async () => {
		// Such as mail its people sent from elsewhere: every answer names it, and none is here.
		const box = await mailboxWithAddress();
		for (const who of ["one", "two"]) {
			await kept(
				box.address,
				message(box.address, {
					from: `${who} <${who}@example.org>`,
					subject: "Re: Trip",
					extra: ["In-Reply-To: <mine@elsewhere>", "References: <mine@elsewhere>"],
				}),
			);
		}
		await kept(
			box.address,
			message(box.address, { subject: "Re: Other", extra: ["References: <mine@elsewhere>"] }),
		);

		expect(await subjects(box.slug, box.mailboxId)).toEqual([
			["Other", 1],
			["Trip", 2],
		]);
	});

	it("shows a thread's subject in words no stranger chose, beside the newest proved domain", async () => {
		const box = await mailboxWithAddress();
		// A stranger who knows the id of a message the mailbox's people sent elsewhere writes first.
		await kept(
			box.address,
			message(box.address, {
				from: "Billing <billing@attacker.example>",
				subject: "[Pay to IBAN XX00 1234 instead] Invoice 42",
				extra: ["In-Reply-To: <invoice@elsewhere>"],
			}),
		);
		// Then the real answer arrives, proved.
		await kept(
			box.address,
			message(box.address, {
				subject: "Re: Invoice 42",
				extra: ["In-Reply-To: <invoice@elsewhere>"],
				above: fromCloudflare("pass"),
			}),
		);

		const [line] = (await threads(box.slug, box.mailboxId)).threads;
		expect([line?.subject, line?.count, line?.latestVerifiedDomain]).toEqual([
			"Invoice 42",
			2,
			"example.org",
		]);
		expect((await openThread(box.slug, box.mailboxId, line?.id ?? "")).subject).toBe("Invoice 42");

		// And when a stranger writes the newest message, their tags don't reach the line either.
		await kept(
			box.address,
			message(box.address, {
				from: "Billing <billing@attacker.example>",
				subject: "Re: [Reply within 24h or lose access] Invoice 42",
				extra: ["In-Reply-To: <invoice@elsewhere>"],
			}),
		);
		const [after] = (await threads(box.slug, box.mailboxId)).threads;
		expect([after?.subject, after?.count, after?.latestVerifiedDomain]).toEqual([
			"Invoice 42",
			3,
			null,
		]);
	});

	it("takes in any number of threads that one reply links", async () => {
		// A stranger can make a thread of every message they send, and SQLite takes at most a hundred
		// values in a query, so linking them mustn't take one each.
		const box = await mailboxWithAddress();
		for (let n = 0; n < 101; n++) {
			await kept(box.address, message(box.address, { messageId: "<root@x>", body: `Copy ${n}` }));
		}
		expect((await threads(box.slug, box.mailboxId)).next).not.toBeNull();

		await kept(
			box.address,
			message(box.address, { subject: "Re: Hello", extra: ["References: <root@x>"] }),
		);

		const page = await threads(box.slug, box.mailboxId);
		expect(page.threads.map((one) => one.count)).toEqual([102]);
		expect(page.next).toBeNull();
	});

	it("merges two threads that one message links", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "Merge", messageId: "<a@x>" }));
		await kept(box.address, message(box.address, { subject: "Merge", messageId: "<b@x>" }));
		expect(await subjects(box.slug, box.mailboxId)).toEqual([
			["Merge", 1],
			["Merge", 1],
		]);
		const [newer, older] = (await threads(box.slug, box.mailboxId)).threads;

		await kept(
			box.address,
			message(box.address, { subject: "Re: Merge", extra: ["References: <a@x> <b@x>"] }),
		);

		const page = await threads(box.slug, box.mailboxId);
		expect(page.threads.map((one) => [one.subject, one.count])).toEqual([["Merge", 3]]);
		// The thread that began first takes in the other.
		expect(page.threads[0]?.id).toBe(older?.id);
		expect((await thread(box.slug, box.mailboxId, newer?.id ?? "")).status).toBe(404);
	});

	it("follows deletions: a thread shrinks, then goes with its last message", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "Short", messageId: "<s@x>" }));
		await kept(
			box.address,
			message(box.address, { subject: "Re: Short", extra: ["In-Reply-To: <s@x>"] }),
		);
		const [only] = (await threads(box.slug, box.mailboxId)).threads;
		const body = await openThread(box.slug, box.mailboxId, only?.id ?? "");
		const remove = (id: string) =>
			mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}`, {
				method: "DELETE",
				headers: owner.headers,
			});

		expect((await remove(body.messages[1]?.id ?? "")).status).toBe(200);
		const after = (await threads(box.slug, box.mailboxId)).threads;
		expect(after.map((one) => [one.subject, one.count])).toEqual([["Short", 1]]);
		expect(after[0]?.latestAt).toBeLessThan(only?.latestAt ?? 0);

		expect((await remove(body.messages[0]?.id ?? "")).status).toBe(200);
		expect((await threads(box.slug, box.mailboxId)).threads).toEqual([]);
		expect((await thread(box.slug, box.mailboxId, only?.id ?? "")).status).toBe(404);
	});

	it("shows a thread only to the workspace's members, through its own mailbox", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "Private" }));
		const [only] = (await threads(box.slug, box.mailboxId)).threads;
		const other = await addMailbox(box.slug, owner, box.domainId, `other@${box.domain}`);
		const id = only?.id ?? "";

		expect((await thread(box.slug, box.mailboxId, id, outsider.headers)).status).toBe(404);
		expect((await thread(box.slug, other, id)).status).toBe(404);
		// Nor through a mailbox of another workspace of theirs.
		const elsewhere = await mailboxWithAddress();
		expect((await thread(elsewhere.slug, elsewhere.mailboxId, id)).status).toBe(404);
		const listing = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads`, {
			headers: outsider.headers,
		});
		expect(listing.status).toBe(404);
	});

	it("pages through a long thread, from its newest messages", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "Long", messageId: "<long@x>" }));
		for (let n = 1; n <= 50; n++) {
			await kept(
				box.address,
				message(box.address, {
					subject: "Re: Long",
					body: `Reply ${n}`,
					extra: ["In-Reply-To: <long@x>"],
				}),
			);
		}
		const [line] = (await threads(box.slug, box.mailboxId)).threads;
		const id = line?.id ?? "";

		const first = await openThread(box.slug, box.mailboxId, id);
		expect(first.count).toBe(51);
		expect(first.messages).toHaveLength(50);
		expect(first.messages[0]?.subject).toBe("Re: Long");
		expect(first.latest?.id).toBe(first.messages.at(-1)?.id);
		expect(first.latest?.text).toContain("Reply 50");

		const second = await openThread(
			box.slug,
			box.mailboxId,
			id,
			`?beforeAt=${first.older?.arrivedAt}&beforeId=${first.older?.id}`,
		);
		expect(second.count).toBe(51);
		expect(second.messages.map((one) => one.subject)).toEqual(["Long"]);
		expect(second.older).toBeNull();
	});

	it("pages through threads", async () => {
		const box = await mailboxWithAddress();
		for (let n = 0; n < 51; n++) {
			await kept(box.address, message(box.address, { subject: `Thread ${n}` }));
		}
		const first = await threads(box.slug, box.mailboxId);
		expect(first.threads).toHaveLength(50);
		expect(first.threads[0]?.subject).toBe("Thread 50");
		const second = await threads(
			box.slug,
			box.mailboxId,
			`?beforeAt=${first.next?.latestAt}&beforeId=${first.next?.id}`,
		);
		expect(second.threads.map((one) => one.subject)).toEqual(["Thread 0"]);
		expect(second.next).toBeNull();
	});
});

describe("search", () => {
	interface Found {
		threads: { id: string; count: number; subject: string }[];
		next: { latestAt: number; id: string } | null;
	}

	async function search(slug: string, mailboxId: string, q: string, query = "", person = owner) {
		return mail.fetch(
			`${origin}/api/mail/${slug}/${mailboxId}/threads?q=${encodeURIComponent(q)}${query}`,
			{ headers: person.headers },
		);
	}

	async function find(slug: string, mailboxId: string, q: string, query = "") {
		const response = await search(slug, mailboxId, q, query);
		expect(response.status).toBe(200);
		return (await response.json()) as Found;
	}

	/**
	 * Searches until it finds `count` threads, as the alarm indexes a message a moment after it is
	 * stored, the newest first.
	 */
	async function eventually(slug: string, mailboxId: string, q: string, count: number) {
		const until = Date.now() + 15_000;
		for (;;) {
			const page = await find(slug, mailboxId, q);
			if (page.threads.length >= count || Date.now() > until) return page;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	const subjects = (page: Found) => page.threads.map((one) => one.subject);

	it("finds threads by words in a message's text, subject, sender or attachments", async () => {
		const box = await mailboxWithAddress();
		await kept(
			box.address,
			message(box.address, {
				from: "Shop <orders@shop.example>",
				subject: "Invoice 42",
				messageId: "<invoice@shop.example>",
				extra: ["MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"'],
				body: [
					"--b1",
					"Content-Type: text/plain; charset=utf-8",
					"",
					"Your parcel has shipped.",
					"--b1",
					'Content-Type: application/pdf; name="receipt-42.pdf"',
					'Content-Disposition: attachment; filename="receipt-42.pdf"',
					"Content-Transfer-Encoding: base64",
					"",
					"JVBERi0xLjQK",
					"--b1--",
				].join("\r\n"),
			}),
		);
		await kept(box.address, message(box.address, { subject: "Lunch", body: "Meet at noon?" }));
		await kept(
			box.address,
			message(box.address, {
				subject: "Re: Invoice 42",
				body: "Where is my parcel? It's late.",
				extra: ["In-Reply-To: <invoice@shop.example>"],
			}),
		);

		// The thread with both messages, once.
		const parcel = await eventually(box.slug, box.mailboxId, "late", 1);
		expect(parcel.threads.map((one) => [one.subject, one.count])).toEqual([["Invoice 42", 2]]);
		expect(subjects(await eventually(box.slug, box.mailboxId, "receipt-42.pdf", 1))).toEqual([
			"Invoice 42",
		]);
		expect(subjects(await eventually(box.slug, box.mailboxId, "LUNCH noo", 1))).toEqual(["Lunch"]);
		// All three are indexed from here on.
		expect(subjects(await find(box.slug, box.mailboxId, "parcel"))).toEqual(["Invoice 42"]);
		expect(subjects(await find(box.slug, box.mailboxId, "orders@shop.example"))).toEqual([
			"Invoice 42",
		]);
		// Every word, not any.
		expect(subjects(await find(box.slug, box.mailboxId, "parcel noon"))).toEqual([]);
		// Nothing to look for finds nothing, rather than everything.
		expect(subjects(await find(box.slug, box.mailboxId, " - "))).toEqual([]);
	});

	it("finds an HTML message by its text, not its markup", async () => {
		const box = await mailboxWithAddress();
		await kept(
			box.address,
			message(box.address, {
				extra: ["MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8"],
				body: '<div class="hiddenclass">See you <b>tomorrow</b></div><script>scriptword()</script>',
			}),
		);
		expect(subjects(await eventually(box.slug, box.mailboxId, "tomorrow", 1))).toEqual(["Hello"]);
		expect(subjects(await find(box.slug, box.mailboxId, "hiddenclass"))).toEqual([]);
		expect(subjects(await find(box.slug, box.mailboxId, "scriptword"))).toEqual([]);
	});

	it("finds text written in full-width or half-width forms, by plain words or pasted ones", async () => {
		const box = await mailboxWithAddress();
		await kept(
			box.address,
			message(box.address, {
				// "Ｉｎｖｏｉｃｅ", in full-width letters.
				subject: "=?UTF-8?B?77yp772O772W772P772J772D772F?=",
				extra: ["MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8"],
				body: "ｶﾀｶﾅ and the ﬁnance report for ２０２６",
			}),
		);
		const [thread] = (await eventually(box.slug, box.mailboxId, "invoice", 1)).threads;
		expect(thread).toBeDefined();
		for (const q of ["Ｉｎｖｏｉｃｅ", "finance", "ﬁnance", "2026", "ｶﾀｶﾅ", "カタカナ"]) {
			const found = await find(box.slug, box.mailboxId, q);
			expect(
				found.threads.map((one) => one.id),
				q,
			).toEqual([thread?.id]);
		}
	});

	it("takes what FTS5 would read as syntax as words to look for", async () => {
		const box = await mailboxWithAddress();
		await kept(
			box.address,
			message(box.address, { subject: "Plans", body: "Or near the station" }),
		);
		expect(subjects(await eventually(box.slug, box.mailboxId, "or near", 1))).toEqual(["Plans"]);
		for (const q of [
			'"',
			"OR",
			"NEAR(station",
			"subject:plans",
			"*",
			"station OR x",
			"^near",
			"a\u0000b",
			"station\u0000",
		]) {
			expect((await search(box.slug, box.mailboxId, q)).status, JSON.stringify(q)).toBe(200);
		}
		expect(subjects(await find(box.slug, box.mailboxId, "station OR x"))).toEqual([]);
		// A NUL parts words, as a space does.
		expect(subjects(await find(box.slug, box.mailboxId, "near\u0000station"))).toEqual(["Plans"]);
	});

	it("no longer finds a message once it is deleted", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { subject: "Gone soon", body: "ephemeral" }));
		const [thread] = (await eventually(box.slug, box.mailboxId, "ephemeral", 1)).threads;
		const opened = (await (
			await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/threads/${thread?.id}`, {
				headers: owner.headers,
			})
		).json()) as { messages: { id: string }[] };
		const deleted = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/${opened.messages[0]?.id}`,
			{ method: "DELETE", headers: owner.headers },
		);
		expect(deleted.status).toBe(200);
		expect(subjects(await find(box.slug, box.mailboxId, "ephemeral"))).toEqual([]);
	});

	it("is for the workspace's members only", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { body: "private words" }));
		await eventually(box.slug, box.mailboxId, "private", 1);
		expect((await search(box.slug, box.mailboxId, "private", "", outsider)).status).toBe(404);
	});

	it("pages through what it finds, a few messages indexed at a time", async () => {
		const box = await mailboxWithAddress();
		for (let n = 0; n < 51; n++) {
			await kept(box.address, message(box.address, { subject: `Found ${n}`, body: "pagedword" }));
		}
		// Until the alarm has indexed all 51, over several runs.
		const after = (page: Found) => `&beforeAt=${page.next?.latestAt}&beforeId=${page.next?.id}`;
		const until = Date.now() + 15_000;
		for (;;) {
			const first = await find(box.slug, box.mailboxId, "pagedword");
			const second = first.next && (await find(box.slug, box.mailboxId, "pagedword", after(first)));
			if (second?.threads.length === 1 || Date.now() > until) break;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}

		const first = await find(box.slug, box.mailboxId, "pagedword");
		expect(first.threads).toHaveLength(50);
		expect(first.threads[0]?.subject).toBe("Found 50");
		const second = await find(box.slug, box.mailboxId, "pagedword", after(first));
		expect(subjects(second)).toEqual(["Found 0"]);
		expect(second.next).toBeNull();
	});
});

describe("a message's HTML", () => {
	// As in src/server/mailbox/html.ts, which these tests reach only through the Worker.
	const MAX_SHOWN_HTML = 1_000_000;
	const MAX_INLINE_IMAGES = 5_000_000;

	const html = (body: string) => ({
		extra: ["MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8"],
		body,
	});

	async function htmlOf(box: { slug: string; mailboxId: string }, id: string, query = "") {
		return mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}/html${query}`, {
			headers: owner.headers,
		});
	}

	const open_ = (box: { slug: string; mailboxId: string }, id: string) =>
		open(box.slug, box.mailboxId, id);

	async function delivered(body: Parameters<typeof message>[1]) {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, body));
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		return { box, id: listed?.id ?? "" };
	}

	it("is a page that runs nothing and loads nothing from elsewhere", async () => {
		const { box, id } = await delivered(
			html(
				[
					'<html lang="en"><head><meta http-equiv="refresh" content="0;url=https://away.example/">',
					'<base href="https://away.example/"><link rel="stylesheet" href="https://away.example/s.css">',
					"<title>Inside</title><style>p { color: teal }</style></head>",
					'<body bgcolor="#eeeeee" onload="parent.document.title=1">',
					'<p class="lead" onclick="steal()">Your order shipped.</p>',
					"<script>parent.document.title='ran'</script>",
					'<noscript><img src="https://away.example/noscript.gif"></noscript>',
					'<img src="https://tracker.example/open.gif" alt="Logo" width="10">',
					'<img src="//tracker.example/relative.gif">',
					'<div style="background: url(https://tracker.example/bg.gif)">Styled</div>',
					'<a href="javascript:steal()">Bad</a> <a href="&#106;avascript:steal()">Hidden</a>',
					'<a href="https://shop.example/track?a=1&amp;b=2" ping="https://away.example/">Track it</a>',
					'<a href="#top">Top</a> <a href="/relative">Relative</a>',
					'<form action="https://away.example/"><input name="password"><button>Send</button></form>',
					'<iframe src="https://away.example/"></iframe><object data="https://away.example/x"></object>',
					"<xmp><meta http-equiv=refresh content=0></xmp>",
					'<svg><script>steal()</script><image href="https://away.example/i.png"/></svg>',
					"<o:p>Outlook kept</o:p><!-- a comment -->",
					"</body></html>",
				].join("\r\n"),
			),
		);
		const response = await htmlOf(box, id);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const policy = (response.headers.get("content-security-policy") ?? "").split("; ");
		expect(policy).toEqual([
			"sandbox allow-popups allow-popups-to-escape-sandbox",
			"default-src 'none'",
			"img-src data:",
			"style-src 'unsafe-inline'",
			"font-src data:",
			"frame-ancestors 'self'",
			"base-uri 'none'",
			"form-action 'none'",
		]);
		// The app's own policy and its frame ban stay off it.
		expect(response.headers.get("x-frame-options")).toBeNull();
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");

		const page = await response.text();
		expect(page.startsWith("<!doctype html>")).toBe(true);
		expect(page).toContain('<p class="lead">Your order shipped.</p>');
		expect(page).toContain('<body bgcolor="#eeeeee">');
		expect(page).toContain("<style>p { color: teal }</style>");
		expect(page).toContain('<img alt="Logo" width="10">');
		expect(page).toContain("<img>");
		expect(page).toContain(
			'<div style="background: url(https://tracker.example/bg.gif)">Styled</div>',
		);
		expect(page).toContain("<a>Bad</a> <a>Hidden</a>");
		expect(page).toContain(
			'<a href="https://shop.example/track?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Track it</a>',
		);
		expect(page).toContain('<a href="#top">Top</a> <a>Relative</a>');
		expect(page).toContain("Send");
		expect(page).toContain("Outlook kept");
		for (const gone of [
			"<script",
			"<noscript",
			"onclick",
			"onload",
			"http-equiv",
			"<base",
			"<link",
			"<title",
			"<form",
			"<input",
			"<button",
			"<iframe",
			"<object",
			"<xmp",
			"<svg",
			"<o:p",
			"<!--",
			"javascript",
			"steal",
			"ping",
			"tracker.example/open",
			"relative.gif",
			"away.example",
		]) {
			expect(page, gone).not.toContain(gone);
		}
	});

	it("shows remote images when asked", async () => {
		const { box, id } = await delivered(
			html('<p>Hi</p><img src="https://images.example/logo.png" alt="Logo">'),
		);
		expect((await open(box.slug, box.mailboxId, id)).remoteImages).toBe(true);
		const response = await htmlOf(box, id, "?images=1");
		expect(response.headers.get("content-security-policy")).toContain("img-src data: https: http:");
		expect(await response.text()).toContain(
			'<img src="https://images.example/logo.png" alt="Logo">',
		);
	});

	it("shows the message's own images where it names them", async () => {
		const pixel =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const boundary = "rel1";
		const { box, id } = await delivered({
			extra: ["MIME-Version: 1.0", `Content-Type: multipart/related; boundary="${boundary}"`],
			body: [
				`--${boundary}`,
				"Content-Type: text/html; charset=utf-8",
				"",
				'<p>Logo:</p><img src="cid:logo%40shop.example" alt="Logo"><img src="cid:drawing@shop.example"><img src="cid:missing@shop.example">',
				'<img src="cid:photo&amp;1@shop.example" alt="Photo">',
				`--${boundary}`,
				"Content-Type: image/png",
				"Content-ID: <logo@shop.example>",
				"Content-Transfer-Encoding: base64",
				"",
				pixel,
				`--${boundary}`,
				"Content-Type: image/svg+xml",
				"Content-ID: <drawing@shop.example>",
				"",
				'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
				`--${boundary}`,
				"Content-Type: image/jpg",
				"Content-ID: <photo&1@shop.example>",
				"Content-Transfer-Encoding: base64",
				"",
				"/9j/2w==",
				`--${boundary}--`,
			].join("\r\n"),
		});
		const opened = await open(box.slug, box.mailboxId, id);
		expect(opened.hasHtml).toBe(true);
		expect(opened.remoteImages).toBe(false);
		const page = await (await htmlOf(box, id)).text();
		expect(page).toContain(`<img src="data:image/png;base64,${pixel}" alt="Logo">`);
		// Not an image type that is shown, and not a part of this message.
		expect(page).toContain("<img><img>");
		expect(page).toContain('<img src="data:image/jpeg;base64,/9j/2w==" alt="Photo">');
	});

	it("puts a message's own images in only up to a size, however often it names them", async () => {
		const image = "A".repeat(40_000);
		const boundary = "rel2";
		const { box, id } = await delivered({
			extra: ["MIME-Version: 1.0", `Content-Type: multipart/related; boundary="${boundary}"`],
			body: [
				`--${boundary}`,
				"Content-Type: text/html; charset=utf-8",
				"",
				'<img src="cid:big@shop.example">'.repeat(200),
				`--${boundary}`,
				"Content-Type: image/png",
				"Content-ID: <big@shop.example>",
				"Content-Transfer-Encoding: base64",
				"",
				image,
				`--${boundary}--`,
			].join("\r\n"),
		});
		const page = await (await htmlOf(box, id)).text();
		const address = `data:image/png;base64,${image}`;
		const shown = page.split(address).length - 1;
		// Each use counts: the page holds the whole address every time.
		expect(shown).toBe(Math.floor(MAX_INLINE_IMAGES / address.length));
		expect(page.split("<img>").length - 1).toBe(200 - shown);
	});

	it("shows the start of HTML that is too long, with nothing after it", async () => {
		// Cut inside a tag, which a browser drops at the end of the page. Anything put after it
		// would close the tag.
		const open = '<a href="https://cut.example/sign-in"';
		const start = `<p>${"x".repeat(MAX_SHOWN_HTML - 3 - open.length)}`;
		const { box, id } = await delivered(html(`${start}${open} title="t">More</a><p>After`));
		const opened = await open_(box, id);
		expect(opened.htmlCut).toBe(true);
		const page = await (await htmlOf(box, id)).text();
		expect(page.endsWith(open)).toBe(true);
		expect(page).not.toContain("After");
		expect(page).not.toContain("too long");
	});

	it("is not there for a message without HTML, or for anyone who can't see it", async () => {
		const text = await delivered({});
		expect((await htmlOf(text.box, text.id)).status).toBe(404);

		const { box, id } = await delivered(html("<p>Private</p>"));
		const path = `${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}/html`;
		expect((await mail.fetch(path, { headers: outsider.headers })).status).toBe(404);
		expect((await mail.fetch(path)).status).toBe(404);
		const theirs = await mailboxWithAddress(outsider);
		const through = `${origin}/api/mail/${theirs.slug}/${box.mailboxId}/${id}/html`;
		expect((await mail.fetch(through, { headers: outsider.headers })).status).toBe(404);
	});
});

describe("remote images a person allows", () => {
	const withImage = '<p>Hi</p><img src="https://images.example/logo.png" alt="Logo">';

	/** A message with a remote image, which Cloudflare proved, or didn't, to come from example.org. */
	function shop(to: string, proved: boolean) {
		return message(to, {
			above: proved ? fromCloudflare("pass") : [],
			extra: ["MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8"],
			body: withImage,
		});
	}

	/** Delivers a message and gives its id, as the mailbox lists the newest first. */
	async function arrive(box: { slug: string; mailboxId: string; address: string }, proved = true) {
		await kept(box.address, shop(box.address, proved));
		return (await messages(box.slug, box.mailboxId)).messages[0]?.id ?? "";
	}

	function images(slug: string, person: Asker, action?: unknown) {
		return mail.fetch(`${origin}/api/images/${slug}`, {
			method: action ? "POST" : "GET",
			headers: { ...person.headers, origin },
			...(action ? { body: JSON.stringify(action) } : {}),
		});
	}

	async function allowed(slug: string, person: Asker = owner) {
		const response = await images(slug, person);
		expect(response.status).toBe(200);
		return ((await response.json()) as { senders: { domain: string }[] }).senders.map(
			(sender) => sender.domain,
		);
	}

	it("shows them by themselves for a domain allowed from a message it proved it sent", async () => {
		const box = await mailboxWithAddress();
		const first = await arrive(box);
		expect(await open(box.slug, box.mailboxId, first)).toMatchObject({
			verifiedDomain: "example.org",
			remoteImages: true,
			imagesAllowed: false,
		});

		const allow = await images(box.slug, owner, {
			action: "allow",
			mailbox: box.mailboxId,
			message: first,
		});
		expect(allow.status).toBe(200);
		expect(await allow.json()).toEqual({ ok: true, domain: "example.org" });
		expect((await open(box.slug, box.mailboxId, first)).imagesAllowed).toBe(true);
		expect(await allowed(box.slug)).toEqual(["example.org"]);

		// The next message from the domain shows them too.
		const next = await arrive(box);
		expect((await open(box.slug, box.mailboxId, next)).imagesAllowed).toBe(true);

		// Taking it back stops them, for every message.
		const stop = await images(box.slug, owner, { action: "stop", domain: "Example.org" });
		expect(await stop.json()).toEqual({ ok: true, domain: "example.org" });
		expect((await open(box.slug, box.mailboxId, next)).imagesAllowed).toBe(false);
		expect((await open(box.slug, box.mailboxId, first)).imagesAllowed).toBe(false);
		expect(await allowed(box.slug)).toEqual([]);
	});

	// Anyone can write `From: sender@example.org`; only Cloudflare's check proves it.
	it("never for a From that nothing proves, even of a domain allowed", async () => {
		const box = await mailboxWithAddress();
		const proved = await arrive(box);
		const allow = await images(box.slug, owner, {
			action: "allow",
			mailbox: box.mailboxId,
			message: proved,
		});
		expect(allow.status).toBe(200);

		const forged = await arrive(box, false);
		expect(await open(box.slug, box.mailboxId, forged)).toMatchObject({
			from: { name: "Sender Person", address: "sender@example.org" },
			verifiedDomain: null,
			remoteImages: true,
			imagesAllowed: false,
		});
		// Nor can its sender be allowed from it.
		const refused = await images(box.slug, owner, {
			action: "allow",
			mailbox: box.mailboxId,
			message: forged,
		});
		expect(refused.status).toBe(400);
		expect(await allowed(box.slug)).toEqual(["example.org"]);
	});

	it("is the person's own: other readers and agents of the mailbox don't get it", async () => {
		const box = await mailboxWithAddress();
		const id = await arrive(box);
		const reader = await join(box.workspaceId);
		const agent = await makeAgent(box.workspaceId);
		await giveAccess(box, { everyone: true, memberIds: [agent.memberId] });
		const allowing = { action: "allow", mailbox: box.mailboxId, message: id };
		expect((await images(box.slug, owner, allowing)).status).toBe(200);

		expect((await open(box.slug, box.mailboxId, id, reader)).imagesAllowed).toBe(false);
		expect(await allowed(box.slug, reader)).toEqual([]);
		const byKey = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}`, {
			headers: agent.headers,
		});
		expect(byKey.status).toBe(200);
		expect(((await byKey.json()) as Opened).imagesAllowed).toBe(false);

		// An agent's key has no list, and changes none.
		expect((await images(box.slug, agent)).status).toBe(404);
		expect((await images(box.slug, agent, allowing)).status).toBe(404);
		const stopping = { action: "stop", domain: "example.org" };
		expect((await images(box.slug, agent, stopping)).status).toBe(404);
		// Nor does anyone outside the workspace, or for a mailbox the person can't read.
		expect((await images(box.slug, outsider, allowing)).status).toBe(404);
		const theirs = await mailboxWithAddress(outsider);
		const elsewhere = { action: "allow", mailbox: theirs.mailboxId, message: id };
		expect((await images(box.slug, owner, elsewhere)).status).toBe(404);
		expect(await allowed(box.slug)).toEqual(["example.org"]);
	});

	it("only from a message of a mailbox the person reads, named with that mailbox", async () => {
		const box = await mailboxWithAddress();
		const id = await arrive(box);
		const allowing = { action: "allow", mailbox: box.mailboxId, message: id };
		// A member of the workspace who wasn't given the mailbox.
		const reader = await join(box.workspaceId);
		expect((await images(box.slug, reader, allowing)).status).toBe(404);
		expect(await allowed(box.slug, reader)).toEqual([]);
		// Another mailbox of the workspace, which the owner reads too, doesn't hold that message.
		const other = await addMailbox(box.slug, owner, box.domainId, `sales@${box.domain}`);
		const mixed = { action: "allow", mailbox: other, message: id };
		expect((await images(box.slug, owner, mixed)).status).toBe(404);
		expect(await allowed(box.slug)).toEqual([]);
	});

	it("takes a change only from the app's own pages", async () => {
		const box = await mailboxWithAddress();
		const id = await arrive(box);
		const response = await mail.fetch(`${origin}/api/images/${box.slug}`, {
			method: "POST",
			headers: { ...owner.headers, origin: "https://elsewhere.example" },
			body: JSON.stringify({ action: "allow", mailbox: box.mailboxId, message: id }),
		});
		expect(response.status).toBe(403);
		expect(await allowed(box.slug)).toEqual([]);
	});

	it("keeps at most 500 senders for a person", async () => {
		const box = await mailboxWithAddress();
		const id = await arrive(box);
		const row = await mail.db
			.prepare("SELECT id FROM member WHERE organization_id = ? AND user_id = ?")
			.bind(box.workspaceId, owner.userId)
			.first<{ id: string }>();
		const insert = mail.db.prepare("INSERT INTO image_sender (member_id, domain) VALUES (?, ?)");
		await mail.db.batch(
			Array.from({ length: 500 }, (_, n) => insert.bind(row?.id, `sender${n}.example`)),
		);
		const allowing = { action: "allow", mailbox: box.mailboxId, message: id };
		expect((await images(box.slug, owner, allowing)).status).toBe(409);
		expect((await open(box.slug, box.mailboxId, id)).imagesAllowed).toBe(false);
		// One goes, and there is room again.
		await images(box.slug, owner, { action: "stop", domain: "sender0.example" });
		expect((await images(box.slug, owner, allowing)).status).toBe(200);
		// Full again, allowing one already there still says yes.
		expect((await images(box.slug, owner, allowing)).status).toBe(200);
		expect((await allowed(box.slug)).length).toBe(500);
	});

	it("goes with the person's membership", async () => {
		const box = await mailboxWithAddress();
		const id = await arrive(box);
		const reader = await join(box.workspaceId);
		await giveAccess(box, { everyone: true });
		const allowing = { action: "allow", mailbox: box.mailboxId, message: id };
		expect((await images(box.slug, reader, allowing)).status).toBe(200);
		await mail.db.prepare("DELETE FROM member WHERE id = ?").bind(reader.memberId).run();
		const left = await mail.db
			.prepare("SELECT count(*) AS n FROM image_sender WHERE member_id = ?")
			.bind(reader.memberId)
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
	});
});
