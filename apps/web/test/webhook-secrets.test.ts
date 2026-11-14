import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { secretsKeys } from "../src/server/secrets-key";
import { createWorkspace, signUp } from "./accounts";
import { startMail } from "./mail-worker";

// A webhook's signing secret is kept sealed under SECRETS_KEY, as raw mail is. Each test starts the
// built Worker again over what the one before kept, as a deployment's next version would find it:
// first without a key, then with one, then after the key changed, then with a key that opens
// nothing kept.

const origin = "https://mail.test";
const RECEIVER = "hooks.example";
// The same across starts, so that the owner's session lasts.
const AUTH = randomBytes(32).toString("base64url");
const OLD = randomBytes(32).toString("base64");
const NEW = randomBytes(32).toString("base64");
const OTHER = randomBytes(32).toString("base64");
const kept = mkdtempSync(join(tmpdir(), "mail-webhook-secrets-"));

interface Received {
	path: string;
	headers: Headers;
	body: string;
}

const received: Received[] = [];

async function receiver(request: Request): Promise<Response> {
	const path = new URL(request.url).pathname;
	received.push({ path, headers: request.headers, body: await request.text() });
	return new Response("ok");
}

let mail: Awaited<ReturnType<typeof startMail>> | undefined;
let owner: Awaited<ReturnType<typeof signUp>> | undefined;
let space: { slug: string; workspaceId: string } | undefined;
/** The webhooks made so far, by name, with the secret each was given. */
const hooks = new Map<string, { id: string; path: string; secret: string }>();

/** Starts the Worker over what the last start kept, with these settings. */
async function start(settings: Record<string, string>) {
	await mail?.dispose();
	mail = await startMail(origin, {
		keptIn: kept,
		hosts: { [RECEIVER]: receiver },
		plainMail: !("SECRETS_KEY" in settings),
		settings: { BETTER_AUTH_SECRET: AUTH, ...settings },
	});
	return mail;
}

const started = () => {
	if (!mail || !owner || !space) throw new Error("start the first test first");
	return { mail, owner, space };
};

afterAll(async () => {
	await mail?.dispose();
	try {
		rmSync(kept, { recursive: true, force: true, maxRetries: 5 });
	} catch {
		// workerd may still hold a file on Windows; the system's temporary folder is cleared anyway.
	}
});

async function change<T>(action: unknown): Promise<T> {
	const { mail, owner, space } = started();
	const response = await mail.fetch(`${origin}/api/webhooks/${space.slug}`, {
		method: "POST",
		headers: { ...owner.headers, origin, "content-type": "application/json" },
		body: JSON.stringify(action),
	});
	const body = (await response.json()) as T & { error?: string };
	expect(body.error).toBeUndefined();
	expect(response.status).toBe(200);
	return body;
}

async function hook(name: string) {
	const path = `/${name}`;
	const made = await change<{ webhook: { id: string; secretStart: string }; secret: string }>({
		action: "create",
		input: { url: `https://${RECEIVER}${path}`, events: ["message.received"], mailboxIds: null },
	});
	const one = { id: made.webhook.id, path, secret: made.secret };
	hooks.set(name, one);
	return one;
}

const hookNamed = (name: string) => {
	const one = hooks.get(name);
	if (!one) throw new Error(`expected the webhook ${name}`);
	return one;
};

/** The webhooks as their object keeps them, read as Gateweave Backup reads it. */
async function stored() {
	const { mail, space } = started();
	const read = await mail.backup<{ id: string; secret: string; start: string }[][]>(
		"read",
		`webhooks.${space.workspaceId}`,
		["SELECT id, secret, secret_start AS start FROM webhook ORDER BY created_at"],
	);
	expect(read.error).toBeUndefined();
	return read.result?.[0] ?? [];
}

/** What reached the receiver at this path, once `count` have, or after waiting for them. */
async function deliveredTo(path: string, count: number, ms = 15_000): Promise<Received[]> {
	const deadline = Date.now() + ms;
	for (;;) {
		const got = received.filter((one) => one.path === path);
		if (got.length >= count || Date.now() > deadline) return got;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Whether a delivery is signed with this secret, as a Standard Webhooks library checks. */
function signedWith(delivery: Received, secret: string): boolean {
	const id = delivery.headers.get("webhook-id");
	const timestamp = delivery.headers.get("webhook-timestamp");
	const mac = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
		.update(`${id}.${timestamp}.${delivery.body}`)
		.digest("base64");
	return delivery.headers.get("webhook-signature") === `v1,${mac}`;
}

/** Sends the webhook a test, and says whether it arrived signed with the secret it was given. */
async function testSigns(name: string): Promise<boolean> {
	const one = hookNamed(name);
	const before = received.filter((got) => got.path === one.path).length;
	await change({ action: "test", id: one.id });
	const [got] = (await deliveredTo(one.path, before + 1)).slice(before);
	return got !== undefined && signedWith(got, one.secret);
}

const keyId = async (key: string) => {
	const { current } = await secretsKeys({ SECRETS_KEY: key });
	if (!current) throw new Error("expected a key");
	return current.id;
};

describe("webhook secrets", () => {
	it("are kept as made while the deployment has no SECRETS_KEY", async () => {
		const mail = await start({});
		owner = await signUp(mail, origin, "Owner");
		const slug = "hooks-sealed";
		space = { slug, workspaceId: await createWorkspace(mail, origin, owner.headers, slug) };
		const plain = await hook("plain");
		expect(await stored()).toEqual([
			{ id: plain.id, secret: plain.secret, start: plain.secret.slice(0, 10) },
		]);
		expect(await testSigns("plain")).toBe(true);
	});

	it("are sealed under the key once there is one, as the object wakes, and still sign", async () => {
		await start({ SECRETS_KEY: OLD });
		const old = await keyId(OLD);
		const plain = hookNamed("plain");
		// Reading wakes the object, which seals before it answers anything.
		const [row] = await stored();
		expect(row?.secret.startsWith(`v2.${old}.`)).toBe(true);
		expect(row?.secret).not.toContain(plain.secret.slice("whsec_".length));
		// The pages still tell secrets apart by their first characters.
		expect(row?.start).toBe(plain.secret.slice(0, 10));
		expect(await testSigns("plain")).toBe(true);

		// A new one is sealed as it is made.
		const sealed = await hook("sealed");
		const rows = await stored();
		const kept = rows.find((one) => one.id === sealed.id);
		expect(kept?.secret.startsWith(`v2.${old}.`)).toBe(true);
		expect(kept?.secret).not.toContain(sealed.secret.slice("whsec_".length));
		expect(kept?.start).toBe(sealed.secret.slice(0, 10));
		expect(await testSigns("sealed")).toBe(true);
	});

	it("are sealed again after the key changes, and the daily run says when none need the old one", async () => {
		const mail = await start({ SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: OLD });
		const [current, previous] = [await keyId(NEW), await keyId(OLD)];
		const { space } = started();
		await mail.runScheduled(0);
		const logged = mail.logs
			.filter((log) => log.message.startsWith("webhooks: {"))
			.map((log) => JSON.parse(log.message.slice("webhooks: ".length)) as Record<string, number>);
		expect(logged.at(-1)).toMatchObject({ unopened: 0, left: 0 });
		expect(logged.at(-1)?.asked).toBeGreaterThanOrEqual(1);
		const done = await mail.db
			.prepare("SELECT sealed_under AS key FROM webhooks_sealed WHERE organization_id = ?")
			.bind(space.workspaceId)
			.first<{ key: string }>();
		expect(done?.key).toBe(`${current}.${previous}`);
		for (const row of await stored()) expect(row.secret.startsWith(`v2.${current}.`)).toBe(true);
		expect(await testSigns("plain")).toBe(true);
		expect(await testSigns("sealed")).toBe(true);

		// Asked again the next day, it is not: none of its secrets needs the old key.
		await mail.runScheduled(0);
		expect(mail.logs.filter((log) => log.message.startsWith("webhooks: {")).at(-1)?.message).toBe(
			`webhooks: ${JSON.stringify({ asked: 0, unopened: 0, left: 0 })}`,
		);
	});

	it("that open with no key the server has are counted, held back, and fixed by a new secret", async () => {
		// As if SECRETS_KEY were replaced without keeping the one before as the previous.
		const mail = await start({ SECRETS_KEY: OTHER });
		const { space } = started();
		const plain = hookNamed("plain");
		const before = received.filter((got) => got.path === plain.path).length;
		await change({ action: "test", id: plain.id });
		await expect
			.poll(
				async () =>
					(
						await mail.backup<{ status: string; error: string | null }[][]>(
							"read",
							`webhooks.${space.workspaceId}`,
							[
								`SELECT status, error FROM delivery WHERE webhook_id = '${plain.id}'
								ORDER BY created_at DESC LIMIT 1`,
							],
						)
					).result?.[0]?.[0],
				{ timeout: 15_000 },
			)
			.toEqual({
				status: "pending",
				error: expect.stringContaining("no longer has the SECRETS_KEY it was sealed with"),
			});
		expect(
			mail.logs.some((log) => log.message.includes("secrets that open with neither key")),
		).toBe(true);
		// Nothing went out unsigned, or signed with anything else.
		expect(received.filter((got) => got.path === plain.path)).toHaveLength(before);

		// A new secret, sealed under the key there is, signs the delivery that waited.
		const { secret } = await change<{ secret: string }>({ action: "rotate", id: plain.id });
		const [late] = (await deliveredTo(plain.path, before + 1, 30_000)).slice(before);
		if (!late) throw new Error("expected the delivery that waited");
		expect(signedWith(late, secret)).toBe(true);
	});
});

describe("the daily run, while the objects still run with the key before", () => {
	it("doesn't count a workspace as done on an object's word about other keys", async () => {
		// The objects run in the first copy, which has only the old key, as the version before the
		// change would; the daily run runs in the second, which has the new one and the old as the
		// previous.
		const both = await startMail(origin, {
			hosts: { [RECEIVER]: receiver },
			isolates: 2,
			settings: { SECRETS_KEY: OLD, SECRETS_KEY_PREVIOUS: "" },
			isolateSettings: [{}, { SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: OLD }],
		});
		try {
			const someone = await signUp(both, origin, "Someone");
			const workspaceId = await createWorkspace(both, origin, someone.headers, "hooks-between");
			const made = await both.fetch(`${origin}/api/webhooks/hooks-between`, {
				method: "POST",
				headers: { ...someone.headers, origin, "content-type": "application/json" },
				body: JSON.stringify({
					action: "create",
					input: {
						url: `https://${RECEIVER}/between`,
						events: ["message.received"],
						mailboxIds: null,
					},
				}),
			});
			expect(made.status).toBe(200);

			await both.runScheduled(1);
			const done = await both.db
				.prepare("SELECT sealed_under AS key FROM webhooks_sealed WHERE organization_id = ?")
				.bind(workspaceId)
				.first<{ key: string }>();
			// Its secret is still under the old key, which must not be let go yet.
			expect(done).toBeNull();
			const logged = both.logs
				.filter((log) => log.message.startsWith("webhooks: {"))
				.map((log) => JSON.parse(log.message.slice("webhooks: ".length)) as Record<string, number>);
			expect(logged.at(-1)?.left).toBeGreaterThanOrEqual(1);
		} finally {
			await both.dispose();
		}
	});
});
