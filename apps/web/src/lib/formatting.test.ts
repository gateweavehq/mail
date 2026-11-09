import { describe, expect, it } from "vitest";
import {
	formatted,
	htmlOfText,
	insertLink,
	LINK_PLACEHOLDER,
	type TextEdit,
	toggleLines,
	toggleMark,
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
		expect(htmlOfText("**bold** and _italic_, not snake_case_words")).toBe(
			"<p><strong>bold</strong> and <em>italic</em>, not snake_case_words</p>\n",
		);
		expect(htmlOfText("[the page](https://example.org/a?b=1&c=2)")).toBe(
			'<p><a href="https://example.org/a?b=1&#38;c=2">the page</a></p>\n',
		);
		expect(htmlOfText("- one\n- two\n\n1. first\n2. second")).toBe(
			"<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n",
		);
		expect(htmlOfText("On Monday Ada wrote:\n> Hi\n> there")).toBe(
			"<p>On Monday Ada wrote:</p>\n<blockquote>\n<p>Hi<br>there</p>\n</blockquote>\n",
		);
	});

	it("leaves out what a message mustn't carry, and keeps its words", () => {
		const { html } = formatted(
			'<script>alert(1)</script> <b onclick="x">b</b> [run](javascript:alert(1)) [mail](mailto:a@example.org) ![a picture](https://example.org/p.png)',
		);
		expect(html).not.toMatch(/<script|<b |javascript:|<img/);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain(" run ");
		expect(html).toContain('<a href="mailto:a@example.org">mail</a>');
		expect(html).toContain("a picture");
	});

	it("takes a bare host as a web address", () => {
		expect(htmlOfText("[us](example.org/about)")).toBe(
			'<p><a href="https://example.org/about">us</a></p>\n',
		);
		expect(formatted("[us](not a link)").html).not.toContain("<a");
	});

	it("keeps lines that look like headings, rules or code as they were typed", () => {
		expect(formatted("Total\n# 3 of them\n---\n```\n    indented\n===").html).toBe(
			"<p>Total<br># 3 of them<br>---<br>```<br>indented<br>===</p>\n",
		);
		expect(formatted("> # not a heading\n> ---").html).toBe(
			"<blockquote>\n<p># not a heading<br>---</p>\n</blockquote>\n",
		);
		expect(formatted("`code` and ~~struck~~").html).toBe("<p>`code` and ~~struck~~</p>\n");
	});

	it("reads Windows line ends as line ends", () => {
		expect(htmlOfText("**a**\r\nb")).toBe("<p><strong>a</strong><br>b</p>\n");
	});
});

describe("bold and italic from the toolbar", () => {
	it("wraps the selection and keeps it selected", () => {
		expect(applied(...selectionAnd("Say [hello] now", "**"))).toBe("Say **[hello]** now");
		expect(applied(...selectionAnd("Say [hello] now", "_"))).toBe("Say _[hello]_ now");
	});

	it("leaves the spaces at a selection's ends outside the marks", () => {
		expect(applied(...selectionAnd("Say[ hello ]now", "**"))).toBe("Say **[hello]** now");
	});

	it("puts the caret between the marks when nothing is selected", () => {
		expect(applied(...selectionAnd("Say [] now", "**"))).toBe("Say **[]** now");
	});

	it("takes the marks off again, inside or around the selection", () => {
		expect(applied(...selectionAnd("Say **[hello]** now", "**"))).toBe("Say [hello] now");
		expect(applied(...selectionAnd("Say [**hello**] now", "**"))).toBe("Say [hello] now");
	});
});

/** The arguments for toggleMark from text with the selection marked, and the value for applied. */
function selectionAnd(marked: string, mark: string): [string, TextEdit] {
	const [value, start, end] = selection(marked);
	return [value, toggleMark(value, start, end, mark)];
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

	it("takes the caret's line when nothing is selected", () => {
		expect(toggleLines("a\nb\nc", 2, 2, "quote")).toMatchObject({ from: 2, to: 3, insert: "> b" });
	});
});
