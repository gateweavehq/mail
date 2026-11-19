import { MAX_AGENT_NAME } from "../../lib/agent-policy";
import { textHtml } from "../../lib/formatting";

export const AI_DISCLOSURE_HEADER = "X-AI-Disclosure";

const DOCUMENT_START = /^\s*<(?:!doctype\s+html|html|head|body)(?=[\s/>])/i;
const NOTICE_STYLE = [
	"font-size:13px",
	"color:#555",
	"background-color:#fff",
	"letter-spacing:normal",
	"word-spacing:normal",
	"text-indent:0",
	"text-shadow:none",
	"text-transform:none",
	"line-height:1.4",
	"margin:0 0 16px",
	"padding:8px 12px",
	"font-family:Arial,Helvetica,sans-serif",
	"-webkit-text-size-adjust:100%",
].join(";");

function bodyStart(html: string): number {
	if (!DOCUMENT_START.test(html)) return 0;
	// The cleaner has removed comments and raw-text elements. Read quoted attributes as a
	// whole so a value that mentions <body> cannot be mistaken for the opening tag.
	for (const tag of html.matchAll(/<(!doctype|\/?[a-z][^\s/>]*)(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
		if (tag[1]?.toLowerCase() === "body") return tag.index + tag[0].length;
	}
	return 0;
}

/** Adds the disclosure before any of the agent's content, once the HTML has been cleaned. */
export function discloseAgent(name: string, text: string, html: string | null, held: boolean) {
	const shown = name
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
		.trim()
		.slice(0, MAX_AGENT_NAME)
		.replace(/[\uD800-\uDBFF]$/u, "");
	const line = `This message was written by an AI agent (${shown}).`;
	const notice = `<p dir="ltr" style="${NOTICE_STYLE}">${textHtml(line)}</p>`;
	const start = html === null ? 0 : bodyStart(html);
	return {
		text: `${line}\n\n${text}`,
		html: html === null ? null : html.slice(0, start) + notice + html.slice(start),
		aiDisclosure: held ? ("mode=ai-originated" as const) : ("mode=machine-generated" as const),
	};
}
