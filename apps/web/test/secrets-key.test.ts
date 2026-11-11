import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSealer, sealerFor } from "../src/server/secrets";
import { startMail } from "./mail-worker";

const origin = "https://mail.test";
const OLD = randomBytes(32).toString("base64");
const NEW = randomBytes(32).toString("base64");
const OTHER = randomBytes(32).toString("base64");

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	// The first copy has only the old key, as the deployment before the change. The second has the
	// new key and keeps the old one as the previous, as after it.
	mail = await startMail(origin, {
		isolates: 2,
		settings: { SECRETS_KEY: OLD },
		isolateSettings: [{}, { SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: OLD }],
	});
	const now = Date.now();
	await mail.db.batch(
		["one", "two", "three", "four"].map((id) =>
			mail.db
				.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?1, ?1, ?1, ?2)")
				.bind(id, now),
		),
	);
});

afterAll(async () => {
	await mail?.dispose();
});

async function seal(key: string, workspaceId: string, place: string, secret: string) {
	const sealer = await sealerFor({ SECRETS_KEY: key }, workspaceId);
	if (!isSealer(sealer)) throw new Error(sealer.unavailable);
	return sealer.seal(place, secret);
}

async function open(key: string, workspaceId: string, place: string, sealed: string) {
	const sealer = await sealerFor({ SECRETS_KEY: key }, workspaceId);
	if (!isSealer(sealer)) throw new Error(sealer.unavailable);
	return sealer.open(place, sealed);
}

/** What `openProviderKey` names a key saved before versions were kept. */
async function digest(sealed: string) {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sealed)),
	).slice(0, 12);
	return Buffer.from(bytes).toString("hex");
}

const keyRow = (workspaceId: string) =>
	mail.db
		.prepare("SELECT sealed, version FROM provider_key WHERE organization_id = ?")
		.bind(workspaceId)
		.first<{ sealed: string; version: string | null }>();

const secretsLogs = () =>
	mail.logs
		.filter((log) => log.message.startsWith("secrets: "))
		.map((log) => JSON.parse(log.message.slice("secrets: ".length)) as Record<string, number>);

describe("a changed SECRETS_KEY", () => {
	it("has the daily run seal workspaces' secrets again under the new key, keeping each key's version", async () => {
		const place = "provider-keys/resend";
		const one = await seal(OLD, "one", place, "re_one");
		// From before keys had ids: the same value, without the key's.
		const [, , iv, data] = (await seal(OLD, "two", place, "re_two")).split(".");
		const two = `v1.${iv}.${data}`;
		// Under a key the deployment never had: it can't be opened, so it is left.
		const three = await seal(OTHER, "three", place, "re_three");
		// Saved again by code that doesn't know versions, as after a rollback: its version is another
		// saving's, so the digest names it.
		const four = await seal(OLD, "four", place, "re_four");
		const hook = await seal(OLD, "one", "resend-inbound/signing-secret", "whsec_one");
		const now = Date.now();
		await mail.db.batch([
			mail.db
				.prepare(
					"INSERT INTO provider_key (organization_id, provider, sealed, version, hint, added_at) VALUES ('one', 'resend', ?1, NULL, '_one', ?2), ('two', 'resend', ?3, ?5, '_two', ?2), ('three', 'resend', ?4, NULL, 'hree', ?2), ('four', 'resend', ?6, ?7, 'four', ?2)",
				)
				.bind(one, now, two, three, `${now}.kept`, four, `${now - 1000}.before`),
			mail.db
				.prepare(
					"INSERT INTO resend_inbound (organization_id, channel, webhook_id, sealed_secret, created_at) VALUES ('one', ?1, 'wh_1', ?2, ?3)",
				)
				.bind(randomBytes(16).toString("hex"), hook, now),
		]);

		await mail.runScheduled(1);

		const after = {
			one: await keyRow("one"),
			two: await keyRow("two"),
			three: await keyRow("three"),
			four: await keyRow("four"),
		};
		expect(await open(NEW, "one", place, after.one?.sealed ?? "")).toBe("re_one");
		expect(await open(NEW, "two", place, after.two?.sealed ?? "")).toBe("re_two");
		// A send that may have gone is tried again only with the same version of the key.
		expect(after.one?.version).toBe(`${now}.${await digest(one)}`);
		expect(after.two?.version).toBe(`${now}.kept`);
		expect(after.three).toEqual({ sealed: three, version: null });
		expect(after.four?.version).toBe(`${now}.${await digest(four)}`);
		const inbound = await mail.db
			.prepare("SELECT sealed_secret AS sealed FROM resend_inbound WHERE organization_id = 'one'")
			.first<{ sealed: string }>();
		expect(await open(NEW, "one", "resend-inbound/signing-secret", inbound?.sealed ?? "")).toBe(
			"whsec_one",
		);
		// Once the previous key is gone, only what wasn't sealed again is lost.
		await expect(open(OLD, "one", place, after.one?.sealed ?? "")).rejects.toThrow();
		expect(secretsLogs().at(-1)).toEqual({ resealed: 4, unopened: 1, left: 1 });

		// The next run has nothing more it can do, and still says one is left.
		await mail.runScheduled(1);
		expect(secretsLogs().at(-1)).toEqual({ resealed: 0, unopened: 1, left: 1 });
		expect((await keyRow("one"))?.sealed).toBe(after.one?.sealed);
	});

	it("isn't held up by more values that don't open than one run seals", async () => {
		const place = "provider-keys/resend";
		const now = Date.now();
		const stuck = Array.from({ length: 501 }, (_, n) => `stuck-${String(n).padStart(3, "0")}`);
		const sealed = await Promise.all(stuck.map((id) => seal(OTHER, id, place, `re_${id}`)));
		await mail.db.batch(
			stuck.flatMap((id, n) => [
				mail.db
					.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?1, ?1, ?1, ?2)")
					.bind(id, now),
				mail.db
					.prepare(
						"INSERT INTO provider_key (organization_id, provider, sealed, hint, added_at) VALUES (?1, 'resend', ?2, 'tuck', ?3)",
					)
					.bind(id, sealed[n], now),
			]),
		);
		// Written after them, and named after them, so it is read last.
		await mail.db.batch([
			mail.db
				.prepare(
					"INSERT INTO organization (id, name, slug, created_at) VALUES ('zz', 'zz', 'zz', ?1)",
				)
				.bind(now),
			mail.db
				.prepare(
					"INSERT INTO provider_key (organization_id, provider, sealed, hint, added_at) VALUES ('zz', 'resend', ?1, '_zz_', ?2)",
				)
				.bind(await seal(OLD, "zz", place, "re_zz"), now),
		]);

		await mail.runScheduled(1);

		expect(await open(NEW, "zz", place, (await keyRow("zz"))?.sealed ?? "")).toBe("re_zz");
		expect(secretsLogs().at(-1)).toEqual({ resealed: 1, unopened: 502, left: 502 });
	});
});
