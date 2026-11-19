import { describe, expect, it } from "vitest";
import { discloseAgent } from "./disclosure";

describe("agent disclosure", () => {
	it("R1: flattens controls and line breaks and escapes the agent name in HTML", () => {
		const marked = discloseAgent(
			'Bot\r\n\u0085\u2028\u202e<script> & "O\'Neil"',
			"Words",
			"<p>Words",
			false,
		);
		expect(marked.text).toBe(
			'This message was written by an AI agent (Bot <script> & "O\'Neil").\n\nWords',
		);
		expect(marked.html).toMatch(
			/^<p [^>]+>This message was written by an AI agent \(Bot &lt;script&gt; &amp; &quot;O&#39;Neil&quot;\)\.<\/p><p>Words$/,
		);
	});

	it("R1: bounds the displayed name without cutting a surrogate pair in half", () => {
		const name = "X".repeat(79);
		expect(discloseAgent(`${name}🤖 end`, "Words", null, false).text).toBe(
			`This message was written by an AI agent (${name}).\n\nWords`,
		);
	});

	it("R1: puts the closed disclosure first inside the body of a complete document", () => {
		const opening = '<!doctype html><HTML><head> </head><BODY  lang="en" >';
		const marked = discloseAgent("Bot", "Words", `${opening}<div>Words</body></html>`, false);
		expect(marked.html?.slice(opening.length)).toMatch(
			/^<p [^>]+>This message was written by an AI agent \(Bot\)\.<\/p><div>Words<\/body><\/html>$/,
		);
		expect(marked.html?.startsWith(opening)).toBe(true);
	});

	it("R1: places the notice inside the body when the head contains markup", () => {
		const opening =
			'<!doctype html><html><head><meta name="sample" content="a > <body>"></head><body>';
		const body = "<div>Words</div></body></html>";
		expect(discloseAgent("Bot", "Words", opening + body, false).html).toBe(
			opening +
				'<p dir="ltr" style="font-size:13px;color:#555;background-color:#fff;letter-spacing:normal;word-spacing:normal;text-indent:0;text-shadow:none;text-transform:none;line-height:1.4;margin:0 0 16px;padding:8px 12px;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%">This message was written by an AI agent (Bot).</p>' +
				body,
		);
	});
});
