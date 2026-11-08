import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ftsQuery, MAX_QUERY_WORDS } from "./search";

describe("ftsQuery", () => {
	it("quotes each word, and lets the last be the start of one", () => {
		expect(ftsQuery("invoice  shipp")).toBe('"invoice" "shipp"*');
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
		]) {
			expect(() => found(typed), typed).not.toThrow();
		}
		expect(found("invoice OR lunch")).toEqual([]);
		expect(found("or near")).toEqual([2]);
		expect(found("subject:lunch")).toEqual([]);
	});
});
