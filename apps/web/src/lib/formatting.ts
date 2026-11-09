/*
 * What a person writes in the composer is text, with the marks mail has long used for emphasis and
 * that Markdown grew from: **bold**, *italic* (or _italic_), [links](https://…), lists and > quotes.
 * The text goes as it was written, and when it uses any of these, HTML made from it goes beside it.
 *
 * Nothing else is read, and nothing is taken away: a line that only looks like a heading, a rule,
 * code, a table or HTML, a backslash, an entity, a mark that pairs with nothing, all stay as they
 * were typed. The marks are few, so they are read here rather than by a Markdown parser with most
 * of it turned off: one pass over each line, in time that grows with the text, whatever it holds.
 *
 * A quote holds someone else's words, as a reply's does, so nothing in it is read as a mark: its
 * lines go as they were, or a link in them could say one address and go to another under the
 * workspace's name. For the same reason a link whose words name a place goes only to that place.
 */

const ESCAPED: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (character) => ESCAPED[character] ?? "");

/** Text as HTML shows it as typed: escaped, with its runs of spaces kept. */
const textHtml = (text: string) => escapeHtml(text).replace(/ (?= )/g, "&nbsp;");

/** A line as HTML shows it as typed, a space it starts with kept too. */
const lineHtml = (text: string) => textHtml(text).replace(/^ /, "&nbsp;");

/** A link's address as it may go: the web or mail, or a bare host, which is taken as the web. */
function linkable(href: string): string | null {
	if (/^(?:https?:\/\/|mailto:)\S+$/i.test(href)) return href;
	if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i.test(href)) return `https://${href}`;
	return null;
}

/** Where an address goes: its host, without `www.`, and for mail, the address too. */
function placeOf(address: string): { host: string; mail: string | null } | null {
	try {
		const url = new URL(address);
		if (url.protocol === "mailto:") {
			const mail = decodeURIComponent(url.pathname).toLowerCase();
			return { host: mail.slice(mail.lastIndexOf("@") + 1), mail };
		}
		return { host: url.hostname.toLowerCase().replace(/^www\./, ""), mail: null };
	} catch {
		return null;
	}
}

/**
 * What reads as a place in a link's words: a web address, a mail address, or anything with the
 * shape of a host, in any script. A file's name, such as report.pdf, counts too, which only keeps
 * that link as it was typed; a host under a domain no list knows yet would otherwise pass.
 */
const NAMED_PLACE =
	/(?:https?:\/\/|www\.)[^\s/?#<>]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+|(?<![\p{L}\p{N}-])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?![\p{L}\p{N}-])/giu;

/** Words longer than this aren't read for places, and the link stays as typed. */
const MAX_LINK_WORDS = 500;

/** Whether a link's words name only the place it goes to, or none. */
function honest(words: string, target: string): boolean {
	if (words.length > MAX_LINK_WORDS) return false;
	const named = words.match(NAMED_PLACE);
	if (!named) return true;
	const goes = placeOf(target);
	if (!goes) return false;
	return named.every((place) => {
		if (place.includes("@") && !/^(?:https?:\/\/|www\.)/i.test(place)) {
			return place.toLowerCase() === goes.mail;
		}
		const host = placeOf(/^https?:\/\//i.test(place) ? place : `https://${place}`)?.host;
		return host === goes.host;
	});
}

type Run = { char: "*" | "_"; size: number; at: number; open: boolean; close: boolean };
type Piece = { text: string } | { link: string; words: string } | { run: Run };

const isSpace = (character: string | undefined) => character === undefined || /\s/.test(character);
/** What `_` may follow to start emphasis, and come before to end it: a space, or these. */
const OPENS_AFTER = /[\s([{"'“‘]/u;
const CLOSES_BEFORE = /[\s.,;:!?)\]}"'”’]/u;

/** For each place in a line, where the next of these characters is from there on, or -1. */
function nextOf(line: string, found: (character: string) => boolean): Int32Array {
	const next = new Int32Array(line.length + 1).fill(-1);
	for (let at = line.length - 1; at >= 0; at--) {
		next[at] = found(line[at] ?? "") ? at : (next[at + 1] ?? -1);
	}
	return next;
}

/**
 * A line in pieces: text, links, and the runs of `*` or `_` that may mark emphasis, with what each
 * run pairs with. A link is `[words](address)`, with no bracket in its words and no space in its
 * address; one that can't go, or whose words name another place, stays text. Emphasis pairs runs
 * of the same size, the nearest first, `*` inside a word too and `_` only at a word's edge, and a
 * mark between a pair that pairs with nothing inside it stays as it was typed.
 */
function piecesOf(line: string): { pieces: Piece[]; partner: Map<number, number> } {
	const pieces: Piece[] = [];
	const bracket = nextOf(line, (character) => character === "[" || character === "]");
	const closing = nextOf(line, (character) => character === ")");
	const space = nextOf(line, (character) => /\s/.test(character));
	let text = "";
	const flush = () => {
		if (text) pieces.push({ text });
		text = "";
	};
	let at = 0;
	while (at < line.length) {
		const character = line[at] ?? "";
		if (character === "[") {
			const end = bracket[at + 1] ?? -1;
			const close =
				end === -1 || line[end] !== "]" || line[end + 1] !== "(" ? -1 : closing[end + 2];
			if (close !== undefined && close > end + 2) {
				const spaced = space[end + 2] ?? -1;
				if (spaced === -1 || spaced > close) {
					const words = line.slice(at + 1, end);
					const target = linkable(line.slice(end + 2, close));
					// An image, `![words](address)`, would load from there once the mail is read: it stays text.
					if (line[at - 1] !== "!" && words.trim() && target !== null && honest(words, target)) {
						flush();
						pieces.push({ link: target, words });
					} else {
						text += line.slice(at, close + 1);
					}
					at = close + 1;
					continue;
				}
			}
		}
		if (character === "*" || character === "_") {
			let size = 1;
			while (line[at + size] === character) size++;
			const before = line[at - 1];
			const after = line[at + size];
			const usable = character === "*" ? size <= 3 : size === 1;
			if (usable) {
				flush();
				pieces.push({
					run: {
						char: character,
						size,
						at,
						// `_` only at the edge of words, so snake_case and C:\\Users\\_tmp_ stay.
						open:
							!isSpace(after) &&
							(character === "*" || before === undefined || OPENS_AFTER.test(before)),
						close:
							!isSpace(before) &&
							(character === "*" || after === undefined || CLOSES_BEFORE.test(after)),
					},
				});
			} else {
				text += line.slice(at, at + size);
			}
			at += size;
			continue;
		}
		text += character;
		at++;
	}
	flush();

	// Each run is put on the stack once and taken off once.
	const partner = new Map<number, number>();
	const stack: number[] = [];
	const open = new Map<string, number>();
	const kind = (run: Run) => `${run.char}${run.size}`;
	pieces.forEach((piece, index) => {
		if (!("run" in piece)) return;
		const { run } = piece;
		if (run.close && (open.get(kind(run)) ?? 0) > 0) {
			for (;;) {
				const top = stack.pop();
				if (top === undefined) break;
				const opener = pieces[top];
				if (!opener || !("run" in opener)) continue;
				open.set(kind(opener.run), (open.get(kind(opener.run)) ?? 1) - 1);
				if (kind(opener.run) === kind(run)) {
					partner.set(top, index);
					partner.set(index, top);
					break;
				}
			}
			return;
		}
		if (run.open) {
			stack.push(index);
			open.set(kind(run), (open.get(kind(run)) ?? 0) + 1);
		}
	});
	return { pieces, partner };
}

const OPEN = ["", "<em>", "<strong>", "<strong><em>"];
const CLOSE = ["", "</em>", "</strong>", "</em></strong>"];

/** A line of the person's own as HTML, and whether it uses any marks. */
function inline(line: string): { html: string; formatting: boolean } {
	const { pieces, partner } = piecesOf(line);
	let html = "";
	let formatting = false;
	pieces.forEach((piece, index) => {
		if ("text" in piece) {
			html += index === 0 ? lineHtml(piece.text) : textHtml(piece.text);
		} else if ("link" in piece) {
			html += `<a href="${escapeHtml(piece.link)}">${textHtml(piece.words)}</a>`;
			formatting = true;
		} else {
			const other = partner.get(index);
			if (other === undefined) {
				html += piece.run.char.repeat(piece.run.size);
			} else {
				html += (other > index ? OPEN : CLOSE)[piece.run.size];
				formatting = true;
			}
		}
	});
	return { html, formatting };
}

/** The runs of a line that pair, as offsets in it: where each pair opens and closes, and its size. */
function emphasisPairs(line: string): { open: number; close: number; size: number }[] {
	const { pieces, partner } = piecesOf(line);
	const pairs: { open: number; close: number; size: number }[] = [];
	for (const [index, other] of partner) {
		const opener = pieces[index];
		const closer = pieces[other];
		if (other > index && opener && "run" in opener && closer && "run" in closer) {
			pairs.push({ open: opener.run.at, close: closer.run.at, size: opener.run.size });
		}
	}
	return pairs;
}

const QUOTE_LINE = /^[ \t]{0,3}>/;
/** A bulleted item: its mark, then a space, then words. */
const BULLET = /^[ \t]{0,3}[-*+][ \t]+(?=\S)/;
/** A numbered item: up to nine digits, `.` or `)`, then a space, then words. */
const NUMBER = /^[ \t]{0,3}(\d{1,9})([.)])[ \t]+(?=\S)/;
/** A further line of an item, indented under it. */
const FURTHER = /^(?: {2,}|\t)\S/;

/** Quotes inside quotes deeper than this are kept as their lines, `>` and all. */
const MAX_QUOTE_DEPTH = 10;

/** Lines as they were typed: paragraphs at blank lines, each line kept, and its spaces. */
function plain(lines: string[]): string {
	const paragraphs: string[][] = [[]];
	for (const line of lines) {
		if (line.trim()) paragraphs[paragraphs.length - 1]?.push(line);
		else if (paragraphs[paragraphs.length - 1]?.length) paragraphs.push([]);
	}
	return paragraphs
		.filter((paragraph) => paragraph.length > 0)
		.map((paragraph) => `<p>${paragraph.map(lineHtml).join("<br>")}</p>\n`)
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

type List = { numbered: boolean; next: number; delimiter: string; items: string[][] };

/**
 * The person's own lines as HTML: paragraphs, and lists. A list goes on across blank lines while
 * its items do, a numbered one only with the next number, so that "9. November" or a "15." after
 * a list stays as typed. A line that doesn't start with a space ends the list above it.
 */
function own(lines: string[]): { html: string; formatting: boolean } {
	let html = "";
	let formatting = false;
	let paragraph: string[] = [];
	let list: List | null = null;
	let blank = false;
	const shown = (line: string) => {
		const one = inline(line);
		formatting ||= one.formatting;
		return one.html;
	};
	const endParagraph = () => {
		if (paragraph.length > 0) html += `<p>${paragraph.map(shown).join("<br>")}</p>\n`;
		paragraph = [];
	};
	const endList = () => {
		if (!list) return;
		const tag = list.numbered ? "ol" : "ul";
		const items = list.items.map((item) => `<li>${item.map(shown).join("<br>")}</li>\n`);
		html += `<${tag}>\n${items.join("")}</${tag}>\n`;
		formatting = true;
		list = null;
	};
	for (const line of lines) {
		if (!line.trim()) {
			endParagraph();
			blank = true;
			continue;
		}
		const bullet = BULLET.exec(line);
		const number = bullet ? null : NUMBER.exec(line);
		const value = number ? Number(number[1]) : 0;
		const current: List | null = list;
		const goesOn =
			current !== null &&
			(bullet
				? !current.numbered
				: number !== null &&
					current.numbered &&
					value === current.next &&
					number[2] === current.delimiter);
		const starts = !goesOn && (bullet !== null || value === 1);
		if (goesOn || starts) {
			endParagraph();
			if (starts) endList();
			const mark = bullet ?? number;
			list ??= {
				numbered: number !== null,
				next: 1,
				delimiter: number?.[2] ?? "",
				items: [],
			};
			list.items.push([line.slice(mark?.[0].length ?? 0)]);
			list.next = value + 1;
			blank = false;
			continue;
		}
		if (list && !blank && FURTHER.test(line)) {
			list.items[list.items.length - 1]?.push(line.trim());
			continue;
		}
		endList();
		paragraph.push(line);
		blank = false;
	}
	endParagraph();
	endList();
	return { html, formatting };
}

/** The text as HTML, and whether it uses any formatting. */
export function formatted(text: string): { html: string; formatting: boolean } {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let html = "";
	let formatting = false;
	for (const run of runs(lines)) {
		if (run.quote) {
			html += quoted(run.lines, 1);
			formatting = true;
		} else {
			const mine = own(run.lines);
			html += mine.html;
			formatting ||= mine.formatting;
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

/** Where the line holding this place starts and ends. */
function lineAround(value: string, at: number): { start: number; end: number } {
	const start = at === 0 ? 0 : value.lastIndexOf("\n", at - 1) + 1;
	const next = value.indexOf("\n", at);
	return { start, end: next === -1 ? value.length : next };
}

/**
 * Bold or italic on part of one line, from `start` to `end` in it: taken off when that is what one
 * pair marks, inside or around it, and otherwise put on, over any of the same marks inside it.
 * Spaces at its ends stay outside the marks. The new line and what is selected in it.
 */
function emphasized(
	line: string,
	start: number,
	end: number,
	stars: 1 | 2,
): { line: string; selectFrom: number; selectTo: number } {
	const mark = "*".repeat(stars);
	let from = start;
	let to = end;
	while (from < to && /\s/.test(line[from] ?? "")) from++;
	while (to > from && /\s/.test(line[to - 1] ?? "")) to--;
	if (from === to) {
		// A caret between marks with nothing in them takes them off; elsewhere they go in.
		let before = 0;
		while (line[start - before - 1] === "*") before++;
		let after = 0;
		while (line[start + after] === "*") after++;
		if (before === after && (before === stars || before === 3)) {
			return {
				line: line.slice(0, start - stars) + line.slice(start + stars),
				selectFrom: start - stars,
				selectTo: start - stars,
			};
		}
		return {
			line: `${line.slice(0, start)}${mark}${mark}${line.slice(start)}`,
			selectFrom: start + stars,
			selectTo: start + stars,
		};
	}
	const pairs = emphasisPairs(line).filter((pair) => pair.size === stars || pair.size === 3);
	const around = pairs.find((pair) => pair.open + pair.size === from && pair.close === to);
	if (around) {
		return {
			line: line.slice(0, from - stars) + line.slice(from, to) + line.slice(to + stars),
			selectFrom: from - stars,
			selectTo: to - stars,
		};
	}
	const whole = pairs.find((pair) => pair.open === from && pair.close + pair.size === to);
	if (whole) {
		return {
			line: line.slice(0, from) + line.slice(from + stars, to - stars) + line.slice(to),
			selectFrom: from,
			selectTo: to - 2 * stars,
		};
	}
	// The same marks inside come off, so that the whole goes as one.
	let inner = line.slice(from, to);
	const cuts = pairs
		.filter((pair) => pair.open >= from && pair.close + pair.size <= to)
		.flatMap((pair) => [pair.open - from, pair.close - from])
		.sort((one, other) => other - one);
	for (const cut of cuts) inner = inner.slice(0, cut) + inner.slice(cut + stars);
	return {
		line: `${line.slice(0, from)}${mark}${inner}${mark}${line.slice(to)}`,
		selectFrom: from + stars,
		selectTo: from + stars + inner.length,
	};
}

/**
 * Makes the selection bold (`**`, two stars) or italic (`*`, one, which works inside a word too),
 * or takes that off when it has it: three stars are both. With nothing selected, the marks go in
 * with the caret between them. Over several lines, each line's part is changed, as marks pair
 * within a line.
 */
export function toggleEmphasis(value: string, start: number, end: number, stars: 1 | 2): TextEdit {
	// A selection that ends at a line's start doesn't take that line.
	const stop = end > start && value[end - 1] === "\n" ? end - 1 : end;
	const first = lineAround(value, start);
	const last = lineAround(value, stop);
	const lines = value.slice(first.start, last.end).split("\n");
	if (lines.length === 1) {
		const edit = emphasized(lines[0] ?? "", start - first.start, stop - first.start, stars);
		return {
			from: first.start,
			to: last.end,
			insert: edit.line,
			selectFrom: first.start + edit.selectFrom,
			selectTo: first.start + edit.selectTo,
		};
	}
	let lineStart = first.start;
	const changed = lines.map((line, index) => {
		const from = index === 0 ? start - first.start : 0;
		const to = index === lines.length - 1 ? stop - lineStart : line.length;
		lineStart += line.length + 1;
		// A line with nothing of it selected, or only spaces, stays as it is.
		if (!line.slice(from, to).trim()) return line;
		return emphasized(line, from, to, stars).line;
	});
	const insert = changed.join("\n");
	// What follows the selection on its last line is as it was.
	return {
		from: first.start,
		to: last.end,
		insert,
		selectFrom: start,
		selectTo: first.start + insert.length - (last.end - stop),
	};
}

/** The placeholder a new link's address starts as, selected so that what is typed replaces it. */
export const LINK_PLACEHOLDER = "https://";

/** The selection's spaces at each end, which marks leave outside, and the words between them. */
function trimmed(selected: string): { lead: string; core: string; trail: string } {
	const lead = /^\s*/.exec(selected)?.[0] ?? "";
	const core = selected.slice(lead.length).trimEnd();
	return { lead, core, trail: selected.slice(lead.length + core.length) };
}

/** An address as a link's goes, with what would end it or split it written as `%` codes. */
const asAddress = (address: string) =>
	address.replace(
		/[()\s<>[\]]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
	);

/**
 * Makes the selection a link. An address selected becomes the link's address and words; other
 * words keep theirs and wait for an address.
 */
export function insertLink(value: string, start: number, end: number): TextEdit {
	const { lead, core, trail } = trimmed(value.slice(start, end));
	const at = start + lead.length;
	const words = core.replace(/[[\]]/g, "");
	if (core && !/\s/.test(core) && linkable(core) !== null) {
		return {
			from: start,
			to: end,
			insert: `${lead}[${words}](${asAddress(core)})${trail}`,
			selectFrom: at + 1,
			selectTo: at + 1 + words.length,
		};
	}
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
