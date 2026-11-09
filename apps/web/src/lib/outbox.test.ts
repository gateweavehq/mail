import { describe, expect, it } from "vitest";
import { addedFilesRefusal, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, sendableType } from "./outbox";

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
