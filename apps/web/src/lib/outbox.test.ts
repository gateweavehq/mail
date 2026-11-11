import { describe, expect, it } from "vitest";
import { htmlOfText } from "./formatting";
import {
	addedFilesRefusal,
	keptContext,
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS,
	MAX_CONTEXT_LABEL,
	MAX_CONTEXT_URL,
	quoted,
	sendableType,
	sentContext,
} from "./outbox";

const file = (name: string, size = 100) => ({ name, size });

describe("files added to a message", () => {
	it("may be added within the limits", () => {
		expect(addedFilesRefusal([file("a.pdf")], [file("b.txt"), file("c.png")])).toBeNull();
	});

	it("are refused for a kind mail servers refuse, or when empty", () => {
		expect(addedFilesRefusal([], [file("a.pdf"), file("setup.exe")])).toMatch(/\.exe files/);
		expect(addedFilesRefusal([], [file("notes.txt", 0)])).toBe("notes.txt is empty.");
	});

	it("are refused past the number a message carries, counting those it has", () => {
		const has = Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, at) => file(`${at}.txt`));
		expect(addedFilesRefusal(has, [file("last.txt")])).toBeNull();
		expect(addedFilesRefusal(has, [file("last.txt"), file("over.txt")])).toBe(
			`One message can carry at most ${MAX_ATTACHMENTS} files.`,
		);
	});

	it("are refused past the size a message's files hold together", () => {
		const half = MAX_ATTACHMENT_BYTES / 2;
		expect(addedFilesRefusal([file("a.pdf", half)], [file("b.pdf", half)])).toBeNull();
		expect(addedFilesRefusal([file("a.pdf", half)], [file("b.pdf", half + 1)])).toBe(
			"A message's files can hold 10 MB together at most.",
		);
	});
});

describe("the type a file goes with", () => {
	it("is the browser's, or none for the server to tell from the name", () => {
		expect(sendableType("application/pdf")).toBe("application/pdf");
		expect(sendableType("")).toBeNull();
	});

	it("is bytes for a message or a multipart, which mail can't carry as their own in Base64", () => {
		expect(sendableType("message/rfc822")).toBe("application/octet-stream");
		expect(sendableType("Multipart/Mixed")).toBe("application/octet-stream");
	});
});

describe("a reply's quote", () => {
	it("quotes each line under who wrote it", () => {
		expect(quoted("Hi\r\n\nBye\n", "On Monday Ada wrote:")).toBe(
			"\n\nOn Monday Ada wrote:\n> Hi\n>\n> Bye",
		);
	});

	it("keeps a sender's name from making a link above the quote", () => {
		const text = quoted("Hi", "On Monday [Your bank](https://evil.example) wrote:");
		expect(text).toContain("On Monday Your bank(https://evil.example) wrote:");
		expect(htmlOfText(`Thanks${text}`) ?? "").not.toContain("<a");
	});
});

describe("what a message was written for", () => {
	it("is an https link, written as the URL parser writes it, with a label", () => {
		expect(
			sentContext({ url: " https://github.com/acme/app/actions/runs/123 ", label: " CI run 123 " }),
		).toEqual({ url: "https://github.com/acme/app/actions/runs/123", label: "CI run 123" });
		expect(sentContext({ url: "https://GitHub.com/acme/app/pull/7#top" })).toEqual({
			url: "https://github.com/acme/app/pull/7#top",
			label: null,
		});
		// A host in another script shows as the punycode it is, whatever the label says.
		expect(sentContext({ url: "https://\u0430pple.com/", label: "apple.com" })).toEqual({
			url: "https://xn--pple-43d.com/",
			label: "apple.com",
		});
	});

	it("is refused when it isn't an https link, or carries a name or password", () => {
		for (const url of [
			"http://example.com/run/1",
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"ftp://example.com/",
			"//example.com/run/1",
			"run 123",
			"",
		]) {
			expect(typeof sentContext({ url }), url).toBe("string");
		}
		expect(sentContext({ url: "https://user:secret@example.com/" })).toBe(
			"The context's url can't carry a user name or password.",
		);
		expect(sentContext({ url: `https://example.com/${"a".repeat(MAX_CONTEXT_URL)}` })).toBe(
			`The context's url can be ${MAX_CONTEXT_URL} characters at most.`,
		);
	});

	it("has a label without characters that would turn it around or hide it", () => {
		expect(
			sentContext({ url: "https://example.com/", label: "Issue\u202e24-GNE\u202c\n\tfixed\u200b" }),
		).toEqual({
			url: "https://example.com/",
			label: "Issue 24-GNE fixed",
		});
		expect(sentContext({ url: "https://example.com/", label: " \u200b " })).toEqual({
			url: "https://example.com/",
			label: null,
		});
		expect(
			sentContext({ url: "https://example.com/", label: "a".repeat(MAX_CONTEXT_LABEL + 1) }),
		).toBe(`The context's label can be ${MAX_CONTEXT_LABEL} characters at most.`);
	});

	it("is read back only as it was kept", () => {
		expect(keptContext('{"url":"https://example.com/","label":"Run"}')).toEqual({
			url: "https://example.com/",
			label: "Run",
		});
		expect(keptContext('{"url":"https://example.com/","label":null}')?.label).toBeNull();
		expect(keptContext('{"url":"javascript:alert(1)"}')).toBeNull();
		expect(keptContext("not json")).toBeNull();
		expect(keptContext(null)).toBeNull();
	});
});
