import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RawMail, SealError } from "./sealed";
import {
	ftsQuery,
	MAX_QUERY_WORDS,
	MAX_SEARCHED_HEADER,
	MAX_SEARCHED_NAMES,
	MAX_SEARCHED_TEXT,
	searchable,
} from "./search";

describe("ftsQuery", () => {
	it("quotes each word, and lets the last be the start of one", () => {
		expect(ftsQuery("invoice  shipp")).toBe('"invoice" "shipp"*');
	});

	it("lets the last word find longer ones only when it is long enough", () => {
		expect(ftsQuery("invoice a")).toBe('"invoice" "a"');
		expect(ftsQuery("会")).toBe('"会"');
		expect(ftsQuery("会議")).toBe('"会議"*');
		// FTS5 takes the prefix from the word's last token, here a single letter or none.
		expect(ftsQuery("a.")).toBe('"a."');
		expect(ftsQuery("t-")).toBe('"t-"');
		expect(ftsQuery("ab.c")).toBe('"ab.c"');
		expect(ftsQuery("x-ab")).toBe('"x-ab"*');
	});

	it("parts words at control characters", () => {
		expect(ftsQuery("a\u0000b")).toBe('"a" "b"');
		expect(ftsQuery("invoice\u0000")).toBe('"invoice"*');
		expect(ftsQuery("\u0000\u0007")).toBeNull();
	});

	it("is null when there is nothing to look for", () => {
		expect(ftsQuery("")).toBeNull();
		expect(ftsQuery("   ")).toBeNull();
		expect(ftsQuery(' - "" * ')).toBeNull();
	});

	it("takes at most a few words", () => {
		const words = Array.from({ length: MAX_QUERY_WORDS + 5 }, (_, n) => `w${n}`).join(" ");
		expect(ftsQuery(words)?.split(" ")).toHaveLength(MAX_QUERY_WORDS);
	});

	// What FTS5 would read as syntax is only text, against a table like the mailbox's.
	const db = new DatabaseSync(":memory:");
	db.exec(
		`CREATE VIRTUAL TABLE s USING fts5(subject, sender, attachments, body, content = '',
			contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2')`,
	);
	const add = db.prepare(
		"INSERT INTO s (rowid, subject, sender, attachments, body) VALUES (?, ?, ?, ?, ?)",
	);
	add.run(1, "Invoice 42", "Shop <orders@example.org>", "invoice-42.pdf", "It has shipped. Café.");
	add.run(2, "Lunch", "A Friend <friend@example.net>", "", "Or near the station?");
	const found = (typed: string) => {
		const query = ftsQuery(typed);
		if (query === null) return [];
		return (
			db.prepare("SELECT rowid FROM s WHERE s MATCH ? ORDER BY rowid").all(query) as {
				rowid: number;
			}[]
		).map((row) => row.rowid);
	};

	it("finds what has every word, in any column, without accents mattering", () => {
		expect(found("invoice shipped")).toEqual([1]);
		expect(found("orders@example.org")).toEqual([1]);
		expect(found("invoice-42.pdf")).toEqual([1]);
		expect(found("cafe")).toEqual([1]);
		expect(found("stat")).toEqual([2]);
		expect(found("invoice lunch")).toEqual([]);
	});

	it("takes FTS5's syntax as words to look for", () => {
		for (const typed of [
			"invoice OR lunch",
			"subject:lunch",
			"NEAR(invoice lunch)",
			'"invoice',
			"invoice*",
			"-invoice",
			"^lunch",
			"{subject}: lunch",
			"a\u0000b",
			"invoice\u0000",
			'"\u0000"',
		]) {
			expect(() => found(typed), typed).not.toThrow();
		}
		expect(found("invoice OR lunch")).toEqual([]);
		expect(found("or near")).toEqual([2]);
		expect(found("subject:lunch")).toEqual([]);
	});
});

describe("searchable", () => {
	/** Raw mail that holds one message's, kept as it came. */
	const holding = (raw: string) =>
		new RawMail(
			{
				get: async () => ({ size: raw.length, body: new Blob([raw]).stream() }),
			} as unknown as R2Bucket,
			undefined,
		);

	it("makes look-alike forms plain, so that plain words and pasted ones both find them", async () => {
		const raw = [
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"ｶﾀｶﾅ and the ﬁnance report for ２０２６",
			"",
		].join("\r\n");
		const found = await searchable(holding(raw), {
			object: "w/m/x.eml",
			size: raw.length,
			seal: null,
			subject: "=?UTF-8?B?77yp772O772W772P772J772D772F?=",
			from: "Ｓｈｏｐ <shop@example.org>",
		});
		expect(found).toEqual({
			subject: "Invoice",
			sender: "Shop <shop@example.org>",
			attachments: "",
			body: "カタカナ and the finance report for 2026\n",
		});

		const db = new DatabaseSync(":memory:");
		db.exec(
			"CREATE VIRTUAL TABLE s USING fts5(subject, sender, attachments, body, tokenize = 'unicode61 remove_diacritics 2')",
		);
		db.prepare(
			"INSERT INTO s (rowid, subject, sender, attachments, body) VALUES (1, ?, ?, ?, ?)",
		).run(found.subject, found.sender, found.attachments, found.body);
		for (const typed of [
			"invoice",
			"Ｉｎｖｏｉｃｅ",
			"finance",
			"ﬁnance",
			"2026",
			"ｶﾀｶﾅ",
			"カタカナ",
		]) {
			const query = ftsQuery(typed) ?? "";
			expect(db.prepare("SELECT rowid FROM s WHERE s MATCH ?").all(query), typed).toHaveLength(1);
		}
	});

	it("keeps to its cap on text once look-alike forms are made plain", async () => {
		// NFKC makes this one character eighteen.
		const raw = [
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"ﷺ".repeat(MAX_SEARCHED_TEXT),
		].join("\r\n");
		const found = await searchable(holding(raw), {
			object: "w/m/x.eml",
			size: raw.length,
			seal: null,
			subject: null,
			from: null,
		});
		expect(found.body).toHaveLength(MAX_SEARCHED_TEXT);
	});

	it("keeps to its caps on headers and attachments' names once they are plain", async () => {
		// Each of these names NFKC makes 18,000 characters long.
		const name = "ﷺ".repeat(1000);
		const parts = Array.from({ length: 30 }, (_, n) => [
			"--b1",
			"Content-Type: application/octet-stream",
			`Content-Disposition: attachment; filename="${name}${n}"`,
			"",
			"x",
		]).flat();
		const raw = [
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b1"',
			"",
			"--b1",
			"Content-Type: text/plain",
			"",
			"hi",
			...parts,
			"--b1--",
		].join("\r\n");
		const found = await searchable(holding(raw), {
			object: "w/m/x.eml",
			size: raw.length,
			seal: null,
			subject: name,
			from: `${name} <a@example.org>`,
		});
		expect(found.attachments).toHaveLength(MAX_SEARCHED_NAMES);
		expect(found.subject).toHaveLength(MAX_SEARCHED_HEADER);
		expect(found.sender).toHaveLength(MAX_SEARCHED_HEADER);
	});

	it("throws when R2 can't give it the mail, rather than index the message without it", async () => {
		const found = await searchable(
			new RawMail(
				{
					get: async () => {
						throw new TypeError("not mail");
					},
				} as unknown as R2Bucket,
				undefined,
			),
			{ object: "w/m/x.eml", size: 10, seal: null, subject: "Lunch", from: "a@example.org" },
		).catch((error: unknown) => error);
		// Unlike mail that doesn't parse: the mailbox tries it again later.
		expect(found).toBeInstanceOf(TypeError);
	});

	describe("of sealed mail that doesn't open", () => {
		const sealed = {
			object: "w/m/x.eml",
			size: 10,
			seal: "v1.AAAAAAAAAAAAAAAAAAAAAA",
			subject: "Lunch",
			from: "a@example.org",
		};
		// As long as the sealed mail would be, and not it.
		const changed = {
			get: async () => ({ size: 26, body: new Blob([new Uint8Array(26)]).stream() }),
		} as unknown as R2Bucket;

		it("finds it by its headers under the server's key, as trying again won't open it", async () => {
			const found = await searchable(
				new RawMail(changed, randomBytes(32).toString("base64")),
				sealed,
			);
			expect(found).toEqual({
				subject: "Lunch",
				sender: "a@example.org",
				attachments: "",
				body: "",
			});
		});

		it("throws without a key, for the mailbox to try again once one is set", async () => {
			const found = await searchable(new RawMail(changed, undefined), sealed).catch(
				(error: unknown) => error,
			);
			expect(found).toBeInstanceOf(SealError);
		});
	});
});
