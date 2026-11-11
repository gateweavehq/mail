import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { secretsKeys } from "../src/server/secrets-key";
import { createWorkspace, signUp } from "./accounts";
import { startMail } from "./mail-worker";

const origin = "https://mail.test";
const OLD = randomBytes(32).toString("base64");
const NEW = randomBytes(32).toString("base64");

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
let newId: string;
/** What D1 notes for a mailbox that needs the old key no more. */
let done: string;
let counter = 0;

beforeAll(async () => {
	// The mailboxes' objects run in the first copy, which has the new key and keeps the old one as
	// the previous, as after the change. The second has only the old key, as before it, and writes
	// mail sealed under that.
	mail = await startMail(origin, {
		hosts: { "cloudflare-dns.com": dns },
		isolates: 2,
		settings: { SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: OLD },
		isolateSettings: [{}, { SECRETS_KEY: OLD, SECRETS_KEY_PREVIOUS: "" }],
	});
	owner = await signUp(mail, origin, "Owner");
	const { current, previous } = await secretsKeys({ SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: OLD });
	if (!current || !previous) throw new Error("expected both keys");
	newId = current.id;
	done = `${current.id}.${previous.id}`;
});

afterAll(async () => {
	await mail?.dispose();
});

async function directory(slug: string, action?: unknown) {
	const response = await mail.fetch(`${origin}/api/directory/${slug}`, {
		method: action ? "POST" : "GET",
		headers: owner.headers,
		...(action ? { body: JSON.stringify(action) } : {}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as {
		domains: { id: string; proof: { value: string } | null }[];
		mailboxes: { id: string; name: string }[];
		ok?: boolean;
		proved?: boolean;
	};
}

/** A workspace with a proved domain and a mailbox with one address. */
async function mailboxWithAddress() {
	const n = ++counter;
	const slug = `rekey-${n}`;
	const domain = `rekey${n}.example.com`;
	const headers = { ...owner.headers, "cf-connecting-ip": `198.51.100.${n}` };
	const workspaceId = await createWorkspace(mail, origin, headers, slug);
	await directory(slug, { action: "add-domain", name: domain });
	const [added] = (await directory(slug)).domains;
	if (!added?.proof) throw new Error("expected a proof");
	proofs.set(`_gateweave-mail.${domain}`, added.proof.value);
	expect((await directory(slug, { action: "check-domain", id: added.id })).proved).toBe(true);
	await directory(slug, { action: "add-mailbox", name: "Help", everyone: false });
	const box = (await directory(slug)).mailboxes.find((one) => one.name === "Help");
	if (!box) throw new Error("expected a mailbox");
	const address = `help@${domain}`;
	const linked = await directory(slug, {
		action: "add-address",
		domainId: added.id,
		mailboxId: box.id,
		localPart: "help",
		expiresInDays: null,
	});
	expect(linked.ok).toBe(true);
	return { slug, workspaceId, mailboxId: box.id, address };
}

type Box = Awaited<ReturnType<typeof mailboxWithAddress>>;

const prefixOf = (box: Box) => `${box.workspaceId}/${box.mailboxId}/`;

async function objects(prefix: string) {
	return (await mail.bucket.list({ prefix })).objects.map((object) => object.key);
}

/** Delivers mail the copy with only the old key seals under it, and says which message it is. */
async function keptUnderOld(box: Box, subject: string) {
	const raw = [
		"From: Sender Person <sender@example.org>",
		`To: ${box.address}`,
		`Subject: ${subject}`,
		"Date: Sun, 08 Nov 2026 09:00:00 +0000",
		`Message-ID: <${crypto.randomUUID()}@example.org>`,
		"",
		`The text of ${subject}.`,
		"",
	].join("\r\n");
	expect((await mail.deliver("sender@example.org", box.address, raw, 1)).status).toBe(200);
	const listed = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}`, {
		headers: owner.headers,
	});
	const page = (await listed.json()) as { messages: { id: string; subject: string }[] };
	const found = page.messages.find((one) => one.subject === subject);
	if (!found) throw new Error("expected the message");
	return { id: found.id, raw };
}

const rawMailLogs = () =>
	mail.logs
		.filter((log) => log.message.startsWith("raw mail: "))
		.map((log) => JSON.parse(log.message.slice("raw mail: ".length)) as Record<string, number>);

const sealedUnder = async (mailboxId: string) =>
	(
		await mail.db
			.prepare("SELECT sealed_under AS key FROM mailbox WHERE id = ?")
			.bind(mailboxId)
			.first<{ key: string | null }>()
	)?.key;

describe("mail under the previous SECRETS_KEY", () => {
	it("is sealed again under the current key, beside the original, and reads the same", async () => {
		const box = await mailboxWithAddress();
		const { id, raw } = await keptUnderOld(box, "Old harbour plans");
		const original = `${prefixOf(box)}${id}.eml`;
		const again = `${prefixOf(box)}${id}.${newId}.eml`;
		// The original stays for a window of 15 minutes, as when sealing mail kept as it came.
		await expect
			.poll(() => objects(prefixOf(box)), { timeout: 15_000 })
			.toEqual([original, again].sort());
		const stored = Buffer.from(
			(await (await mail.bucket.get(again))?.arrayBuffer()) ?? new ArrayBuffer(0),
		);
		expect(stored.length).toBeGreaterThan(raw.length);
		expect(stored.toString("latin1")).not.toContain("harbour");
		// The row names the copy: the original no longer matters.
		await mail.bucket.put(original, "not the mail any more");
		const downloaded = await mail.fetch(
			`${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}/original`,
			{ headers: owner.headers },
		);
		expect(await downloaded.text()).toBe(raw);

		// The daily run asks, finds none left, and notes that the mailbox needs the old key no more.
		await mail.runScheduled(0);
		expect(await sealedUnder(box.mailboxId)).toBe(done);
		expect(rawMailLogs().at(-1)).toMatchObject({ left: 0 });
	});

	it("that opens with neither key is counted, and doesn't keep the mailbox waiting", async () => {
		const box = await mailboxWithAddress();
		const before = mail.logs.filter((log) => log.message.includes("can't be sealed again")).length;
		const { id } = await keptUnderOld(box, "Lost");
		// Before the alarm, a couple of seconds after, reaches it.
		await mail.bucket.put(`${prefixOf(box)}${id}.eml`, "not the mail any more");
		await expect
			.poll(() => mail.logs.filter((log) => log.message.includes("can't be sealed again")).length, {
				timeout: 15_000,
			})
			.toBe(before + 1);
		await mail.runScheduled(0);
		expect(await sealedUnder(box.mailboxId)).toBe(done);
		expect(rawMailLogs().at(-1)).toMatchObject({ messages: 0, left: 0 });
		expect(rawMailLogs().at(-1)?.unopened).toBeGreaterThanOrEqual(1);
	});

	it("that comes after the mailbox said it had none has it asked again", async () => {
		const box = await mailboxWithAddress();
		await mail.runScheduled(0);
		expect(await sealedUnder(box.mailboxId)).toBe(done);
		// As from a Worker of the version before, during a deploy.
		const { id } = await keptUnderOld(box, "Late");
		expect(await sealedUnder(box.mailboxId)).toBeNull();
		await expect
			.poll(() => objects(prefixOf(box)), { timeout: 15_000 })
			.toContain(`${prefixOf(box)}${id}.${newId}.eml`);
		await mail.runScheduled(0);
		expect(await sealedUnder(box.mailboxId)).toBe(done);
	});

	it("is deleted with its message, copy and original alike", async () => {
		const box = await mailboxWithAddress();
		const { id } = await keptUnderOld(box, "Goes");
		await expect.poll(() => objects(prefixOf(box)), { timeout: 15_000 }).toHaveLength(2);
		const deleted = await mail.fetch(`${origin}/api/mail/${box.slug}/${box.mailboxId}/${id}`, {
			method: "DELETE",
			headers: owner.headers,
		});
		expect(deleted.status).toBe(200);
		expect(await objects(prefixOf(box))).toEqual([]);
	});
});
