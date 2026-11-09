import { Marked, type Token } from "marked";

/*
 * What a person writes in the composer is text, with the marks mail has long used for emphasis and
 * that Markdown grew from: **bold**, *italic*, [links](https://…), lists and > quotes. The text goes
 * as it was written, and when it uses any of these, HTML made from it goes beside it. Nothing else
 * of Markdown is read: no headings, code, tables, rules or HTML, so a line that only looks like one
 * stays as it was typed.
 *
 * A quote holds someone else's words, as a reply's does, so nothing in it is read as a mark: its
 * lines go as they were, or a link in them could say one address and go to another under the
 * workspace's name.
 */

const off = () => undefined;

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** A link's address as it may go: the web or mail, or a bare host, which is taken as the web. */
function linkable(href: string): string | null {
	if (/^(?:https?:\/\/|mailto:)\S+$/i.test(href)) return href;
	if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i.test(href)) return `https://${href}`;
	return null;
}

/** Where an address goes, to compare a link's words with it: a web host, or a mail address. */
function placeOf(address: string): string | null {
	try {
		const url = new URL(address);
		return (url.protocol === "mailto:" ? url.pathname : url.host).toLowerCase();
	} catch {
		return null;
	}
}

const markdown = new Marked({
	gfm: true,
	// A line break is a line break, as in any mail, not a space as in Markdown.
	breaks: true,
	tokenizer: {
		code: off,
		fences: off,
		heading: off,
		lheading: off,
		hr: off,
		html: off,
		def: off,
		table: off,
		tag: off,
		reflink: off,
		codespan: off,
		del: off,
	},
	renderer: {
		link({ href, raw, text, tokens }) {
			const target = linkable(href);
			// An address that can't go as a link stays as it was typed rather than being lost, and so
			// does a link whose words read as an address other than its own.
			const shown = linkable(text.trim());
			if (target === null || (shown !== null && placeOf(shown) !== placeOf(target))) {
				return escapeHtml(raw);
			}
			return `<a href="${escapeHtml(target)}">${this.parser.parseInline(tokens)}</a>`;
		},
		// An image would load from wherever its address says once the mail is read.
		image({ raw }) {
			return escapeHtml(raw);
		},
		// A task list's box is a form control, which mail doesn't carry: it stays as typed.
		checkbox({ checked }) {
			return checked ? "[x] " : "[ ] ";
		},
	},
});

/**
 * Lines that would end the paragraph above them though their kind of block is turned off: what
 * looks like a heading, a rule, a code fence, HTML or a table. They are escaped to stay lines.
 */
const LOOKS_LIKE_BLOCK =
	/^([ \t]*)(?=#{1,6}(?:[ \t]|$)|`{3}|~{3}|(?:[-*_][ \t]*){3,}$|=+[ \t]*$|<|\|)/;

/** A numbered line, which starts a list unless it is escaped. */
const NUMBERED = /^([ \t]*\d{1,9})([.)])(?=[ \t]|$)/;

/** A line that is an item of a list. */
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * The text as Markdown should read it to keep it as typed. A long run of `*` or `_` is escaped,
 * which is also what keeps Markdown's emphasis from taking time that grows with its square. A
 * numbered line starts a list only from 1 or after another numbered line, so that "9. November"
 * stays a date. A line that doesn't start with a space ends the list above it, where Markdown
 * would add it to the last item.
 */
function guarded(lines: string[]): string {
	let numbered = false;
	let listing = false;
	let blank = false;
	return lines
		.map((typed) => {
			let line = typed
				.replace(/[*_]{4,}/g, (run) => run.replace(/./g, "\\$&"))
				.replace(LOOKS_LIKE_BLOCK, "$1\\");
			const number = NUMBERED.exec(line);
			if (number !== null && !numbered && Number(number[1]) !== 1) {
				line = line.replace(NUMBERED, "$1\\$2");
			}
			if (!line.trim()) {
				blank = true;
				return line;
			}
			const item = LIST_ITEM.test(line);
			const indented = /^[ \t]/.test(line);
			const ends = listing && !blank && !item && !indented;
			// An item's own further lines are indented, and the list goes on after them.
			if (!listing || item || !indented) numbered = number !== null;
			if (item) listing = true;
			else if (!indented) listing = false;
			blank = false;
			return ends ? `\n${line}` : line;
		})
		.join("\n");
}

/** Text that is formatted beyond this is sent as it is, so that writing it never takes long. */
const MAX_FORMATTED = 20_000;

/** Quotes inside quotes deeper than this are kept as their lines, `>` and all. */
const MAX_QUOTE_DEPTH = 10;

const QUOTE_LINE = /^[ \t]{0,3}>/;

/** Lines as they were typed: paragraphs at blank lines, each line kept, and its spaces. */
function plain(lines: string[]): string {
	const paragraphs: string[][] = [[]];
	for (const line of lines) {
		if (line.trim()) paragraphs[paragraphs.length - 1]?.push(line);
		else if (paragraphs[paragraphs.length - 1]?.length) paragraphs.push([]);
	}
	return paragraphs
		.filter((paragraph) => paragraph.length > 0)
		.map(
			(paragraph) =>
				`<p>${paragraph.map((line) => escapeHtml(line).replace(/ (?= )/g, "&nbsp;")).join("<br>")}</p>\n`,
		)
		.join("");
}

/** Lines in runs: those of a quote, and the rest. */
function runs(lines: string[]): { quote: boolean; lines: string[] }[] {
	const found: { quote: boolean; lines: string[] }[] = [];
	for (const line of lines) {
		const quote = QUOTE_LINE.test(line);
		const last = found[found.length - 1];
		if (last && last.quote === quote) last.lines.push(line);
		else found.push({ quote, lines: [line] });
	}
	return found;
}

/** A quote, and the quotes in it, with every line as it was. */
function quoted(lines: string[], depth: number): string {
	const inner = lines.map((line) => line.replace(/^[ \t]{0,3}> ?/, ""));
	const body =
		depth >= MAX_QUOTE_DEPTH
			? plain(inner)
			: runs(inner)
					.map((run) => (run.quote ? quoted(run.lines, depth + 1) : plain(run.lines)))
					.join("");
	return `<blockquote>\n${body}</blockquote>\n`;
}

/** The marks that make a message formatted. A bare address is linked by mail programs anyway. */
const FORMATTING = new Set(["strong", "em", "list"]);

/** The person's own lines as HTML, and whether they use any formatting. */
function marked(lines: string[]): { html: string; formatting: boolean } {
	try {
		const tokens = markdown.lexer(guarded(lines));
		let formatting = false;
		markdown.walkTokens(tokens, (token: Token) => {
			if (FORMATTING.has(token.type) || (token.type === "link" && token.raw.startsWith("["))) {
				formatting = true;
			}
		});
		return { html: markdown.parser(tokens), formatting };
	} catch {
		// Marks nested deeper than the parser can follow: the lines go as they are.
		return { html: plain(lines), formatting: false };
	}
}

/** The text as HTML, and whether it uses any formatting. */
export function formatted(text: string): { html: string; formatting: boolean } {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (text.length > MAX_FORMATTED) return { html: plain(lines), formatting: false };
	let html = "";
	let formatting = false;
	for (const run of runs(lines)) {
		if (run.quote) {
			html += quoted(run.lines, 1);
			formatting = true;
		} else {
			const own = marked(run.lines);
			html += own.html;
			formatting ||= own.formatting;
		}
	}
	return { html, formatting };
}

/** The HTML to send beside this text, or null when it uses no formatting and goes as text alone. */
export function htmlOfText(text: string): string | null {
	const { html, formatting } = formatted(text);
	return formatting ? html : null;
}

/**
 * A change to the text: what replaces the characters from `from` to `to`, and what is selected
 * after it, counted in the changed text.
 */
export interface TextEdit {
	from: number;
	to: number;
	insert: string;
	selectFrom: number;
	selectTo: number;
}

/** How many of this character run back from `at`. */
function runBack(value: string, at: number, character: string): number {
	let count = 0;
	while (at - count > 0 && value[at - count - 1] === character) count++;
	return count;
}

/** How many of this character run on from `at`. */
function runOn(value: string, at: number, character: string): number {
	let count = 0;
	while (value[at + count] === character) count++;
	return count;
}

/** The selection's spaces at each end, which marks leave outside, and the words between them. */
function trimmed(selected: string): { lead: string; core: string; trail: string } {
	const lead = /^\s*/.exec(selected)?.[0] ?? "";
	const core = selected.slice(lead.length).trimEnd();
	return { lead, core, trail: selected.slice(lead.length + core.length) };
}

/**
 * Makes the selection bold (`**`, two stars) or italic (`*`, one, which works inside a word too),
 * or takes that off when it has it: three stars are both. With nothing selected, the marks go in
 * with the caret between them.
 */
export function toggleEmphasis(value: string, start: number, end: number, stars: 1 | 2): TextEdit {
	const has = (count: number) => count === stars || count === 3;
	const selected = value.slice(start, end);
	const inside = runOn(selected, 0, "*");
	if (
		inside < selected.length &&
		inside === runBack(selected, selected.length, "*") &&
		has(inside)
	) {
		const inner = selected.slice(stars, -stars);
		return {
			from: start,
			to: end,
			insert: inner,
			selectFrom: start,
			selectTo: start + inner.length,
		};
	}
	const before = runBack(value, start, "*");
	if (before === runOn(value, end, "*") && has(before)) {
		return {
			from: start - stars,
			to: end + stars,
			insert: selected,
			selectFrom: start - stars,
			selectTo: end - stars,
		};
	}
	const mark = "*".repeat(stars);
	const { lead, core, trail } = trimmed(selected);
	const at = start + lead.length + stars;
	return {
		from: start,
		to: end,
		insert: `${lead}${mark}${core}${mark}${trail}`,
		selectFrom: at,
		selectTo: at + core.length,
	};
}

/** The placeholder a new link's address starts as, selected so that what is typed replaces it. */
export const LINK_PLACEHOLDER = "https://";

/**
 * Makes the selection a link. An address selected becomes the link's address and words; other
 * words keep theirs and wait for an address.
 */
export function insertLink(value: string, start: number, end: number): TextEdit {
	const { lead, core, trail } = trimmed(value.slice(start, end));
	const at = start + lead.length;
	if (core && linkable(core) !== null) {
		return {
			from: start,
			to: end,
			insert: `${lead}[${core}](${core})${trail}`,
			selectFrom: at + 1,
			selectTo: at + 1 + core.length,
		};
	}
	const words = core.replace(/[[\]]/g, "");
	const address = at + words.length + 3;
	return {
		from: start,
		to: end,
		insert: `${lead}[${words}](${LINK_PLACEHOLDER})${trail}`,
		selectFrom: words ? address : at + 1,
		selectTo: words ? address + LINK_PLACEHOLDER.length : at + 1,
	};
}

export type LineKind = "bullet" | "number" | "quote";

const LINE_MARK: Record<LineKind, RegExp> = {
	bullet: /^[-*+] /,
	number: /^\d+[.)] /,
	quote: /^> ?/,
};

/**
 * Makes the lines the selection touches a list or a quote, or plain lines again when they all are
 * one already. Blank lines stay out of a list but in a quote, which they would otherwise end. With
 * only a caret, it stays where it was in its line.
 */
export function toggleLines(value: string, start: number, end: number, kind: LineKind): TextEdit {
	const from = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
	// A selection that ends at a line's start doesn't take that line.
	const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
	const next = value.indexOf("\n", last);
	const to = next === -1 ? value.length : next;
	const lines = value.slice(from, to).split("\n");
	const mark = LINE_MARK[kind];
	const counted = kind === "quote" ? lines : lines.filter((line) => line.trim());
	const has = counted.length > 0 && counted.every((line) => mark.test(line));
	// A blank line alone gets its mark, to write after.
	const blank = lines.every((line) => !line.trim());
	let number = 0;
	const changed = lines.map((line) => {
		if (has) return line.replace(mark, "");
		if (kind === "quote") return line || lines.length === 1 ? `> ${line}` : ">";
		if (!line.trim() && !blank) return line;
		const plainLine = line.replace(LINE_MARK.bullet, "").replace(LINE_MARK.number, "");
		number++;
		return kind === "bullet" ? `- ${plainLine}` : `${number}. ${plainLine}`;
	});
	const insert = changed.join("\n");
	if (start === end) {
		const caret = Math.min(
			Math.max(start + insert.length - (to - from), from),
			from + insert.length,
		);
		return { from, to, insert, selectFrom: caret, selectTo: caret };
	}
	return { from, to, insert, selectFrom: from, selectTo: from + insert.length };
}
