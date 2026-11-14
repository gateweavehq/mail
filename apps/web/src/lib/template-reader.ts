/*
 * Reads the variables of a template: `{{name}}` in a subject or a body. Nothing is evaluated: a
 * name is looked up and that is all, so a template can't run anything, and a value is never read
 * for variables itself. `\{{` writes `{{` as it is.
 *
 * It is a single pass over the text, with no regular expression, so the time grows with the text
 * and no input makes it backtrack. A name is looked for only as far as a name may go, so a long
 * run of braces costs no more per character than any other text.
 */

/** The longest name a variable has. */
export const MAX_VARIABLE_NAME = 32;

/** A piece of a template: words as written, or a place for a value. */
export type Piece = { text: string } | { variable: string };

export type Read = { ok: true; pieces: Piece[] } | { ok: false; error: string };

const isLetter = (character: string) => character >= "a" && character <= "z";
const isNameCharacter = (character: string) =>
	isLetter(character) || (character >= "0" && character <= "9") || character === "_";

/** Whether this is a name a variable may have: `[a-z][a-z0-9_]{0,31}`. */
export function isVariableName(name: string): boolean {
	if (name.length === 0 || name.length > MAX_VARIABLE_NAME || !isLetter(name[0] ?? "")) {
		return false;
	}
	for (let at = 1; at < name.length; at++) {
		if (!isNameCharacter(name[at] ?? "")) return false;
	}
	return true;
}

/** The line a place is on, counted from 1, for saying where a mistake is. */
function lineOf(source: string, at: number): number {
	let line = 1;
	for (let place = 0; place < at; place++) if (source[place] === "\n") line++;
	return line;
}

/** The text in pieces, or where a `{{` doesn't start a variable. */
export function readVariables(source: string): Read {
	const pieces: Piece[] = [];
	// Text is kept as a run of the source, and cut out when it ends, rather than built a character
	// at a time. `literal` holds the run's `{{` that were written with a backslash.
	let runStart = 0;
	let literal = "";
	const flush = (end: number) => {
		const text = literal + source.slice(runStart, end);
		if (text) pieces.push({ text });
		literal = "";
	};
	let at = 0;
	while (at < source.length) {
		const character = source[at];
		if (character === "\\" && source[at + 1] === "{" && source[at + 2] === "{") {
			literal += `${source.slice(runStart, at)}{{`;
			at += 3;
			runStart = at;
			continue;
		}
		if (character === "{" && source[at + 1] === "{") {
			let end = at + 2;
			// One more than the longest name, so that a name too long is seen as one.
			const limit = Math.min(source.length, at + 2 + MAX_VARIABLE_NAME + 1);
			while (end < limit && isNameCharacter(source[end] ?? "")) end++;
			const name = source.slice(at + 2, end);
			if (!isVariableName(name) || source[end] !== "}" || source[end + 1] !== "}") {
				return {
					ok: false,
					error: `Line ${lineOf(source, at)} has a {{ that doesn't start a variable. A variable is {{name}}, with lower case letters, digits and _, starting with a letter; write \\{{ for {{ itself.`,
				};
			}
			flush(at);
			pieces.push({ variable: name });
			at = end + 2;
			runStart = at;
			literal = "";
			continue;
		}
		at++;
	}
	flush(source.length);
	return { ok: true, pieces };
}
