import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HEADER_BLOCK_LIMIT, parseHeaders, readHeaderSection } from "./headers";
import { LINKED_THREADS, MIGRATIONS, migrate } from "./schema";
import { checkOldSenders, indexedSender, nextSenderCheck, pendingSenders } from "./sender-index";
import { nodeStorage as storage } from "./testing";

const names = (db: DatabaseSync, type: string) =>
	(
		db
			.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
			.all(type) as { name: string }[]
	)
		.map((row) => row.name)
		.sort();

describe("migrate", () => {
	it("brings a new object to the latest version, and does nothing the second time", () => {
		const { db, storage: store } = storage();
		migrate(store);
		migrate(store);
		expect(names(db, "table")).toEqual([
			"delivery",
			"event",
			"held",
			"message",
			"message_reference",
			// The search index, and the tables FTS5 keeps it in.
			"message_search",
			"message_search_config",
			"message_search_data",
			"message_search_docsize",
			"message_search_idx",
			"outgoing",
			"place",
			"schema_migration",
			"thread",
		]);
		expect(db.prepare("SELECT version FROM schema_migration").all()).toEqual([
			{ version: 1 },
			{ version: 2 },
			{ version: 3 },
			{ version: 4 },
			{ version: 5 },
			{ version: 6 },
			{ version: 7 },
			{ version: 8 },
			{ version: 9 },
			{ version: 10 },
			{ version: 11 },
			{ version: 12 },
			{ version: 13 },
			{ version: 14 },
			{ version: 15 },
			{ version: 16 },
			{ version: 17 },
			{ version: 18 },
			{ version: 19 },
			{ version: 20 },
			{ version: 21 },
		]);
	});

	it("keeps what is being sent when version 5 makes `outgoing` again, and lets mail wait for approval", () => {
		const { db, storage: store } = storage();
		store.transactionSync(() => {
			store.sql.exec("CREATE TABLE schema_migration (version INTEGER PRIMARY KEY) STRICT");
			for (let version = 0; version < 4; version++) {
				MIGRATIONS[version]?.(store.sql);
				store.sql.exec("INSERT INTO schema_migration (version) VALUES (?)", version + 1);
			}
		});
		const sent = (id: string) =>
			db
				.prepare(
					`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
						envelope_to, sent_by)
					VALUES (?, 'stored', ?, ?, 10, 1, 'a@x', 'b@y', 'member')`,
				)
				.run(id, `sent:${id}`, `w/m/${id}.eml`);
		sent("waits");
		db.prepare(
			`INSERT INTO outgoing (message, state, request, attempts, attempted_at, next_at, code, draft)
			VALUES ('waits', 'waiting', '{}', 2, 4, 5, 'E_RATE_LIMIT_EXCEEDED', 'draft-1')`,
		).run();

		migrate(store);
		expect(db.prepare("SELECT * FROM outgoing").all()).toEqual([
			{
				message: "waits",
				state: "waiting",
				request: "{}",
				attempts: 2,
				attempted_at: 4,
				next_at: 5,
				code: "E_RATE_LIMIT_EXCEEDED",
				provider_id: null,
				sent_at: null,
				draft: "draft-1",
				approved_by: null,
				approved_at: null,
				// Version 6's: what was there before goes through Email Service.
				provider: "cloudflare",
				workspace_id: null,
				idempotency_key: null,
				detail: null,
				maybe_sent: 0,
				key_version: null,
				// Version 10's: its copy carries no files.
				files: "[]",
				// Version 16's: which way it goes is decided at its next try.
				direct: null,
			},
		]);
		sent("held");
		db.prepare(
			"INSERT INTO outgoing (message, state, request, draft) VALUES ('held', 'held', '{}', 'draft-2')",
		).run();
		// The draft's index and the trigger are back.
		expect(() =>
			db
				.prepare(
					"INSERT INTO outgoing (message, state, request, draft) VALUES ('x', 'held', '{}', 'draft-1')",
				)
				.run(),
		).toThrow();
		expect(names(db, "index")).toEqual(expect.arrayContaining(["outgoing_draft", "outgoing_due"]));
		db.prepare("DELETE FROM message WHERE id = 'held'").run();
		expect(db.prepare("SELECT message FROM outgoing").all()).toEqual([{ message: "waits" }]);
	});

	it("lets what the mailbox sends go with its message", () => {
		const { db, storage: store } = storage();
		migrate(store);
		db.prepare(
			`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
				envelope_to, sent_by)
			VALUES ('sent', 'stored', 'sent:sent', 'w/m/sent.eml', 10, 1, 'a@x', 'b@y', 'member')`,
		).run();
		db.prepare(
			"INSERT INTO outgoing (message, state, request) VALUES ('sent', 'sent', '{}')",
		).run();
		expect(() =>
			db.prepare("INSERT INTO outgoing (message, state, request) VALUES ('x', 'lost', '{}')").run(),
		).toThrow();
		db.prepare("DELETE FROM message WHERE id = 'sent'").run();
		expect(db.prepare("SELECT count(*) AS n FROM outgoing").get()).toEqual({ n: 0 });
	});

	it("brings an object from before migrations were counted, giving its messages a thread each", () => {
		const { db, storage: store } = storage();
		// What the first version of the object made, with no record of it.
		MIGRATIONS[0]?.(store.sql);
		const insert = db.prepare(
			`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
				envelope_to, subject, message_id)
			VALUES (?, ?, 'key', 'w/m/x.eml', 10, ?, 'a@x', 'b@y', ?, ?)`,
		);
		insert.run("one", "stored", 1, "Re: =?UTF-8?Q?Caf=C3=A9?= plans", "<one@example.org> (sent)");
		insert.run("two", "stored", 2, "Other", null);
		insert.run("three", "pending", 3, "Later", "<three@example.org>");

		migrate(store);

		expect(
			db
				.prepare(
					"SELECT id, thread_id AS threadId, own_id AS ownId, subject_key AS subjectKey FROM message ORDER BY arrived_at",
				)
				.all(),
		).toEqual([
			{ id: "one", threadId: "one", ownId: "one@example.org", subjectKey: "café plans" },
			{ id: "two", threadId: "two", ownId: null, subjectKey: "other" },
			// A pending message gets its thread when it is stored.
			{ id: "three", threadId: null, ownId: "three@example.org", subjectKey: "later" },
		]);
		expect(
			db.prepare("SELECT id, first_at, latest_at, count FROM thread ORDER BY id").all(),
		).toEqual([
			{ id: "one", first_at: 1, latest_at: 1, count: 1 },
			{ id: "two", first_at: 2, latest_at: 2, count: 1 },
		]);
		expect(db.prepare("SELECT bytes FROM held").get()).toEqual({ bytes: 30 });
	});

	it("gives a thread to a message stored without one, as code from before threads does", () => {
		const { db, storage: store } = storage();
		migrate(store);
		// Stored as the first version stores, after a rollback.
		db.prepare(
			`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
				envelope_to)
			VALUES ('loose', 'stored', 'key', 'w/m/x.eml', 10, 5, 'a@x', 'b@y')`,
		).run();

		migrate(store);

		expect(db.prepare("SELECT thread_id AS threadId FROM message").get()).toEqual({
			threadId: "loose",
		});
		expect(db.prepare("SELECT id, first_at, latest_at, count FROM thread").all()).toEqual([
			{ id: "loose", first_at: 5, latest_at: 5, count: 1 },
		]);
	});

	it("finds a message's threads through indexes, not by reading every stored message", () => {
		const { db, storage: store } = storage();
		migrate(store);
		const plan = (
			db.prepare(`EXPLAIN QUERY PLAN ${LINKED_THREADS}`).all("key", "id", "own", "id") as {
				detail: string;
			}[]
		)
			.map((row) => row.detail)
			.join("\n");
		expect(plan).not.toMatch(/message_listed|SCAN message\b/);
		expect(plan).toMatch(/MULTI-INDEX OR/);
	});

	it("deletes a message's entry in the search index with the message", () => {
		const { db, storage: store } = storage();
		migrate(store);
		db.prepare(
			`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
				envelope_to, search_id)
			VALUES ('one', 'stored', 'key', 'w/m/x.eml', 10, 1, 'a@x', 'b@y', 7)`,
		).run();
		db.prepare(
			`INSERT INTO message_search (rowid, subject, sender, attachments, body)
			VALUES (7, 'Lunch', '', '', 'at noon')`,
		).run();
		const found = () =>
			db.prepare("SELECT rowid FROM message_search WHERE message_search MATCH 'noon'").all();
		expect(found()).toHaveLength(1);

		db.prepare("DELETE FROM message WHERE id = 'one'").run();

		expect(found()).toEqual([]);
	});

	it("makes mail kept as it came, from before version 13, wait to be sealed", () => {
		const { db, storage: store } = storage();
		store.transactionSync(() => {
			store.sql.exec("CREATE TABLE schema_migration (version INTEGER PRIMARY KEY) STRICT");
			for (let version = 0; version < 12; version++) {
				MIGRATIONS[version]?.(store.sql);
				store.sql.exec("INSERT INTO schema_migration (version) VALUES (?)", version + 1);
			}
		});
		db.prepare(
			`INSERT INTO message (id, state, delivery_key, object, size, arrived_at, envelope_from,
				envelope_to)
			VALUES ('old', 'stored', 'key', 'w/m/old.eml', 10, 1, 'a@x', 'b@y')`,
		).run();

		migrate(store);

		expect(
			db
				.prepare(
					"SELECT seal, stale_object, stale_at, seal_tries, seal_failed_at FROM message WHERE id = 'old'",
				)
				.all(),
		).toEqual([
			{ seal: null, stale_object: null, stale_at: null, seal_tries: 0, seal_failed_at: null },
		]);
		// The alarm finds such mail, and what it has marked or sealed, by indexes of their own.
		const plan = (
			db
				.prepare(
					`EXPLAIN QUERY PLAN SELECT id FROM message INDEXED BY message_unsealed
					WHERE state = 'stored' AND seal IS NULL AND seal_failed_at IS NULL
					ORDER BY arrived_at DESC, id DESC LIMIT 6`,
				)
				.all() as { detail: string }[]
		)
			.map((row) => row.detail)
			.join(" ");
		expect(plan).toContain("message_unsealed");
		expect(plan).not.toMatch(/TEMP B-TREE/);
	});

	it("indexes the actual From of retained incoming mail when upgrading an existing mailbox", async () => {
		const { db, storage: store } = storage();
		store.sql.exec("CREATE TABLE schema_migration (version INTEGER PRIMARY KEY) STRICT");
		for (let version = 0; version < 17; version++) {
			MIGRATIONS[version]?.(store.sql);
			store.sql.exec("INSERT INTO schema_migration (version) VALUES (?)", version + 1);
		}
		const insert = db.prepare(`INSERT INTO message
			(id, state, delivery_key, object, size, arrived_at, envelope_from, envelope_to, from_header, sent_by)
			VALUES (?, 'stored', 'key', 'mail', 10, 1, 'bounce@other.test', 'me@here.test', ?, ?)`);
		insert.run("a", '"other@example.test" <Alice@Bücher.example.>', null);
		insert.run("b", "Other <outside@example.test>", "member");
		insert.run("c", "a@example.test, b@example.test", null);
		insert.run("d", "Name".padEnd(2000, "d"), null);
		insert.run("e", "from@example.test", null);
		migrate(store);
		expect(nextSenderCheck(store.sql)).toBe(0);
		expect(db.prepare("SELECT id, sender_address FROM message ORDER BY id").all()).toEqual([
			{ id: "a", sender_address: "alice@xn--bcher-kva.example" },
			{ id: "b", sender_address: null },
			{ id: "c", sender_address: null },
			{ id: "d", sender_address: null },
			{ id: "e", sender_address: "from@example.test" },
		]);
		const stream = (header: string) => new Response(`${header}\r\n\r\n`).body;
		const checked = () =>
			db
				.prepare(
					"SELECT sender_address FROM message WHERE sender_check_at IS NULL AND sender_address IS NOT NULL ORDER BY id",
				)
				.all();
		expect(checked()).toEqual([]);
		// Only the clipped one needs background work. A temporary R2 failure schedules a retry.
		await checkOldSenders(store, async () => null, 1);
		expect(nextSenderCheck(store.sql)).toBe(60_001);
		expect(pendingSenders(store.sql, ["somebody@example.test"], 60_001)).toEqual([
			"somebody@example.test",
		]);
		await checkOldSenders(
			store,
			async () => stream(`From: ${"d".repeat(2000)} <clipped@example.test>`),
			60_001,
		);
		expect(nextSenderCheck(store.sql)).toBeNull();
		expect(pendingSenders(store.sql, ["somebody@example.test"], 60_001)).toEqual([]);
		expect(checked()).toEqual([{ sender_address: "clipped@example.test" }]);
		expect(pendingSenders(store.sql, ["from@example.test", "somebody@example.test"])).toEqual([
			"from@example.test",
		]);
		// The listing lost a duplicate From. Its apparent sender must never grant access.
		await checkOldSenders(
			store,
			async () => stream("From: from@example.test\r\nFrom: second@example.test"),
			60_001,
			["from@example.test"],
		);
		expect(checked()).toEqual([{ sender_address: "clipped@example.test" }]);
		await checkOldSenders(
			store,
			async () => stream("From: Alice <alice@xn--bcher-kva.example>"),
			60_001,
			["alice@xn--bcher-kva.example"],
		);
		expect(checked()).toEqual([
			{ sender_address: "alice@xn--bcher-kva.example" },
			{ sender_address: "clipped@example.test" },
		]);
		expect(names(db, "index")).toContain("message_received_from");
	});

	it("keeps a sender pending through read errors and caps the retry wait at an hour", async () => {
		const { db, storage: store } = storage();
		migrate(store);
		const address = "candidate@example.org";
		db.prepare(
			"INSERT INTO message (id,state,delivery_key,object,size,arrived_at,envelope_from,envelope_to,sender_address,sender_check_at) VALUES ('old','stored','key','original',1,1,'from','to',?,0)",
		).run(address);
		let now = 0;
		for (const minutes of [1, 2, 4, 8, 16, 32, 60, 60]) {
			await checkOldSenders(
				store,
				async () => {
					throw new Error("R2 unavailable");
				},
				now,
			);
			now += minutes * 60_000;
			expect(nextSenderCheck(store.sql)).toBe(now);
			expect(pendingSenders(store.sql, [address], now)).toEqual(now < 3_600_000 ? [address] : []);
		}
		await checkOldSenders(store, async () => new Response(`From: ${address}\r\n\r\n`).body, now);
		expect(nextSenderCheck(store.sql)).toBeNull();
		expect(db.prepare("SELECT sender_address, sender_attempts FROM message").get()).toEqual({
			sender_address: address,
			sender_attempts: 0,
		});
	});

	it("schedules no further sender check when the last candidate cannot be opened", async () => {
		const { db, storage: store } = storage();
		migrate(store);
		db.prepare(
			"INSERT INTO message (id,state,delivery_key,object,size,arrived_at,envelope_from,envelope_to,sender_address,sender_check_at) VALUES ('old','stored','key','missing',1,1,'from','to','candidate@example.org',0)",
		).run();
		// A stream can fail after R2 has returned it. Only the following missing objects count.
		await checkOldSenders(
			store,
			async () =>
				new ReadableStream({
					start(controller) {
						controller.error(new Error("Read interrupted"));
					},
				}),
			0,
		);
		for (const now of [60_000, 120_000, 180_000]) {
			expect(nextSenderCheck(store.sql)).toBe(now);
			await checkOldSenders(store, async () => null, now);
		}
		expect(nextSenderCheck(store.sql)).toBeNull();
		expect(pendingSenders(store.sql, ["candidate@example.org"])).toEqual([]);
		expect(db.prepare("SELECT sender_address FROM message").get()).toEqual({
			sender_address: null,
		});
	});

	it("stops holding a sender's sends an hour after the upgrade while a candidate waits behind a failing one", async () => {
		const { db, storage: store } = storage();
		store.sql.exec("CREATE TABLE schema_migration (version INTEGER PRIMARY KEY) STRICT");
		for (let version = 0; version < MIGRATIONS.length - 1; version++) {
			MIGRATIONS[version]?.(store.sql);
			store.sql.exec("INSERT INTO schema_migration (version) VALUES (?)", version + 1);
		}
		const address = "candidate@example.org";
		const insert = db.prepare(
			"INSERT INTO message (id,state,delivery_key,object,size,arrived_at,envelope_from,envelope_to,sender_address,sender_check_at) VALUES (?,'stored','key',?,1,1,'from','to',?,?)",
		);
		// Two old messages name the same candidate: one is tried, the other waits its turn.
		insert.run("tried", "tried", address, 0);
		insert.run("queued", "queued", address, -1);
		const upgraded = Date.now();
		migrate(store);
		// The first keeps failing, so the second is never tried and never gets a start of its own.
		let now = upgraded;
		while (now < upgraded + 61 * 60_000) {
			await checkOldSenders(
				store,
				async () => {
					throw new Error("R2 unavailable");
				},
				now,
			);
			now = nextSenderCheck(store.sql) ?? now + 60_000;
		}
		expect(db.prepare("SELECT id FROM message WHERE sender_check_at = -1").all()).toEqual([
			{ id: "queued" },
		]);
		expect(pendingSenders(store.sql, [address], upgraded + 59 * 60_000)).toEqual([address]);
		expect(pendingSenders(store.sql, [address], upgraded + 61 * 60_000)).toEqual([]);
	});

	it("cannot index a From when the bound could cut its address or hide a second From", async () => {
		const atLimit = (prefix: string, suffix: string) =>
			prefix + "x".repeat(HEADER_BLOCK_LIMIT - prefix.length - suffix.length) + suffix;
		const prefixes = [
			atLimit("X-Pad: ", "\r\nFrom: alice@example.test"),
			atLimit("From: alice@example.test\r\nX-Pad: ", ""),
		];
		for (const prefix of prefixes) {
			const bytes = new TextEncoder().encode(prefix);
			const rest = new TextEncoder().encode(".evil\r\nFrom: other@example.test\r\n\r\n");
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.enqueue(rest);
					controller.close();
				},
			});
			const { block, complete } = await readHeaderSection(stream);
			expect(indexedSender(parseHeaders(block), true)).toBe("alice@example.test");
			expect(indexedSender(parseHeaders(block), complete)).toBeNull();
		}
	});

	it("leaves an object as it was when a migration fails", () => {
		const { db, storage: store } = storage();
		MIGRATIONS[0]?.(store.sql);
		// A column the second version adds, there already, makes it fail part way.
		db.exec("ALTER TABLE message ADD COLUMN own_id TEXT");
		expect(() => migrate(store)).toThrow();
		expect(names(db, "table")).toEqual(["held", "message"]);
	});
});
