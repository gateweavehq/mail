import { describe, expect, it } from "vitest";
import { isVariableName, type Piece, readVariables } from "./template-reader";

const pieces = (source: string): Piece[] => {
	const read = readVariables(source);
	if (!read.ok) throw new Error(read.error);
	return read.pieces;
};

describe("reading a template's variables", () => {
	it("gives the words and the variables between them, in order", () => {
		expect(pieces("Hello {{first_name}}, your code is {{code2}}.")).toEqual([
			{ text: "Hello " },
			{ variable: "first_name" },
			{ text: ", your code is " },
			{ variable: "code2" },
			{ text: "." },
		]);
		expect(pieces("{{a}}{{b}}")).toEqual([{ variable: "a" }, { variable: "b" }]);
		expect(pieces("")).toEqual([]);
		expect(pieces("No variables, {single} braces } and { stay.")).toEqual([
			{ text: "No variables, {single} braces } and { stay." },
		]);
	});

	it("writes {{ as it is after a backslash, and reads no variable there", () => {
		expect(pieces("Use \\{{name}} for a variable, like {{name}}.")).toEqual([
			{ text: "Use {{name}} for a variable, like " },
			{ variable: "name" },
			{ text: "." },
		]);
		// A backslash anywhere else is only a backslash.
		expect(pieces("C:\\Users {{who}}\\")).toEqual([
			{ text: "C:\\Users " },
			{ variable: "who" },
			{ text: "\\" },
		]);
		expect(pieces("\\{{")).toEqual([{ text: "{{" }]);
	});

	it("refuses a {{ that doesn't start a variable, naming its line", () => {
		for (const source of [
			"{{",
			"{{}}",
			"{{Name}}",
			"{{ name }}",
			"{{name",
			"{{name}",
			"{{1st}}",
			"{{_x}}",
			"{{na-me}}",
			"{{{name}}}",
			"{{name}}\n{{",
		]) {
			expect(readVariables(source).ok, source).toBe(false);
		}
		const refused = readVariables("one\ntwo {{ no }}");
		expect(refused).toEqual({ ok: false, error: expect.stringContaining("Line 2") });
	});

	it("takes a name of 32 characters and not of 33", () => {
		const long = `a${"b".repeat(31)}`;
		expect(isVariableName(long)).toBe(true);
		expect(pieces(`{{${long}}}`)).toEqual([{ variable: long }]);
		expect(readVariables(`{{${long}b}}`).ok).toBe(false);
		expect(isVariableName("")).toBe(false);
		expect(isVariableName("A")).toBe(false);
		expect(isVariableName("a b")).toBe(false);
	});

	it("takes time that grows with the text, whatever it holds", () => {
		// Each of these would take minutes if reading backtracked or went back over its text; they
		// are each a million characters or more.
		const hostile = [
			"{".repeat(2_000_000),
			"{{a".repeat(700_000),
			`{{${"a".repeat(1_000_000)}`,
			"\\{{".repeat(700_000),
			"{{a}}".repeat(400_000),
			`${"x".repeat(1_000_000)}{{`,
			"{{a}}\\".repeat(300_000),
		];
		const started = performance.now();
		for (const source of hostile) readVariables(source);
		expect(performance.now() - started).toBeLessThan(5000);
	});
});

describe("backslashes in a template", () => {
	it("reads \\{{ as {{, \\\\ as a backslash, and a lone backslash as itself", () => {
		// `\{{x}}` is the braces as written.
		expect(pieces("\\{{x}}")).toEqual([{ text: "{{x}}" }]);
		// `\\{{x}}` is a backslash and then the variable.
		expect(pieces("\\\\{{x}}")).toEqual([{ text: "\\" }, { variable: "x" }]);
		// `\\\{{` is a backslash and then `{{`.
		expect(pieces("\\\\\\{{")).toEqual([{ text: "\\{{" }]);
		expect(pieces("\\\\\\\\{{x}}")).toEqual([{ text: "\\\\" }, { variable: "x" }]);
		// A trailing lone backslash, and one before other characters, are only themselves.
		expect(pieces("abc\\")).toEqual([{ text: "abc\\" }]);
		expect(pieces("a\\b {{x}}\\")).toEqual([{ text: "a\\b " }, { variable: "x" }, { text: "\\" }]);
		expect(pieces("\\\\")).toEqual([{ text: "\\" }]);
		expect(pieces("\\")).toEqual([{ text: "\\" }]);
	});

	it("takes time that grows with the text", () => {
		const started = performance.now();
		for (const source of [
			"\\".repeat(2_000_000),
			"\\\\{{x}}".repeat(300_000),
			"\\\\\\{{".repeat(500_000),
		]) {
			readVariables(source);
		}
		expect(performance.now() - started).toBeLessThan(5000);
	});
});
