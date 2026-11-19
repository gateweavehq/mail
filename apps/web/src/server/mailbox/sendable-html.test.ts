import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { discloseAgent } from "./disclosure";

// Use workerd's HTML parser with only the sanitizer modules loaded.
const source = (name: string) =>
	stripTypeScriptTypes(readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8"));
const worker = new Miniflare(
	convertV4MiniflareOptions({
		modules: [
			{
				type: "ESModule",
				path: "entry.js",
				contents: `
				import { sendableHtml } from "./html";
				export default {
					async fetch(request) {
						return new Response(await sendableHtml(await request.text(), {
							agent: new URL(request.url).pathname === "/agent",
						}));
					},
				};
			`,
			},
			{ type: "ESModule", path: "html", contents: source("html") },
			{ type: "ESModule", path: "agent-style", contents: source("agent-style") },
		],
	}),
);

afterAll(() => worker.dispose());

async function clean(html: string, agent = true) {
	const response = await worker.dispatchFetch(`https://mail.test/${agent ? "agent" : "person"}`, {
		method: "POST",
		body: html,
	});
	expect(response.status).toBe(200);
	return response.text();
}

describe("sendable HTML", () => {
	it("R2: drops both a complete stylesheet and a style element left unclosed", async () => {
		expect(
			await clean("<style>p:last-of-type{display:none}</style><p>Body</p><style>p{display:none}"),
		).toBe("<p>Body</p>");
	});

	it("R2: cleans hidden wrappers, overlays and negative margins while keeping safe styles", async () => {
		expect(
			await clean(
				'<div style="display:none; color:teal"><p style="position:absolute; margin:-2px">Body</p></div>',
			),
		).toBe('<div style="color:teal"><p>Body</p></div>');
	});

	it("R2: removes document styling and keeps ordinary table formatting", async () => {
		const style = [
			"padding-left:9999px",
			"margin-left:9999px",
			"width:1px",
			"max-width:1px",
			"min-width:9999px",
			"letter-spacing:-20px",
			"word-spacing:-100px",
			"font-family:Wingdings",
			"-webkit-text-size-adjust:1%",
			"text-shadow:0 0 1px white",
		].join("; ");
		const table =
			'<table style="width:600px; max-width:100%"><tr><th style="width:50%">Heading</th>' +
			'<td style="padding:8px 12px; color:navy; font-family:Arial, &quot;Segoe UI&quot;, sans-serif">' +
			'Body<img src="cid:test" style="width:48px; max-width:100%"></td></tr></table>';
		const html =
			`<html lang="en" bgcolor="black" style="${style}; color:red"><head></head>` +
			`<body dir="ltr" width="1" align="right" text="white" background="pic.png" link="red" style="${style}; color:red">` +
			`<div style="${style}">${table}</div></body></html>`;
		expect(await clean(html)).toBe(
			`<html lang="en"><head></head><body dir="ltr"><div>${table}</div></body></html>`,
		);
	});

	it("R1: inserts the notice after the mixed-case body tag in cleaned HTML", async () => {
		const cleaned = await clean(
			'<!doctype html><html><head><title>Mail</title></head><BODY  lang="en" ><div>Words</div></body></html>',
		);
		expect(discloseAgent("Bot", "Words", cleaned, false).html).toMatch(
			/^<!doctype html><html><head><\/head><BODY {2}lang="en" ><p [^>]+>This message was written by an AI agent \(Bot\)\.<\/p><div>Words<\/div><\/body><\/html>$/,
		);
	});

	it("R2/R4: preserves people's stylesheet and inline declarations", async () => {
		const html = '<style>p:last-of-type{display:none}</style><p style="position:absolute">Body</p>';
		expect(await clean(html, false)).toBe(html);
	});
});
