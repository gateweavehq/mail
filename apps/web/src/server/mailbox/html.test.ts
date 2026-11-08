import { describe, expect, it } from "vitest";
import { MAX_SHOWN_HTML, mayLoadImages } from "./html";

describe("mayLoadImages", () => {
	it("sees an image or a CSS address on the web", () => {
		expect(mayLoadImages('<img src="https://images.example/a.png">')).toBe(true);
		expect(mayLoadImages("<IMG SRC = 'HTTP://images.example/a.png'>")).toBe(true);
		expect(mayLoadImages("<img src=//images.example/a.png>")).toBe(true);
		expect(mayLoadImages("<div style=\"background: url( 'https://images.example/a.png')\">")).toBe(
			true,
		);
	});

	it("doesn't count what showing remote images wouldn't load", () => {
		expect(mayLoadImages('<img src="cid:logo@shop.example">')).toBe(false);
		expect(mayLoadImages('<img src="data:image/png;base64,AAAA">')).toBe(false);
		expect(mayLoadImages('<a href="https://shop.example/">https://shop.example/</a>')).toBe(false);
		// The cleaning removes these attributes, so they never load.
		expect(mayLoadImages('<td background="https://images.example/a.png">')).toBe(false);
		expect(mayLoadImages('<img srcset="https://images.example/a.png 2x">')).toBe(false);
	});

	it("reads only as much as is shown", () => {
		const late = `${" ".repeat(MAX_SHOWN_HTML)}<img src="https://images.example/a.png">`;
		expect(mayLoadImages(late)).toBe(false);
	});

	// A mail made of one long run of spaces once took minutes here, on every open of its thread.
	it("takes a moment however the spaces fall", () => {
		for (const html of [
			`<img src=${" ".repeat(MAX_SHOWN_HTML)}>`,
			`<img src   ${" ".repeat(MAX_SHOWN_HTML)}>`,
			`url(${"\" '".repeat(MAX_SHOWN_HTML / 3)}`,
			"<img src= ".repeat(MAX_SHOWN_HTML / 10),
		]) {
			const started = performance.now();
			expect(mayLoadImages(html)).toBe(false);
			expect(performance.now() - started).toBeLessThan(500);
		}
	});
});
