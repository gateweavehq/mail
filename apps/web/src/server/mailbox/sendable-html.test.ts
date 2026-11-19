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
		expect(await clean(html)).toBe(`<div lang="en"><div dir="ltr"><div>${table}</div></div></div>`);
	});

	it("R1: turns the agent's document shell into plain blocks, the notice first", async () => {
		const cleaned = await clean(
			'<!doctype html><html><head><title>Mail</title></head><BODY  lang="en" ><div>Words</div></body></html>',
		);
		expect(cleaned).toBe('<!doctype html><div><div lang="en"><div>Words</div></div></div>');
		expect(discloseAgent("Bot", "Words", cleaned, false).html).toMatch(
			/^<!doctype html><p [^>]+>This message was written by an AI agent \(Bot\)\.<\/p><div><div lang="en">/,
		);
	});

	it("R1: keeps the notice out of a <details> that holds a <body>", async () => {
		const cleaned = await clean(
			"<!doctype html><html><details><summary>More</summary><body><p>Hidden</p></body></details><p>Words</p></html>",
		);
		const html = discloseAgent("Bot", "Words", cleaned, false).html ?? "";
		const notice = html.indexOf("This message was written by an AI agent (Bot).");
		expect(notice).toBeGreaterThan(-1);
		expect(notice).toBeLessThan(html.indexOf("<details>"));
		expect(html).not.toMatch(/<body|<html|<head/i);
	});

	it("R1: puts the notice before text an agent left in <head>", async () => {
		const cleaned = await clean("<html><head>Unmarked</head><body>Body</body></html>");
		const html = discloseAgent("Bot", "Words", cleaned, false).html ?? "";
		expect(html.indexOf("This message was written by an AI agent (Bot).")).toBeLessThan(
			html.indexOf("Unmarked"),
		);
		expect(html).not.toMatch(/<body|<html|<head/i);
	});

	it("R2/R4: preserves people's stylesheet and inline declarations", async () => {
		const html = '<style>p:last-of-type{display:none}</style><p style="position:absolute">Body</p>';
		expect(await clean(html, false)).toBe(html);
	});
});
