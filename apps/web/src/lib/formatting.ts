import { Marked, type Token } from "marked";

/*
 * What a person writes in the composer is text, with the marks mail has long used for emphasis and
 * that Markdown grew from: **bold**, _italic_, [links](https://…), lists and > quotes. The text goes
 * as it was written, and when it uses any of these, HTML made from it goes beside it. Nothing else
 * of Markdown is read: no headings, code, tables, rules or HTML, so a line that only looks like one
 * stays as it was typed.
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
		link({ href, tokens }) {
			const text = this.parser.parseInline(tokens);
			const target = linkable(href);
			return target === null ? text : `<a href="${escapeHtml(target)}">${text}</a>`;
		},
		// An image would load from wherever its address says once the mail is read, so only its
		// words go.
		image({ text }) {
			return escapeHtml(text);
		},
	},
});

/**
 * Lines that Markdown would read as a heading, a rule or code end the paragraph above them even
 * with those turned off, so they are escaped, inside quotes too, to stay lines of the paragraph.
 */
const LOOKS_LIKE_BLOCK =
	/^((?: {0,3}> ?)*[ \t]{0,3})(?=#{1,6}(?:[ \t]|$)|`{3}|~{3}|(?:[-*_][ \t]*){3,}$|=+[ \t]*$)/;

const guarded = (text: string) =>
	text
		.split("\n")
		.map((line) => line.replace(LOOKS_LIKE_BLOCK, "$1\\"))
		.join("\n");

/** The marks that make a message formatted. A bare address is linked by mail programs anyway. */
const FORMATTING = new Set(["strong", "em", "blockquote", "list"]);

/** The text as HTML, and whether it uses any formatting. */
export function formatted(text: string): { html: string; formatting: boolean } {
	const tokens = markdown.lexer(guarded(text.replace(/\r\n?/g, "\n")));
	let formatting = false;
	markdown.walkTokens(tokens, (token: Token) => {
		if (FORMATTING.has(token.type) || (token.type === "link" && token.raw.startsWith("["))) {
			formatting = true;
		}
	});
	return { html: markdown.parser(tokens), formatting };
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

/**
 * Makes the selection bold or italic with `mark`, or takes the mark off when it has it. With
 * nothing selected, the marks go in with the caret between them.
 */
export function toggleMark(value: string, start: number, end: number, mark: string): TextEdit {
	const selected = value.slice(start, end);
	const size = mark.length;
	if (selected.length >= size * 2 && selected.startsWith(mark) && selected.endsWith(mark)) {
		const inner = selected.slice(size, -size);
		return {
			from: start,
			to: end,
			insert: inner,
			selectFrom: start,
			selectTo: start + inner.length,
		};
	}
	if (value.slice(start - size, start) === mark && value.slice(end, end + size) === mark) {
		return {
			from: start - size,
			to: end + size,
			insert: selected,
			selectFrom: start - size,
			selectTo: end - size,
		};
	}
	// A mark next to a space doesn't count, so the spaces at the selection's ends stay outside.
	const lead = /^\s*/.exec(selected)?.[0] ?? "";
	const core = selected.slice(lead.length).trimEnd();
	const trail = selected.slice(lead.length + core.length);
	const at = start + lead.length + size;
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
	const selected = value.slice(start, end).trim();
	if (selected && linkable(selected) !== null) {
		const insert = `[${selected}](${selected})`;
		return {
			from: start,
			to: end,
			insert,
			selectFrom: start + 1,
			selectTo: start + 1 + selected.length,
		};
	}
	const words = selected.replace(/[[\]]/g, "");
	const at = start + words.length + 3;
	return {
		from: start,
		to: end,
		insert: `[${words}](${LINK_PLACEHOLDER})`,
		selectFrom: words ? at : start + 1,
		selectTo: words ? at + LINK_PLACEHOLDER.length : start + 1,
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
 * one already. Blank lines stay out of a list but in a quote, which they would otherwise end.
 */
export function toggleLines(value: string, start: number, end: number, kind: LineKind): TextEdit {
	const from = value.lastIndexOf("\n", start - 1) + 1;
	// A selection that ends at a line's start doesn't take that line.
	const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
	const next = value.indexOf("\n", last);
	const to = next === -1 ? value.length : next;
	const lines = value.slice(from, to).split("\n");
	const mark = LINE_MARK[kind];
	const counted = kind === "quote" ? lines : lines.filter((line) => line.trim());
	const has = counted.length > 0 && counted.every((line) => mark.test(line));
	let number = 0;
	const changed = lines.map((line) => {
		if (has) return line.replace(mark, "");
		if (kind === "quote") return line ? `> ${line}` : ">";
		if (!line.trim()) return line;
		const plain = line.replace(LINE_MARK.bullet, "").replace(LINE_MARK.number, "");
		number++;
		return kind === "bullet" ? `- ${plain}` : `${number}. ${plain}`;
	});
	const insert = changed.join("\n");
	return { from, to, insert, selectFrom: from, selectTo: from + insert.length };
}
