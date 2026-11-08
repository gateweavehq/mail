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
	mailboxes: { id: string; name: string }[];
}

interface Page {
	name: string;
	messages: {
		id: string;
		arrivedAt: number;
		from: { name: string; address: string } | null;
		subject: string;
		verified: boolean;
		size: number;
	}[];
	next: { arrivedAt: number; id: string } | null;
}

interface Opened {
	id: string;
	from: { name: string; address: string } | null;
	to: { name: string; address: string }[];
	subject: string;
	verified: boolean;
	dmarc: string | null;
	text: string;
	hasHtml: boolean;
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
): Promise<string> {
	const name = `Box ${++counter}`;
	await directory(slug, person.headers, { action: "add-mailbox", name });
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
		subject = "Hello",
		body = "Hello there.",
		messageId = `<${crypto.randomUUID()}@example.org>`,
		above = [] as string[],
		extra = [] as string[],
	} = {},
) {
	return [
		...above,
		"From: Sender Person <sender@example.org>",
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

async function messages(slug: string, mailboxId: string, person = owner) {
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
	mail = await startMail(origin, { hosts: { "cloudflare-dns.com": dns } });
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
			verified: false,
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
	async function verdict(above: string[], extra: string[] = []) {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address, { above, extra }));
		const [listed] = (await messages(box.slug, box.mailboxId)).messages;
		return { listed, opened: await open(box.slug, box.mailboxId, listed?.id ?? "") };
	}

	it("trusts the sender when Cloudflare's own check passed", async () => {
		const { listed, opened } = await verdict(fromCloudflare("pass"));
		expect(listed?.verified).toBe(true);
		expect(opened).toMatchObject({ verified: true, dmarc: "pass" });
	});

	it("doesn't when Cloudflare's check didn't pass", async () => {
		const { opened } = await verdict(fromCloudflare("fail"));
		expect(opened).toMatchObject({ verified: false, dmarc: "fail" });
	});

	// A sender can put any header in a message, Authentication-Results included.
	it("doesn't believe a verdict that came with the message", async () => {
		const forged = "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.org";
		const below = await verdict(fromCloudflare("none"), [forged]);
		expect(below.opened).toMatchObject({ verified: false, dmarc: "none" });

		const alone = await verdict([forged]);
		expect(alone.opened).toMatchObject({ verified: false, dmarc: null });
	});
});

describe("who can read a mailbox", () => {
	it("is every member of its workspace", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const reader = await signUp(mail, origin, `Reader${++counter}`);
		await mail.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
			)
			.bind(crypto.randomUUID(), box.workspaceId, reader.userId, Date.now())
			.run();
		const [listed] = (await messages(box.slug, box.mailboxId, reader)).messages;
		expect((await open(box.slug, box.mailboxId, listed?.id ?? "", reader)).subject).toBe("Hello");
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

	it("goes in the daily run when a removal stopped part way, and nothing else does", async () => {
		const box = await mailboxWithAddress();
		await kept(box.address, message(box.address));
		const left = `${box.workspaceId}/${crypto.randomUUID()}/`;
		await mail.bucket.put(`${left}${crypto.randomUUID()}.eml`, "left behind");

		await mail.runScheduled();
		expect(await objects(left)).toEqual([]);
		expect(await objects(`${box.workspaceId}/${box.mailboxId}/`)).toHaveLength(1);
		expect((await messages(box.slug, box.mailboxId)).messages).toHaveLength(1);
	});
});
