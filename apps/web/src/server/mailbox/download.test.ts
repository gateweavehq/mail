import { describe, expect, it } from "vitest";
import { fileName } from "../../lib/file-names";
import { MAX_FILE_NAME } from "../../lib/outbox";
import { contentDisposition, downloadType, fileDownload } from "./download";

describe("a file's download", () => {
	it("keeps only stated types no browser runs", () => {
		expect(downloadType("application/pdf")).toBe("application/pdf");
		expect(downloadType("IMAGE/PNG; name=x.png")).toBe("image/png");
		expect(downloadType("text/plain; charset=utf-8")).toBe("text/plain");
		expect(
			downloadType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
		).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
		for (const active of [
			"text/html",
			"application/xhtml+xml",
			"image/svg+xml",
			"text/xml",
			"application/xml",
			"text/javascript",
			"application/javascript",
			"text/xsl",
			"multipart/x-mixed-replace",
			"application/pdf+html",
			"",
			"nonsense",
		]) {
			expect(downloadType(active), active).toBe("application/octet-stream");
		}
	});

	it("names it as its sender did, short of a path, a hidden file or reversed text", () => {
		expect(fileName("plan.pdf")).toBe("plan.pdf");
		expect(fileName("Rapor ğüş.txt")).toBe("Rapor ğüş.txt");
		expect(fileName("../../etc/passwd")).toBe("_.._etc_passwd");
		expect(fileName("C:\\Windows\\evil.bat")).toBe("C__Windows_evil.bat");
		expect(fileName(".bashrc")).toBe("bashrc");
		expect(fileName("invoice\u202efdp.exe")).toBe("invoicefdp.exe");
		expect(fileName('say "hi"\r\n.txt')).toBe("say _hi___.txt");
		expect(fileName(null)).toBe("attachment");
		expect(fileName("  ...  ")).toBe("attachment");
		expect(fileName(". .bashrc")).toBe("bashrc");
		expect(fileName("..  ..env")).toBe("env");
		expect(fileName("report\u061c.pdf")).toBe("report.pdf");
		expect(fileName("notes.txt  ")).toBe("notes.txt");
		// Cut by character, so one outside the first plane stays whole.
		const long = fileName("😀".repeat(MAX_FILE_NAME + 10));
		expect(Array.from(long)).toHaveLength(MAX_FILE_NAME);
		expect(long).toBe("😀".repeat(MAX_FILE_NAME));
	});

	it("says the name in UTF-8, and in ASCII for any browser that reads only that", () => {
		expect(contentDisposition("plan.pdf")).toBe(
			`attachment; filename="plan.pdf"; filename*=UTF-8''plan.pdf`,
		);
		expect(contentDisposition("Über (1)'s 100%.txt")).toBe(
			`attachment; filename="_ber (1)'s 100_.txt"; filename*=UTF-8''%C3%9Cber%20%281%29%27s%20100%25.txt`,
		);
		expect(contentDisposition("a\\b.txt")).toBe(
			`attachment; filename="a_b.txt"; filename*=UTF-8''a%5Cb.txt`,
		);
	});

	it("goes as a sandboxed download, whatever it says it is", async () => {
		const bytes = new TextEncoder().encode("<script>alert(1)</script>");
		const answer = fileDownload({ name: "page.html", type: "text/html", bytes });
		expect(Object.fromEntries(answer.headers)).toEqual({
			"content-type": "application/octet-stream",
			"content-length": String(bytes.byteLength),
			"content-disposition": `attachment; filename="page.html"; filename*=UTF-8''page.html`,
			"content-security-policy": "default-src 'none'; sandbox",
			"x-content-type-options": "nosniff",
			"cache-control": "private, no-store",
			"referrer-policy": "no-referrer",
			"cross-origin-resource-policy": "same-origin",
		});
		expect(new Uint8Array(await answer.arrayBuffer())).toEqual(bytes);
	});
});
