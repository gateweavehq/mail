import { describe, expect, it } from "vitest";
import {
	formatted,
	htmlOfText,
	insertLink,
	LINK_PLACEHOLDER,
	type TextEdit,
	toggleEmphasis,
	toggleLines,
} from "./formatting";

/** The text after an edit, with the selection shown as [ and ]. */
function applied(value: string, edit: TextEdit): string {
	const text = value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
	return `${text.slice(0, edit.selectFrom)}[${text.slice(edit.selectFrom, edit.selectTo)}]${text.slice(edit.selectTo)}`;
}

/** The value and selection from text with the selection shown as [ and ]. */
function selection(marked: string): [string, number, number] {
	const start = marked.indexOf("[");
	const end = marked.indexOf("]") - 1;
	return [marked.replace("[", "").replace("]", ""), start, end];
}

describe("the HTML that goes beside a message's text", () => {
	it("is none when the text uses no formatting", () => {
		expect(htmlOfText("Hello,\nsee you on Monday.\n\nAda")).toBeNull();
		// Mail programs link a bare address themselves, so one doesn't make a message formatted.
		expect(htmlOfText("The page is https://example.org/a and mail@example.org.")).toBeNull();
	});

	it("keeps each line break and paragraph", () => {
		expect(htmlOfText("**Hi**,\nline two\n\nNew one")).toBe(
			"<p><strong>Hi</strong>,<br>line two</p>\n<p>New one</p>\n",
		);
	});

	it("has bold, italic, links, lists and quotes", () => {
		expect(htmlOfText("**bold** and *italic*, or _italic_, not snake_case_words")).toBe(
			"<p><strong>bold</strong> and <em>italic</em>, or <em>italic</em>, not snake_case_words</p>\n",
		);
		expect(htmlOfText("[the page](https://example.org/a?b=1&c=2)")).toBe(
			'<p><a href="https://example.org/a?b=1&amp;c=2">the page</a></p>\n',
		);
		expect(htmlOfText("- one\n- two\n\n1. first\n2. second")).toBe(
			"<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n",
		);
		expect(htmlOfText("On Monday Ada wrote:\n> Hi\n> there")).toBe(
			"<p>On Monday Ada wrote:</p>\n<blockquote>\n<p>Hi<br>there</p>\n</blockquote>\n",
		);
	});

	it("leaves out what a message mustn't carry, and keeps it as it was typed", () => {
		const { html } = formatted(
			'<script>alert(1)</script> <b onclick="x">b</b> [run](javascript:alert(1)) [mail](mailto:a@example.org) ![a picture](https://example.org/p.png)',
		);
		expect(html).not.toMatch(/<script|<b |href="javascript|<img/);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("[run](javascript:alert(1))");
		expect(html).toContain('<a href="mailto:a@example.org">mail</a>');
		expect(html).toContain("![a picture](https://example.org/p.png)");
	});

	it("takes a bare host as a web address", () => {
		expect(htmlOfText("[us](example.org/about)")).toBe(
			'<p><a href="https://example.org/about">us</a></p>\n',
		);
		expect(formatted("[us](not a link)").html).not.toContain("<a");
	});

	it("keeps a link whose words are another address as it was typed", () => {
		expect(formatted("[https://bank.example](https://evil.example/login)").html).toBe(
			"<p>[https://bank.example](https://evil.example/login)</p>\n",
		);
		expect(formatted("[bank.example](https://BANK.example/login)").html).toBe(
			'<p><a href="https://BANK.example/login">bank.example</a></p>\n',
		);
		for (const spoof of [
			"[bank.example.](https://evil.example)",
			"[bank.example,](https://evil.example)",
			"[bank.example:443](https://evil.example)",
			"[bank.internal](https://evil.example)",
			"[Log in at https://bank.example](https://evil.example)",
			"[**https://bank.example**](https://evil.example)",
			"[ada@bank.example](mailto:eve@evil.example)",
			"[ada@bank.example](https://evil.example)",
		]) {
			expect(formatted(spoof).html).not.toContain("<a");
		}
		expect(formatted("[ada@bank.example](mailto:Ada@bank.example)").html).toContain(
			'<a href="mailto:Ada@bank.example">',
		);
		expect(formatted("[Your statement](https://bank.example/s)").html).toContain(
			'<a href="https://bank.example/s">',
		);
	});

	it("ends a link's address at its first closing parenthesis, as the toolbar writes them", () => {
		expect(formatted("[a](https://example.org/a)b) **x**").html).toBe(
			'<p><a href="https://example.org/a">a</a>b) <strong>x</strong></p>\n',
		);
		const [value, start, end] = selection("[https://example.org/a)]");
		const edit = insertLink(value, start, end);
		expect(edit.insert).toBe("[https://example.org/a)](https://example.org/a%29)");
		expect(formatted(edit.insert).html).toContain('href="https://example.org/a%29"');
	});

	it("keeps a task list's boxes as they were typed", () => {
		expect(htmlOfText("- [ ] milk\n- [x] bread")).toBe(
			"<ul>\n<li>[ ] milk</li>\n<li>[x] bread</li>\n</ul>\n",
		);
	});

	it("reads nothing in a quote as a mark, so a reply's quote goes as it came", () => {
		expect(
			htmlOfText(
				"Thanks!\n> **Pay** at [https://bank.example](https://evil.example)\n> > Earlier\n> Bye",
			),
		).toBe(
			"<p>Thanks!</p>\n<blockquote>\n<p>**Pay** at [https://bank.example](https://evil.example)</p>\n<blockquote>\n<p>Earlier</p>\n</blockquote>\n<p>Bye</p>\n</blockquote>\n",
		);
	});

	it("keeps lines that look like headings, rules or code as they were typed", () => {
		expect(formatted("Total\n# 3 of them\n---\n```\n    indented\n===").html).toBe(
			"<p>Total<br># 3 of them<br>---<br>```<br>&nbsp;&nbsp;&nbsp; indented<br>===</p>\n",
		);
		expect(formatted("> # not a heading\n> ---").html).toBe(
			"<blockquote>\n<p># not a heading<br>---</p>\n</blockquote>\n",
		);
		expect(formatted("`code` and ~~struck~~").html).toBe("<p>`code` and ~~struck~~</p>\n");
		expect(formatted("**Plan**\n<div>a</div>\n| a | b |\n|---|---|").html).toBe(
			"<p><strong>Plan</strong><br>&lt;div&gt;a&lt;/div&gt;<br>| a | b |<br>|---|---|</p>\n",
		);
		expect(formatted("**a**\n-\n+\nb").html).toBe("<p><strong>a</strong><br>-<br>+<br>b</p>\n");
	});

	it("keeps backslashes, entities and runs of spaces as they were typed", () => {
		expect(formatted("**Share:** \\\\fileserver\\team\\*draft*").html).toBe(
			"<p><strong>Share:</strong> \\\\fileserver\\team\\<em>draft</em></p>\n",
		);
		expect(formatted("**x** C:\\Users\\_tmp_ and \\\nend").html).toBe(
			"<p><strong>x</strong> C:\\Users\\_tmp_ and \\<br>end</p>\n",
		);
		expect(formatted("write &lt;br&gt; or &#60; **x**").html).toBe(
			"<p>write &amp;lt;br&amp;gt; or &amp;#60; <strong>x</strong></p>\n",
		);
		expect(formatted("Name    Value **x**").html).toBe(
			"<p>Name&nbsp;&nbsp;&nbsp; Value <strong>x</strong></p>\n",
		);
	});

	it("pairs bold and italic as they nest, and leaves a lone mark as it is", () => {
		expect(htmlOfText("**bold *both* bold** and ***all***")).toBe(
			"<p><strong>bold <em>both</em> bold</strong> and <strong><em>all</em></strong></p>\n",
		);
		expect(htmlOfText("*a **b* c** and a * b and 2*3*4")).toBe(
			"<p><em>a **b</em> c** and a * b and 2<em>3</em>4</p>\n",
		);
	});

	it("ends a list at a line that doesn't start with a space", () => {
		expect(htmlOfText("- one\n- two\nThanks,\nAda")).toBe(
			"<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<p>Thanks,<br>Ada</p>\n",
		);
		expect(htmlOfText("1. one\n   more\n2. two")).toBe(
			"<ol>\n<li>one<br>more</li>\n<li>two</li>\n</ol>\n",
		);
	});

	it("starts a numbered list only from 1, so that a date stays a date", () => {
		expect(htmlOfText("9. November suits us")).toBeNull();
		expect(formatted("Dates:\n9. November\n10. December").html).toBe(
			"<p>Dates:<br>9. November<br>10. December</p>\n",
		);
		expect(htmlOfText("1. first\n2. second")).toBe(
			"<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n",
		);
	});

	it("goes on with a numbered list only at the next number, across a blank line too", () => {
		expect(htmlOfText("Agenda:\n1. Budget\n2. Hiring\n\n15. November works for me.")).toBe(
			"<p>Agenda:</p>\n<ol>\n<li>Budget</li>\n<li>Hiring</li>\n</ol>\n<p>15. November works for me.</p>\n",
		);
		expect(htmlOfText("1. a\n3. b")).toBe("<ol>\n<li>a</li>\n</ol>\n<p>3. b</p>\n");
		expect(htmlOfText("1. a\n2) b")).toBe("<ol>\n<li>a</li>\n</ol>\n<p>2) b</p>\n");
		expect(htmlOfText("1. a\n\n2. b")).toBe("<ol>\n<li>a</li>\n<li>b</li>\n</ol>\n");
	});

	it("finishes soon and whole on text no one would write", () => {
		const long = 100_000;
		for (const text of [
			"* ".repeat(long / 2),
			">".repeat(long),
			"> ".repeat(long / 2),
			"*a **a ".repeat(long / 7),
			"a_".repeat(long / 2),
			"*".repeat(long),
			"*a(".repeat(long / 3),
			"[_a".repeat(long / 3),
			"*a_".repeat(long / 3),
			"f(*p);\n".repeat(long / 7),
			"[".repeat(long),
			"[a](".repeat(long / 4),
			`[${"a.".repeat(long / 2)}](https://example.org)`,
			"- a\n".repeat(long / 4),
			Array.from({ length: 3000 }, (_, i) => `${" ".repeat(i)}- a`).join("\n"),
		]) {
			const began = performance.now();
			const { html } = formatted(text);
			expect(performance.now() - began).toBeLessThan(2000);
			expect(html.length).toBeGreaterThan(0);
		}
	});

	it("reads Windows line ends as line ends", () => {
		expect(htmlOfText("**a**\r\nb")).toBe("<p><strong>a</strong><br>b</p>\n");
	});
});

describe("bold and italic from the toolbar", () => {
	it("wraps the selection and keeps it selected", () => {
		expect(applied(...selectionAnd("Say [hello] now", 2))).toBe("Say **[hello]** now");
		expect(applied(...selectionAnd("Say [hello] now", 1))).toBe("Say *[hello]* now");
	});

	it("makes part of a word italic", () => {
		expect(applied(...selectionAnd("un[believ]able", 1))).toBe("un*[believ]*able");
		expect(htmlOfText("un*believ*able")).toBe("<p>un<em>believ</em>able</p>\n");
	});

	it("leaves the spaces at a selection's ends outside the marks", () => {
		expect(applied(...selectionAnd("Say[ hello ]now", 2))).toBe("Say **[hello]** now");
	});

	it("puts the caret between the marks when nothing is selected, and takes them off again", () => {
		expect(applied(...selectionAnd("Say [] now", 2))).toBe("Say **[]** now");
		expect(applied(...selectionAnd("Say **[]** now", 2))).toBe("Say [] now");
	});

	it("takes the marks off again, inside or around the selection", () => {
		expect(applied(...selectionAnd("Say **[hello]** now", 2))).toBe("Say [hello] now");
		expect(applied(...selectionAnd("Say [**hello**] now", 2))).toBe("Say [hello] now");
		expect(applied(...selectionAnd("Say *[hello]* now", 1))).toBe("Say [hello] now");
	});

	it("tells bold from italic, and both from either", () => {
		expect(applied(...selectionAnd("Say **[hello]** now", 1))).toBe("Say ***[hello]*** now");
		expect(applied(...selectionAnd("Say ***[hello]*** now", 2))).toBe("Say *[hello]* now");
		expect(applied(...selectionAnd("Say ***[hello]*** now", 1))).toBe("Say **[hello]** now");
		expect(applied(...selectionAnd("Say *[hello]* now", 2))).toBe("Say ***[hello]*** now");
	});

	it("makes a selection bold as a whole, taking off the bold already inside it", () => {
		expect(applied(...selectionAnd("[**Note:** read the **docs**]", 2))).toBe(
			"**[Note: read the docs]**",
		);
		expect(applied(...selectionAnd("[*a* and *b*]", 1))).toBe("*[a and b]*");
		expect(applied(...selectionAnd("[**Note: read the docs**]", 2))).toBe("[Note: read the docs]");
	});

	it("marks each line of a selection on its own, as a mark can't span lines", () => {
		expect(applied(...selectionAnd("one [two\n\nthree] four", 2))).toBe(
			"one [**two**\n\n**three**] four",
		);
		expect(applied(...selectionAnd("one [**two**\n**three**] four", 2))).toBe(
			"one [two\nthree] four",
		);
		expect(htmlOfText("one **two**\n**three** four")).toBe(
			"<p>one <strong>two</strong><br><strong>three</strong> four</p>\n",
		);
	});
});

/** The arguments for toggleEmphasis from text with the selection marked, and the value for applied. */
function selectionAnd(marked: string, stars: 1 | 2): [string, TextEdit] {
	const [value, start, end] = selection(marked);
	return [value, toggleEmphasis(value, start, end, stars)];
}

describe("a link from the toolbar", () => {
	it("keeps selected words and selects the address to type", () => {
		const [value, start, end] = selection("See [our page] today");
		expect(applied(value, insertLink(value, start, end))).toBe(
			`See [our page]([${LINK_PLACEHOLDER}]) today`,
		);
	});

	it("makes a selected address the link's words and address", () => {
		const [value, start, end] = selection("See [https://example.org] today");
		expect(applied(value, insertLink(value, start, end))).toBe(
			"See [[https://example.org]](https://example.org) today",
		);
	});

	it("leaves the spaces at a selection's ends outside the link", () => {
		const [value, start, end] = selection("See[ our page ]today");
		expect(applied(value, insertLink(value, start, end))).toBe(
			`See [our page]([${LINK_PLACEHOLDER}]) today`,
		);
	});

	it("waits for the words when nothing is selected", () => {
		const [value, start, end] = selection("See [] today");
		expect(applied(value, insertLink(value, start, end))).toBe(
			`See [[]](${LINK_PLACEHOLDER}) today`,
		);
	});
});

describe("lists and quotes from the toolbar", () => {
	it("makes each line the selection touches a list item, and numbers them", () => {
		const value = "Bring:\nbread\n\nmilk\nThanks";
		const start = value.indexOf("ead");
		const end = value.indexOf("lk");
		expect(toggleLines(value, start, end, "bullet").insert).toBe("- bread\n\n- milk");
		expect(toggleLines(value, start, end, "number").insert).toBe("1. bread\n\n2. milk");
	});

	it("turns one kind of list into the other", () => {
		expect(toggleLines("- a\n- b", 0, 7, "number").insert).toBe("1. a\n2. b");
	});

	it("quotes blank lines too, so that the quote holds together", () => {
		expect(toggleLines("a\n\nb", 0, 4, "quote").insert).toBe("> a\n>\n> b");
	});

	it("makes them plain lines again when they all are already", () => {
		expect(toggleLines("- a\n- b", 2, 5, "bullet").insert).toBe("a\nb");
		expect(toggleLines("> a\n>\n> b", 0, 9, "quote").insert).toBe("a\n\nb");
	});

	it("doesn't take the line after a selection that ends at its start", () => {
		const edit = toggleLines("a\nb", 0, 2, "bullet");
		expect(edit.insert).toBe("- a");
		expect([edit.from, edit.to]).toEqual([0, 1]);
	});

	it("takes the caret's line when nothing is selected, and keeps the caret in its place", () => {
		expect(toggleLines("a\nb\nc", 2, 2, "quote")).toMatchObject({ from: 2, to: 3, insert: "> b" });
		expect(applied("hello", toggleLines("hello", 3, 3, "bullet"))).toBe("- hel[]lo");
		expect(applied("- hello", toggleLines("- hello", 5, 5, "bullet"))).toBe("hel[]lo");
		expect(applied("- hello", toggleLines("- hello", 1, 1, "bullet"))).toBe("[]hello");
	});

	it("takes the first line for a caret at the start, though the text starts with a blank line", () => {
		expect(applied("\nb", toggleLines("\nb", 0, 0, "bullet"))).toBe("- []\nb");
	});

	it("gives a blank line its mark, to write after", () => {
		expect(applied("a\n\nb", toggleLines("a\n\nb", 2, 2, "bullet"))).toBe("a\n- []\nb");
		expect(applied("a\n\nb", toggleLines("a\n\nb", 2, 2, "number"))).toBe("a\n1. []\nb");
		expect(applied("", toggleLines("", 0, 0, "quote"))).toBe("> []");
	});
});
