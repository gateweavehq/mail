import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWorld } from "./agent-world";

// Gateweave Backup reaches the app through its named Backup entrypoint, from a Worker with a
// service binding to it: it lists the workspaces' webhooks and mailboxes, then reads each object
// with the SELECTs of a SQLite dump, which the object rolls back.

const origin = "https://mail.test";
const RECEIVER = "hooks.example";

const world = agentWorld(origin, "backup");

beforeAll(() => world.start({ [RECEIVER]: () => new Response("ok") }));
afterAll(() => world.dispose());

type Listed = { names: string[]; cursor?: string };
type Rows = Record<string, unknown>[][];

const read = (name: string, statements: unknown) =>
	world.mail.backup<Rows>("read", name, statements);

/** Every name `objects` lists, page by page, and how many pages that took. */
async function listAll() {
	const names: string[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await world.mail.backup<Listed>(
			"objects",
			...(cursor === undefined ? [] : [cursor]),
		);
		if (!page.result) throw new Error(page.error);
		names.push(...page.result.names);
		cursor = page.result.cursor;
		pages++;
	} while (cursor !== undefined);
	return { names, pages };
}

async function addWebhook(slug: string, path: string) {
	const response = await world.mail.fetch(`${origin}/api/webhooks/${slug}`, {
		method: "POST",
		headers: { ...world.owner.headers, origin, "content-type": "application/json" },
		body: JSON.stringify({
			action: "create",
			input: { url: `https://${RECEIVER}${path}`, events: ["message.received"], mailboxIds: null },
		}),
	});
	expect(response.status).toBe(200);
}

const count = async (name: string, table: string) =>
	(await read(name, [`SELECT count(*) AS n FROM ${table}`])).result?.[0]?.[0]?.n;

describe("the Backup entrypoint", () => {
	it("reads a mailbox with mail in it, as it is stored", async () => {
		const space = await world.workspace();
		await world.arrive(space.signUps.address, { subject: "Kept in the backup" });
		const name = `mailbox.${space.signUps.id}`;

		const dump = await read(name, [
			"SELECT type, name FROM sqlite_master WHERE name = 'message'",
			"PRAGMA table_list",
			"SELECT quote(subject) AS v, state FROM message",
			"PRAGMA table_info(message)",
		]);
		const [schema, tables, messages, columns] = dump.result ?? [];
		expect(schema).toEqual([{ type: "table", name: "message" }]);
		expect(tables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "message" })]));
		expect(messages).toEqual([{ v: "'Kept in the backup'", state: "stored" }]);
		expect(columns).toEqual(expect.arrayContaining([expect.objectContaining({ name: "subject" })]));
		// The mailbox next door is its own object.
		expect(await count(`mailbox.${space.billing.id}`, "message")).toBe(0);
	});

	it("reads a workspace's webhooks, secrets as they are kept", async () => {
		const space = await world.workspace();
		await addWebhook(space.slug, "/backed-up");
		const dump = await read(`webhooks.${space.workspaceId}`, [
			"SELECT url, active FROM webhook",
			"SELECT substr(secret, 1, 6) AS start FROM webhook",
		]);
		expect(dump.result).toEqual([
			[{ url: `https://${RECEIVER}/backed-up`, active: 1 }],
			[{ start: "whsec_" }],
		]);
	});

	it("lists a workspace's webhooks, then its mailboxes, 20 workspaces to a page", async () => {
		const space = await world.workspace();
		const ids = Array.from({ length: 45 }, (_, i) => `paged-${String(i).padStart(3, "0")}`);
		const { db } = world.mail;
		await db.batch([
			...ids.map((id) =>
				db
					.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, 0)")
					.bind(id, id, id),
			),
			// Two mailboxes for one of them, to see where they are listed.
			...["b", "a"].map((box) =>
				db
					.prepare("INSERT INTO mailbox (id, organization_id, name) VALUES (?, ?, ?)")
					.bind(`paged-box-${box}`, "paged-007", box),
			),
		]);

		const { names, pages } = await listAll();
		expect(pages).toBeGreaterThan(2);
		expect(new Set(names).size).toBe(names.length);
		const workspaces = names.filter((name) => name.startsWith("webhooks."));
		expect(workspaces).toEqual([...workspaces].sort());
		expect(workspaces).toEqual(expect.arrayContaining(ids.map((id) => `webhooks.${id}`)));
		const at = names.indexOf("webhooks.paged-007");
		expect(names.slice(at, at + 3)).toEqual([
			"webhooks.paged-007",
			"mailbox.paged-box-a",
			"mailbox.paged-box-b",
		]);
		expect(names).toEqual(
			expect.arrayContaining([
				`webhooks.${space.workspaceId}`,
				`mailbox.${space.signUps.id}`,
				`mailbox.${space.billing.id}`,
			]),
		);
		// A page holds 20 workspaces, whatever their mailboxes make of it.
		const first = await world.mail.backup<Listed>("objects");
		expect(first.result?.names.filter((name) => name.startsWith("webhooks."))).toHaveLength(20);
	});

	it("refuses anything but a read, and says why without saying what it was sent", async () => {
		const space = await world.workspace();
		await world.arrive(space.signUps.address, { subject: "Stays" });
		const name = `mailbox.${space.signUps.id}`;
		const refused: [string, unknown][] = [
			["a write", ["DELETE FROM message"]],
			["an update", ["UPDATE message SET subject = 'x'"]],
			["a schema change", ["DROP TABLE message"]],
			["a temporary table", ["CREATE TEMP TABLE leak AS SELECT * FROM message"]],
			["a PRAGMA that sets", ["PRAGMA writable_schema = 1"]],
			["a PRAGMA that isn't a table's", ["PRAGMA foreign_keys"]],
			["two statements in one", ["SELECT 1; DELETE FROM message"]],
			["a write behind a CTE", ["WITH t AS (SELECT 1) DELETE FROM message"]],
			["an empty list", []],
			["no list", "SELECT 1"],
			["more than 1000 statements", Array.from({ length: 1001 }, () => "SELECT 1")],
			["a statement over 100 kB", [`SELECT '${"x".repeat(100_001)}'`]],
		];
		for (const [what, statements] of refused) {
			const answer = await read(name, statements);
			expect(answer.error, what).toMatch(/^The object refused the backup's read\. [A-Z]/);
			expect(answer.error, what).not.toMatch(/DELETE|UPDATE|DROP|TEMP|writable_schema|xxxx/);
		}
		// The same goes for webhooks.
		const webhooks = await read(`webhooks.${space.workspaceId}`, ["DELETE FROM webhook"]);
		expect(webhooks.error).toMatch(/^The object refused the backup's read\. /);
		expect(await count(name, "message")).toBe(1);
	});

	it("changes nothing by reading", async () => {
		const space = await world.workspace();
		await world.arrive(space.signUps.address);
		await addWebhook(space.slug, "/unchanged");
		const mailbox = `mailbox.${space.signUps.id}`;
		const webhooks = `webhooks.${space.workspaceId}`;
		const everything = (name: string, table: string) =>
			read(name, ["SELECT * FROM sqlite_master ORDER BY name", `SELECT * FROM ${table}`]);
		const before = [await everything(mailbox, "message"), await everything(webhooks, "webhook")];
		for (let i = 0; i < 3; i++) {
			await read(mailbox, ["SELECT * FROM message", "SELECT * FROM held"]);
			await read(webhooks, ["SELECT * FROM webhook"]);
		}
		expect([await everything(mailbox, "message"), await everything(webhooks, "webhook")]).toEqual(
			before,
		);
	});

	it("answers null for what isn't an object, before reaching any", async () => {
		const space = await world.workspace();
		const stranger = crypto.randomUUID();
		const names = [
			"",
			stranger,
			`mailbox.${stranger}`,
			`webhooks.${stranger}`,
			// Another form of a name that exists.
			space.signUps.id,
			`mailbox.${space.workspaceId}`,
			`webhooks.${space.signUps.id}`,
			`Mailbox.${space.signUps.id}`,
			`mailbox.${space.signUps.id}.extra`,
			`mailbox..${space.signUps.id}`,
			`mailbox.${space.signUps.id}.`,
			`mailbox/${space.signUps.id}`,
			`mailbox.${space.signUps.id}/../x`,
			`mailbox.${"a".repeat(65)}`,
			"rate-limiter.127.0.0.1",
			"mailbox",
			"webhooks.",
		];
		for (const name of names) {
			expect(await read(name, ["SELECT 1 AS one"]), JSON.stringify(name)).toEqual({ result: null });
		}
		// Even a refused read of a name that isn't there answers null: the name is checked first.
		expect(await read(`mailbox.${stranger}`, ["DELETE FROM message"])).toEqual({ result: null });
	});

	it("answers null for a mailbox that was removed, and stops listing it", async () => {
		const space = await world.workspace();
		await world.arrive(space.billing.address);
		const name = `mailbox.${space.billing.id}`;
		expect(await count(name, "message")).toBe(1);
		expect((await listAll()).names).toContain(name);

		const removed = await world.directory(space.slug, {
			action: "remove-mailbox",
			id: space.billing.id,
		});
		expect(removed.ok).toBe(true);
		expect(await read(name, ["SELECT 1 AS one"])).toEqual({ result: null });
		const { names } = await listAll();
		expect(names).not.toContain(name);
		expect(names).toContain(`mailbox.${space.signUps.id}`);
	});

	it("answers null for a workspace that was deleted", async () => {
		const space = await world.workspace();
		const name = `webhooks.${space.workspaceId}`;
		expect((await read(name, ["SELECT 1 AS one"])).result).toEqual([[{ one: 1 }]]);
		await world.mail.db
			.prepare("DELETE FROM organization WHERE id = ?")
			.bind(space.workspaceId)
			.run();
		expect(await read(name, ["SELECT 1 AS one"])).toEqual({ result: null });
		expect((await listAll()).names).not.toContain(name);
	});
});
