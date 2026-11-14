import { describe, expect, it } from "vitest";
import { MAX_HTML, MAX_SUBJECT, MAX_TEXT } from "./outbox";
import {
	MAX_TEMPLATES,
	MAX_VALUE,
	MAX_VARIABLES,
	nameKey,
	readTemplate,
	renderTemplate,
	sampleValues,
	templateInput,
	usedVariables,
} from "./templates";

/** A turned-around mark and a line separator, written as codes so no source file holds them. */
const RLO = String.fromCodePoint(0x202e);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PRIVATE_USE = String.fromCharCode(0xe000);

const content = (subject: string, body: string, variables: string[]) => ({
	subject,
	body,
	variables,
});

function rendered(
	subject: string,
	body: string,
	values: Record<string, string>,
): { subject: string; text: string; html: string | null } {
	const result = renderTemplate(content(subject, body, Object.keys(values)), values);
	if (!result.ok) throw new Error(result.error);
	return result;
}

function refusal(subject: string, body: string, values: Record<string, unknown>): string {
	const result = renderTemplate(content(subject, body, Object.keys(values)), values);
	if (result.ok) throw new Error("expected a refusal");
	return result.error;
}

describe("rendering a template", () => {
	it("makes the subject, the text and the HTML as the composer's formatted mail is made", () => {
		const result = rendered(
			"Welcome, {{name}}",
			"Hi **{{name}}**,\n\n- your code is {{code}}\n- see [the docs](https://example.com/docs)",
			{ name: "Ann", code: "4821" },
		);
		expect(result.subject).toBe("Welcome, Ann");
		expect(result.text).toBe(
			"Hi **Ann**,\n\n- your code is 4821\n- see [the docs](https://example.com/docs)",
		);
		expect(result.html).toBe(
			'<p>Hi <strong>Ann</strong>,</p>\n<ul>\n<li>your code is 4821</li>\n<li>see <a href="https://example.com/docs">the docs</a></li>\n</ul>\n',
		);
	});

	it("has no HTML when the body uses no formatting, and goes as text alone", () => {
		const result = rendered("Hi {{name}}", "Hello {{name}},\nsee you soon.", { name: "Ann" });
		expect(result.html).toBeNull();
		expect(result.text).toBe("Hello Ann,\nsee you soon.");
	});

	it("writes {{ as it is after a backslash, in the subject and the body", () => {
		const result = rendered("Use \\{{x}}", "*Write* \\{{x}} for {{x}}", { x: "this" });
		expect(result.subject).toBe("Use {{x}}");
		expect(result.html).toBe("<p><em>Write</em> {{x}} for this</p>\n");
	});

	it("puts a value in as text, so it can't make HTML", () => {
		const value = '<script>alert("x")</script><img src=x onerror=alert(1)> & "q" \'s\'';
		const result = rendered("{{x}}", "*Hi*\n\n{{x}}", { x: value });
		expect(result.html).toBe(
			"<p><em>Hi</em></p>\n<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot; &#39;s&#39;</p>\n",
		);
		expect(result.html).not.toMatch(/<(?!\/?(?:p|em)>)/);
		// In the text part, where nothing reads HTML, it is as it was given.
		expect(result.text).toContain(value);
		expect(result.subject).toBe(value);
	});

	it("puts a value in as text, so it can't make a link", () => {
		for (const value of [
			"[click here](https://evil.example)",
			"[https://bank.example](https://evil.example)",
			"<https://evil.example>",
			"[a](mailto:x@evil.example)",
			"![pixel](https://evil.example/p.png)",
		]) {
			const result = rendered("Hi", "*Hi*\n\nYour name: {{x}}", { x: value });
			expect(result.html, value).not.toContain("<a ");
			expect(result.html, value).not.toContain("<img");
			expect(result.html, value).toContain(
				value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
			);
		}
	});

	it("puts a value in as text, so it can't add a heading, a list, bold, italic or a quote", () => {
		for (const value of [
			"# Heading",
			"## Heading",
			"**bold**",
			"*italic*",
			"_italic_",
			"- item",
			"1. item",
			"> quoted",
			"***both***",
		]) {
			const result = rendered("Hi", "*Hi*\n\n{{x}}", { x: value });
			expect(result.html, value).toBe(`<p><em>Hi</em></p>\n<p>${value.replace(">", "&gt;")}</p>\n`);
		}
		// Even beside the template's own marks, a value's are only characters.
		expect(rendered("Hi", "**{{a}}** and *{{b}}*", { a: "*x*", b: "**y**" }).html).toBe(
			"<p><strong>*x*</strong> and <em>**y**</em></p>\n",
		);
	});

	it("never reads a value for variables", () => {
		const result = rendered("{{a}} {{b}}", "*Hi* {{a}}", { a: "{{b}}", b: "\\{{a}}" });
		expect(result.subject).toBe("{{b}} \\{{a}}");
		expect(result.html).toBe("<p><em>Hi</em> {{b}}</p>\n");
		// Nor for the characters that stand for variables while the body is read.
		const forged = rendered("Hi", "*Hi* {{a}} {{b}}", { a: PRIVATE_USE, b: "x" });
		expect(forged.html).toBe(`<p><em>Hi</em> ${PRIVATE_USE} x</p>\n`);
	});

	it("keeps a value's runs of spaces, as the composer keeps typed ones", () => {
		expect(rendered("Hi", "*Hi* {{x}}", { x: "a  b" }).html).toBe("<p><em>Hi</em> a&nbsp; b</p>\n");
	});

	it("refuses a value that would add a line break to the subject, or a line to the body", () => {
		for (const value of ["a\nb", "a\r\nb", "a\rb", `a${LINE_SEPARATOR}b`, "a\u0000b", "a\tb"]) {
			expect(refusal("Hi {{x}}", "Body", { x: value }), JSON.stringify(value)).toMatch(/one line/);
			expect(refusal("Hi", "Body {{x}}", { x: value }), JSON.stringify(value)).toMatch(/one line/);
		}
		expect(refusal("Hi", "Body {{x}}", { x: `evil${RLO}fdp` })).toMatch(/one line/);
	});

	it("refuses a missing value, an empty one, one for no variable, and one that isn't text", () => {
		const template = content("Hi {{a}}", "Body {{b}}", ["a", "b"]);
		expect(renderTemplate(template, { a: "x" })).toEqual({
			ok: false,
			error: "No value for b.",
		});
		expect(renderTemplate(template, { a: "x", b: "  " })).toEqual({
			ok: false,
			error: "b: a value can't be empty.",
		});
		expect(renderTemplate(template, { a: "x", b: "y", c: "z" })).toEqual({
			ok: false,
			error: "c: this template has no such variable.",
		});
		expect(renderTemplate(template, { a: "x", b: 7 })).toEqual({
			ok: false,
			error: "b: a value is text.",
		});
	});

	it("takes a value of 2,000 characters and refuses one of 2,001", () => {
		expect(rendered("Hi", "Body {{x}}", { x: "x".repeat(MAX_VALUE) }).text).toHaveLength(
			"Body ".length + MAX_VALUE,
		);
		expect(refusal("Hi", "Body {{x}}", { x: "x".repeat(MAX_VALUE + 1) })).toMatch(
			/2000 characters/,
		);
	});

	it("refuses a message that the values would make longer than a message may be", () => {
		const many = "{{a}}".repeat(Math.ceil(MAX_TEXT / MAX_VALUE) + 1);
		expect(refusal("Hi", many, { a: "x".repeat(MAX_VALUE) })).toMatch(/text is over/);
		expect(refusal("{{a}}".repeat(1000), "Body", { a: "x".repeat(MAX_VALUE) })).toMatch(
			new RegExp(`subject is over ${MAX_SUBJECT}`),
		);
		// Counted without building it: a template a hundred thousand variables long is refused fast.
		const started = performance.now();
		refusal("Hi", "{{a}}".repeat(MAX_TEXT / 5), { a: "x".repeat(MAX_VALUE) });
		expect(performance.now() - started).toBeLessThan(2000);
	});

	it("keeps the HTML within what a message may hold", () => {
		// Each quote becomes `&#39;`, so the HTML can be larger than the text.
		const body = `*a* ${"{{q}}".repeat(Math.floor((MAX_TEXT - 10) / 5))}`;
		const result = renderTemplate(content("Hi", body, ["q"]), { q: "'".repeat(5) });
		expect(result.ok ? result.html?.length : 0).toBeLessThanOrEqual(MAX_HTML);
		const over = renderTemplate(content("Hi", body, ["q"]), { q: "'".repeat(MAX_VALUE) });
		expect(over.ok).toBe(false);
	});

	it("refuses a variable inside a link, in its words or its address", () => {
		for (const body of [
			"[{{x}}](https://example.com)",
			"[Open {{x}} now](https://example.com)",
			"[Open](https://example.com/{{x}})",
			"[Open](https://{{x}}.example.com)",
			"[{{x}}](https://{{x}}.example.com)",
		]) {
			const result = renderTemplate(content("Hi", body, ["x"]), { x: "bank.example" });
			// Where it can't be a link at all, the text stays as written, with the value in it.
			if (result.ok) expect(result.html ?? "", body).not.toContain("<a ");
			else expect(result.error, body).toMatch(/can't be in a link/);
		}
		expect(
			renderTemplate(content("Hi", "[{{x}}](https://example.com)", ["x"]), { x: "bank.example" }),
		).toEqual({ ok: false, error: expect.stringContaining("can't be in a link") });
		expect(
			renderTemplate(content("Hi", "[Open](https://example.com/{{x}})", ["x"]), {
				x: "evil.example",
			}),
		).toEqual({ ok: false, error: expect.stringContaining("can't be in a link") });
		// Beside a link is fine.
		expect(rendered("Hi", "[Open](https://example.com) {{x}}", { x: "Ann" }).html).toBe(
			'<p><a href="https://example.com/">Open</a> Ann</p>\n',
		);
	});

	it("can put a variable in a quote, which the reader leaves as it is", () => {
		expect(rendered("Hi", "> said {{x}}", { x: "**no**" }).html).toBe(
			"<blockquote>\n<p>said **no**</p>\n</blockquote>\n",
		);
	});

	it("takes time that grows with the text, whatever it holds", () => {
		const bodies = [
			"{{a}}".repeat(MAX_TEXT / 5),
			"*{{a}}".repeat(MAX_TEXT / 6),
			"[{{a}}](https://x.example)".repeat(3000),
			"> {{a}}\n".repeat(MAX_TEXT / 8),
			"- {{a}} **\n".repeat(MAX_TEXT / 11),
		];
		const started = performance.now();
		for (const body of bodies) renderTemplate(content("Hi", body, ["a"]), { a: "v" });
		// Left to run, a quadratic reading would take minutes at this size.
		expect(performance.now() - started).toBeLessThan(5000);
	});
});

describe("what a template may be saved as", () => {
	const input = (over: Record<string, unknown> = {}) => ({
		name: "Welcome",
		subject: "Hi {{name}}",
		body: "Hello {{name}}",
		variables: ["name"],
		...over,
	});
	const why = (over: Record<string, unknown>) => {
		const parsed = templateInput.safeParse(input(over));
		return parsed.success ? null : (parsed.error.issues[0]?.message ?? "");
	};

	it("takes a name, a subject, a body and the variables they use", () => {
		const parsed = templateInput.parse(input({ name: "  Welcome  ", body: "a {{name}}\r\nb" }));
		expect(parsed.name).toBe("Welcome");
		expect(parsed.body).toBe("a {{name}}\nb");
		expect(why({})).toBeNull();
	});

	it("refuses a variable used and not declared, and one declared and never used", () => {
		expect(why({ variables: [] })).toMatch(/\{\{name\}\} is used but isn't declared/);
		expect(why({ subject: "Hi {{name}} {{other}}" })).toMatch(/\{\{other\}\} is used/);
		expect(why({ variables: ["name", "extra"] })).toMatch(/extra is declared but never used/);
		expect(why({ subject: "Hi", body: "Hello {{name}}" })).toBeNull();
		expect(why({ subject: "Hi", body: "Hello", variables: ["name"] })).toMatch(/never used/);
	});

	it("refuses bad names, repeated ones, and more than 20 variables", () => {
		expect(why({ variables: ["Name"] })).toMatch(/isn't a name/);
		expect(why({ variables: ["name", "name"] })).toMatch(/declared twice/);
		const names = Array.from({ length: MAX_VARIABLES + 1 }, (_, n) => `v${n}`);
		const body = names.map((name) => `{{${name}}}`).join(" ");
		expect(why({ subject: "Hi", body, variables: names })).toMatch(/20 variables at most/);
		const twenty = names.slice(0, MAX_VARIABLES);
		expect(
			why({
				subject: "Hi",
				body: twenty.map((name) => `{{${name}}}`).join(" "),
				variables: twenty,
			}),
		).toBeNull();
	});

	it("refuses a {{ that isn't a variable, and the characters that stand for variables", () => {
		expect(why({ body: "Hello {{name}} and {{" })).toMatch(/In the body: Line 1/);
		expect(why({ subject: "Hi {{ name }}" })).toMatch(/In the subject/);
		expect(why({ body: `Hello {{name}} ${PRIVATE_USE}` })).toMatch(/private use/);
		expect(why({ subject: `Hi {{name}}${PRIVATE_USE}` })).toMatch(/private use/);
	});

	it("keeps to the limits a message has, and refuses empty parts", () => {
		expect(why({ subject: `{{name}}${"x".repeat(MAX_SUBJECT)}` })).toBeTruthy();
		expect(why({ body: `{{name}}${"x".repeat(MAX_TEXT)}` })).toBeTruthy();
		expect(why({ name: "  " })).toMatch(/name/);
		expect(why({ name: "x".repeat(101) })).toMatch(/100 characters/);
		expect(why({ name: "line\nbreak" })).toMatch(/line break/);
		expect(why({ subject: "Hi {{name}}\nBcc: x@evil.example" })).toMatch(/subject/);
		expect(why({ body: "   " })).toMatch(/body/);
	});

	it("refuses what can't be rendered, such as a variable in a link", () => {
		expect(why({ body: "[{{name}}](https://example.com)" })).toMatch(/can't be in a link/);
	});

	it("reads a template and says its variables as the page does", () => {
		expect(usedVariables("Hi {{b}}", "{{a}} {{b}} {{c}}")).toEqual(["b", "a", "c"]);
		expect(usedVariables("Hi", "no variables")).toEqual([]);
		expect(usedVariables("Hi {{", "")).toMatch(/In the subject|Line 1/);
		expect(readTemplate(content("Hi", "Body", [])).ok).toBe(true);
		expect(sampleValues(["a", "b"])).toEqual({ a: "a", b: "b" });
		expect(nameKey("Welcome")).toBe(nameKey("WELCOME"));
		expect(MAX_TEMPLATES).toBe(200);
	});
});

describe("a variable beside a link", () => {
	const body = (text: string) => content("Hi", text, ["x"]);
	const why = (text: string) => {
		const result = renderTemplate(body(text), { x: ".evil.com" });
		return result.ok ? null : result.error;
	};

	it("is refused directly after a link, which would read as one place with it", () => {
		// `[bank](https://bank.example){{x}}` with ".evil.com" shows "bank.evil.com" to a reader.
		expect(why("[bank](https://bank.example){{x}}")).toMatch(/\{\{x\}\} is too close to a link/);
		expect(why("*Hi*\n\n**[bank](https://bank.example)**{{x}}")).toMatch(/too close to a link/);
	});

	it("is refused directly before a link", () => {
		expect(why("{{x}}[bank](https://bank.example)")).toMatch(/\{\{x\}\} is too close to a link/);
		expect(why("{{x}}**[bank](https://bank.example)**")).toMatch(/too close to a link/);
	});

	it("is refused when only marks or letters separate them, as formatting.ts reads up to a space", () => {
		expect(why("[bank](https://bank.example)-{{x}}")).toMatch(/too close to a link/);
		expect(why("[bank](https://bank.example)abc{{x}}")).toMatch(/too close to a link/);
	});

	it("is allowed after a space or a line break, where formatting.ts stops reading", () => {
		expect(why("[bank](https://bank.example) {{x}}")).toBeNull();
		expect(why("{{x}} [bank](https://bank.example)")).toBeNull();
		expect(why("[bank](https://bank.example)\n{{x}}")).toBeNull();
	});

	it("is allowed beyond the 64 characters formatting.ts reads around a link", () => {
		expect(why(`[bank](https://bank.example)${"a".repeat(70)}{{x}}`)).toBeNull();
		expect(why(`{{x}}${"a".repeat(70)}[bank](https://bank.example)`)).toBeNull();
		// Just inside the reach it is refused.
		expect(why(`[bank](https://bank.example)${"a".repeat(60)}{{x}}`)).toMatch(/too close/);
	});

	it("is refused at save, naming the variable", () => {
		const parsed = templateInput.safeParse({
			name: "T",
			subject: "Hi",
			body: "[bank](https://bank.example){{x}}",
			variables: ["x"],
		});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain("{{x}}");
	});

	it("takes time that grows with the text, with many links", () => {
		const text = "[a](https://x.example){{x}} ".repeat(3000);
		const started = performance.now();
		renderTemplate(body(`${text}\n${"](".repeat(40_000)}`), { x: "v" });
		expect(performance.now() - started).toBeLessThan(5000);
	});
});

describe("names as variables and values", () => {
	it("looks values up as the template's own, never on Object.prototype", () => {
		const template = content("Hi {{constructor}}", "Body {{constructor}}", ["constructor"]);
		expect(renderTemplate(template, {})).toEqual({ ok: false, error: "No value for constructor." });
		expect(renderTemplate(template, { constructor: "ok" })).toMatchObject({
			ok: true,
			subject: "Hi ok",
		});
		// A name given that the template doesn't have, among those every object has.
		for (const name of ["toString", "valueOf", "hasOwnProperty", "constructor"]) {
			const plain = content("Hi", "Body", []);
			expect(renderTemplate(plain, { [name]: "x" }), name).toEqual({
				ok: false,
				error: `${name}: this template has no such variable.`,
			});
		}
		// As JSON gives it, `__proto__` is a name of its own.
		const proto = JSON.parse('{"__proto__": "x"}') as Record<string, unknown>;
		expect(renderTemplate(content("Hi", "Body", []), proto)).toEqual({
			ok: false,
			error: "__proto__: this template has no such variable.",
		});
		expect(renderTemplate(template, JSON.parse('{"__proto__": "x"}'))).toEqual({
			ok: false,
			error: "__proto__: this template has no such variable.",
		});
	});

	it("folds a template's name by NFKC, lower case, ß and a final sigma", () => {
		expect(nameKey("STRASSE")).toBe(nameKey("Straße"));
		expect(nameKey("Straße")).toBe("strasse");
		expect(nameKey("ΟΔΟΣ")).toBe(nameKey("οδος"));
		expect(nameKey("οδος")).toBe(nameKey("οδοσ"));
		expect(nameKey("Ｗelcome")).toBe("welcome");
		expect(nameKey("Welcome")).not.toBe(nameKey("Welcomes"));
	});
});
