import { z } from "zod";
import { formatted, textHtml } from "./formatting";
import { MAX_HTML, MAX_SUBJECT, MAX_TEXT } from "./outbox";
import { isVariableName, type Piece, readVariables } from "./template-reader";

/*
 * Templates: a subject and a body, written once with `{{name}}` where a value goes, so that mail
 * can be sent over and over with different values. The body is read as the composer's text is
 * (formatting.ts: bold, italic, links, lists and quotes), and a value is only ever put in as text.
 *
 * The values go in after the body has been read. Each variable stands for one private-use
 * character while the body is read as formatted text, and the characters are swapped for the
 * values, escaped, in the HTML that comes out. So a value can't make a link, a list, bold or
 * HTML, whatever it holds: the reading is over before it is there. A variable placed where a
 * reader would take it for part of a link, in its words or its address, is refused when the
 * template is saved, since a value there would decide what the link says or where it goes.
 */

/** The most live templates a workspace has. */
export const MAX_TEMPLATES = 200;

/** The most variables a template declares. */
export const MAX_VARIABLES = 20;

/** The longest value for a variable, in characters. */
export const MAX_VALUE = 2000;

/** The longest name a template has, in characters. */
export const MAX_TEMPLATE_NAME = 100;

/**
 * While a body is read, variable number n stands for the character FIRST_MARKER + n, from the
 * private-use area. `MARKER` is any character of the area, which a template may not hold of its
 * own; `MARKERS` is those that stand for variables, as many as a template may declare.
 */
const FIRST_MARKER = 0xe000;
const MARKER = /[\ue000-\uf8ff]/u;
const MARKERS = /[\ue000-\ue013]/gu;

/** What a value or a subject may not hold: line breaks, other controls, and marks that turn text around. */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const markerOf = (index: number) => String.fromCharCode(FIRST_MARKER + index);

/** A template's name: what people and agents call it, kept in the case it was written in. */
export const templateName = z
	.string()
	.trim()
	.min(1, "Give the template a name.")
	.max(MAX_TEMPLATE_NAME, `A name takes ${MAX_TEMPLATE_NAME} characters at most.`)
	.refine((name) => !UNSAFE.test(name), "A name can't hold a line break or another control.");

/**
 * Names are the same when they are the same letters, whatever their case: folded by NFKC, then to
 * lower case, then with the two letters that lower case leaves different from how a reader sees
 * them, ß as ss and a final sigma as the usual one, so that "STRASSE" and "Straße" are one name.
 */
export const nameKey = (name: string) =>
	name.normalize("NFKC").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ");

/** The most versions one template keeps. */
export const MAX_VERSIONS = 100;

export interface TemplateContent {
	subject: string;
	body: string;
	/** The variables the subject and body use, each declared once. */
	variables: string[];
}

/** One saving of a template. Versions are never changed after. */
export interface TemplateVersion extends TemplateContent {
	number: number;
	/** The membership that saved it, or null when that member is gone. */
	madeBy: string | null;
	madeAt: number;
}

/** A live template, with the version a send uses unless it asks for another. */
export interface Template extends TemplateVersion {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * The subject and body in pieces, or why they can't be a template with these variables: every
 * `{{name}}` is read, each is declared, and each declared one is used.
 */
export function readTemplate(
	content: TemplateContent,
): { ok: true; subject: Piece[]; body: Piece[] } | { ok: false; error: string } {
	if (content.variables.length > MAX_VARIABLES) {
		return { ok: false, error: `A template can have ${MAX_VARIABLES} variables at most.` };
	}
	for (const name of content.variables) {
		if (!isVariableName(name)) {
			return {
				ok: false,
				error: `"${name}" isn't a name a variable can have: lower case letters, digits and _, starting with a letter, 32 at most.`,
			};
		}
	}
	if (new Set(content.variables).size !== content.variables.length) {
		return { ok: false, error: "A variable is declared twice." };
	}
	if (UNSAFE.test(content.subject)) {
		return { ok: false, error: "The subject can't hold a line break or another control." };
	}
	for (const [where, text] of [
		["subject", content.subject],
		["body", content.body],
	] as const) {
		// These stand for variables while the body is read, so the text can't have them of its own.
		if (MARKER.test(text)) {
			return { ok: false, error: `The ${where} holds a character reserved for private use.` };
		}
	}
	const subject = readVariables(content.subject);
	if (!subject.ok) return { ok: false, error: `In the subject: ${subject.error}` };
	const body = readVariables(content.body);
	if (!body.ok) return { ok: false, error: `In the body: ${body.error}` };
	const used = new Set<string>();
	for (const piece of [...subject.pieces, ...body.pieces]) {
		if (!("variable" in piece)) continue;
		used.add(piece.variable);
		if (!content.variables.includes(piece.variable)) {
			return {
				ok: false,
				error: `{{${piece.variable}}} is used but isn't declared. Declare it, or write \\{{ if you meant the braces.`,
			};
		}
	}
	const unused = content.variables.find((name) => !used.has(name));
	if (unused !== undefined) {
		return { ok: false, error: `${unused} is declared but never used in the subject or body.` };
	}
	return { ok: true, subject: subject.pieces, body: body.pieces };
}

/** Pieces as text, with each variable as `of` gives it. */
function joined(pieces: Piece[], of: (name: string) => string): string {
	let text = "";
	for (const piece of pieces) text += "text" in piece ? piece.text : of(piece.variable);
	return text;
}

/**
 * The body read as formatted text with a character in each variable's place, and whether it uses
 * formatting. A message with none goes as text alone. Null when a variable has landed where a
 * value may not: inside a link, or anywhere the reader dropped or changed the character.
 */
function readBody(
	body: Piece[],
	variables: string[],
): { html: string; formatting: boolean } | string {
	const source = joined(body, (name) => markerOf(variables.indexOf(name)));
	const { html, formatting } = formatted(source);
	// Every character must come out once for each time it went in, as text and outside any tag: in
	// a link's words it would decide what the link says, and in its address, where it goes.
	const wanted = new Map<string, number>();
	for (const character of source.match(MARKERS) ?? []) {
		wanted.set(character, (wanted.get(character) ?? 0) + 1);
	}
	const found = new Map<string, number>();
	let inLink = false;
	for (let at = 0; at < html.length; at++) {
		const character = html[at] ?? "";
		if (character === "<") {
			// Text is escaped, so a `<` is a tag the reader made.
			const end = html.indexOf(">", at);
			if (end === -1) return IN_A_LINK;
			const tag = html.slice(at + 1, end);
			if (tag.startsWith("a ")) inLink = true;
			else if (tag === "/a") inLink = false;
			// Whatever it holds, in an attribute, doesn't count as text.
			at = end;
		} else if (MARKER.test(character)) {
			if (inLink) return IN_A_LINK;
			found.set(character, (found.get(character) ?? 0) + 1);
		}
	}
	for (const [character, count] of wanted) if (found.get(character) !== count) return IN_A_LINK;
	if (html.includes("<a ")) {
		const near = markerNearLink(source);
		if (near !== null) {
			const name = variables[near.charCodeAt(0) - FIRST_MARKER] ?? "";
			return `{{${name}}} is too close to a link: a value touching a link could read as part of what the link says, such as bank.evil.com. Put a space or a new line between them.`;
		}
	}
	return { html, formatting };
}

/**
 * How far from a link formatting.ts reads what touches it (`MAX_AROUND`): what shows of a link is
 * its words and what stands against it up to a space, that far, because a link's words may name a
 * place together with the text beside them.
 */
const LINK_REACH = 64;

/**
 * The first character standing for a variable that touches something shaped like a link, `[words](address)`,
 * within the reach formatting.ts reads around it, with no space between. Looser than the reader's
 * own idea of a link, which is the safe way: it may refuse where nothing would link. One pass, and
 * each look is at most `LINK_REACH` characters.
 */
function markerNearLink(source: string): string | null {
	const closing = new Int32Array(source.length + 1).fill(-1);
	for (let at = source.length - 1; at >= 0; at--) {
		closing[at] = source[at] === ")" ? at : (closing[at + 1] ?? -1);
	}
	const isSpace = (character: string | undefined) =>
		character === undefined || /\s/.test(character);
	let open = -1;
	for (let at = 0; at < source.length; at++) {
		const character = source[at];
		if (character === "[") open = at;
		if (character !== "]" || source[at + 1] !== "(" || open === -1) continue;
		const close = closing[at + 2] ?? -1;
		if (close === -1) continue;
		for (let from = open - 1; from >= 0 && open - from <= LINK_REACH; from--) {
			const before = source[from];
			if (isSpace(before)) break;
			if (before !== undefined && MARKER.test(before)) return before;
		}
		for (let to = close + 1; to < source.length && to - close <= LINK_REACH; to++) {
			const after = source[to];
			if (isSpace(after)) break;
			if (after !== undefined && MARKER.test(after)) return after;
		}
	}
	return null;
}

const IN_A_LINK =
	"A variable can't be in a link, in what it says or where it goes: a value there could make it say one place and go to another. Put it outside the link.";

/** Why a value can't stand for a variable, or null when it can. */
export function valueRefusal(name: string, value: unknown): string | null {
	if (typeof value !== "string") return `${name}: a value is text.`;
	if (value.trim().length === 0) return `${name}: a value can't be empty.`;
	if (value.length > MAX_VALUE) return `${name}: a value takes ${MAX_VALUE} characters at most.`;
	if (UNSAFE.test(value)) {
		return `${name}: a value is one line, with no line break, other control or mark that turns text around.`;
	}
	return null;
}

export type Rendered =
	| { ok: true; subject: string; text: string; html: string | null }
	| { ok: false; error: string };

/**
 * A template's subject, text and HTML for these values. Each variable needs a value of at most
 * `MAX_VALUE` characters that is one line, and no value is for a variable it doesn't have. The HTML
 * is null when the body uses no formatting, and goes as text alone. A value is text in both: never
 * read for variables, nor for formatting.
 */
export function renderTemplate(
	content: TemplateContent,
	values: Record<string, unknown>,
): Rendered {
	const read = readTemplate(content);
	if (!read.ok) return read;
	// Own properties only: `constructor` and the like are on every object, and are no one's value.
	const has = (name: string) => Object.hasOwn(values, name);
	const given = Object.keys(values);
	const unknown = given.find((name) => !content.variables.includes(name));
	if (unknown !== undefined) {
		return { ok: false, error: `${unknown}: this template has no such variable.` };
	}
	for (const name of content.variables) {
		if (!has(name)) return { ok: false, error: `No value for ${name}.` };
		const refusal = valueRefusal(name, values[name]);
		if (refusal) return { ok: false, error: refusal };
	}
	const valueFor = (name: string) => String(values[name]);
	// Counted before anything is joined: a variable used often with long values would otherwise
	// build text far past what a message may be.
	for (const [what, pieces, most] of [
		["subject", read.subject, MAX_SUBJECT],
		["text", read.body, MAX_TEXT],
	] as const) {
		let length = 0;
		for (const piece of pieces) {
			length += "text" in piece ? piece.text.length : valueFor(piece.variable).length;
			if (length > most) {
				return { ok: false, error: `With these values the ${what} is over ${most} characters.` };
			}
		}
	}
	const subject = joined(read.subject, valueFor).trim();
	if (!subject) return { ok: false, error: "The subject is empty." };
	const text = joined(read.body, valueFor);
	if (!text.trim()) return { ok: false, error: "The body is empty." };
	const body = readBody(read.body, content.variables);
	if (typeof body === "string") return { ok: false, error: body };
	if (!body.formatting) return { ok: true, subject, text, html: null };
	const html = body.html.replace(MARKERS, (character) =>
		textHtml(valueFor(content.variables[character.charCodeAt(0) - FIRST_MARKER] ?? "")),
	);
	if (html.length > MAX_HTML) {
		return { ok: false, error: `With these values the HTML is over ${MAX_HTML} characters.` };
	}
	return { ok: true, subject, text, html };
}

/**
 * The variables a subject and body use, each once, in the order they first appear; or why they
 * can't be read. For a page that declares what is used as the person writes.
 */
export function usedVariables(subject: string, body: string): string[] | string {
	const names: string[] = [];
	for (const text of [subject, body]) {
		const read = readVariables(text);
		if (!read.ok) return read.error;
		for (const piece of read.pieces) {
			if ("variable" in piece && !names.includes(piece.variable)) names.push(piece.variable);
		}
	}
	return names;
}

/** The values a template is tried with when it is saved: each variable's own name. */
export const sampleValues = (variables: string[]): Record<string, string> =>
	Object.fromEntries(variables.map((name) => [name, name]));

/**
 * A template as it may be saved, or why not: its subject and body read, its variables declared and
 * used, and the whole of it renderable, which it is tried with short values to see.
 */
export const templateInput = z
	.object({
		name: templateName,
		subject: z.string().trim().min(1, "Write a subject.").max(MAX_SUBJECT),
		body: z
			.string()
			.max(MAX_TEXT, `The body takes ${MAX_TEXT} characters at most.`)
			.refine((body) => body.trim().length > 0, "Write a body.")
			.transform((body) => body.replace(/\r\n?/g, "\n")),
		variables: z
			.array(z.string().max(64))
			.max(MAX_VARIABLES, `A template can have ${MAX_VARIABLES} variables at most.`),
	})
	.superRefine((input, context) => {
		const tried = renderTemplate(input, sampleValues(input.variables));
		if (!tried.ok) context.addIssue({ code: "custom", message: tried.error });
	});

export type TemplateInput = z.input<typeof templateInput>;
