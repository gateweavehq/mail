import { describe, expect, it } from "vitest";
import { fileNameRefusal, MAX_ATTACHMENT_BYTES } from "../../lib/outbox";
import { base64Size, checkFiles, typeOfName } from "./files";

const file = (filename: string, content = "aGk=", more: Record<string, string> = {}) => ({
	filename,
	content,
	...more,
});

describe("fileNameRefusal", () => {
	it("refuses the kinds of file Resend won't send, however they are written", () => {
		for (const name of [
			"setup.exe",
			"SETUP.EXE",
			"run.bat",
			".js",
			"a.pdf.exe",
			"a.exe.",
			"a.exe  ",
		]) {
			expect(fileNameRefusal(name)).toMatch(/^Mail doesn't send \.(exe|bat|js) files/);
		}
		for (const name of ["report.pdf", "photo.JPG", "notes", "archive.tar.gz", "exe", "a.exes"]) {
			expect(fileNameRefusal(name)).toBeNull();
		}
	});

	it("refuses a name with a path, a control character, or none at all", () => {
		for (const name of [
			"../secret.pdf",
			"a\\b.pdf",
			"a\r\nb.pdf",
			"tab\there.pdf",
			"a\u0085b.pdf",
			" ",
			"..",
			". .",
			"x".repeat(201),
		]) {
			expect(fileNameRefusal(name)).not.toBeNull();
		}
	});

	it("refuses a name that mail would read as another, or that shows as another", () => {
		// Encoded words a reader decodes: "evil.exe", and a path.
		for (const name of [
			"=?utf-8?B?ZXZpbC5leGU=?=",
			"report =?utf-8?Q?..=2F..=2Fetc=2Fpasswd?=",
			"invoice\u202efdp.html",
			"a\u2066b.pdf",
		]) {
			expect(fileNameRefusal(name)).not.toBeNull();
		}
		expect(fileNameRefusal("Rapor — Ekim (müşteri).pdf")).toBeNull();
	});
});

describe("checkFiles", () => {
	it("takes files with their types, from the name when none is given", () => {
		const checked = checkFiles(
			[
				file(" invoice.pdf "),
				file("data.bin", "aGk=", { contentType: "Application/X-Thing" }),
				file("logo.png", "aGk=", { contentId: "logo" }),
				file("readme", "aGk=\n"),
			],
			{ html: true },
		);
		const typed = { content: "aGk=", bytes: 2 };
		expect(checked).toEqual({
			ok: true,
			bytes: 8,
			files: [
				{ filename: "invoice.pdf", type: "application/pdf", contentId: null, ...typed },
				{ filename: "data.bin", type: "application/x-thing", contentId: null, ...typed },
				{ filename: "logo.png", type: "image/png", contentId: "logo", ...typed },
				{ filename: "readme", type: "application/octet-stream", contentId: null, ...typed },
			],
		});
	});

	it("refuses what can't go", () => {
		const refused = [
			Array.from({ length: 21 }, (_, i) => file(`${i}.txt`)),
			[file("setup.exe")],
			[file("a.txt", "not base64!")],
			[file("a.txt", "aGk")],
			[file("a.txt", "")],
			[file("a.txt", "aGk=", { contentType: "multipart/mixed" })],
			[file("a.txt", "aGk=", { contentType: "text" })],
			[file("a.png", "aGk=", { contentId: "<logo>" })],
			[file("a.png", "aGk=", { contentId: "lo go" })],
			[file("a.png", "aGk=", { contentId: "logo" }), file("b.png", "aGk=", { contentId: "LOGO" })],
			// Inline, only an image the page shows: a text part would be read as the message's text.
			[file("notes.txt", "aGk=", { contentId: "notes" })],
			[file("page.html", "aGk=", { contentId: "page" })],
			[file("logo.svg", "aGk=", { contentId: "logo" })],
		];
		for (const given of refused) expect(checkFiles(given, { html: true }).ok).toBe(false);
		// And only beside HTML that may show it.
		expect(checkFiles([file("a.png", "aGk=", { contentId: "logo" })], { html: false })).toEqual({
			ok: false,
			error: "a.png has a content id, but there is no HTML to show it.",
		});
	});

	it("takes 10 MB of files together, and not a byte more", () => {
		// Two files of the same size, and the 4 bytes left after them.
		const half = "A".repeat(((MAX_ATTACHMENT_BYTES - 4) / 2 / 3) * 4);
		expect(base64Size(half)).toBe((MAX_ATTACHMENT_BYTES - 4) / 2);
		const fits = checkFiles([file("a.bin", half), file("b.bin", half), file("c.bin", "AAAAAA==")], {
			html: false,
		});
		expect(fits.ok && fits.bytes).toBe(MAX_ATTACHMENT_BYTES);
		expect(
			checkFiles([file("a.bin", half), file("b.bin", half), file("c.bin", "AAAAAAA=")], {
				html: false,
			}),
		).toEqual({
			ok: false,
			error: "A message's files can hold 10 MB together at most.",
		});
	});
});

it("names a type by the extension, or none it knows", () => {
	expect(typeOfName("A.DOCX")).toBe(
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	);
	expect(typeOfName("archive.unknown")).toBe("application/octet-stream");
});
