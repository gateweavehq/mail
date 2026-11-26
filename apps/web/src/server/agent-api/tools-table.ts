import type { z } from "zod";
import { OPERATIONS, type Operation } from "./operations";

// The tools table in docs/mcp.md, made from OPERATIONS so it can't say what the tools don't.
// mcp-docs.test.ts keeps the page equal to it. Only the "needs" column is written here, as the
// operations don't say which part of an agent's policy lets one through.

/** The part of an agent's policy that lets each operation through, by the operation's name. */
export const NEEDS: Record<string, string> = {
	list_mailboxes: "Mailboxes: lists only the ones it was given",
	search_email: "Mailboxes: a grant to read the mailbox",
	read_email: "Mailboxes: a grant to read the mailbox",
	get_attachment: "Mailboxes: a grant to read the mailbox",
	wait_for_email: "Mailboxes: a grant to read the mailbox",
	get_verification_code: "Mailboxes: a grant to read the mailbox",
	send_email:
		"Sending: a grant to send from the mailbox, within its daily limit and approval, to recipients that satisfy its target policy when that applies",
	list_templates: "Nothing beyond a working key",
	send_template:
		"Sending: a grant to send from the mailbox, within its daily limit and approval, to recipients that satisfy its target policy when that applies",
	reply:
		"Sending: a grant to send from the mailbox, within its daily limit and approval, to recipients that satisfy its target policy when that applies",
	list_addresses: "Addresses: a grant to read the mailbox, and only the ones it made",
	create_address:
		"Addresses: a grant to send from the mailbox, and an address policy naming the domain",
	end_address: "Addresses: a grant to read the mailbox, and only an address it made",
	list_webhooks: "Webhooks: only the ones it made",
	create_webhook:
		"Webhooks: a grant to read each mailbox it hears of, and an allowed host when its target policy applies",
	update_webhook:
		"Webhooks: one it made, a grant to read each newly selected mailbox, and an allowed host for a new URL or a resume when its target policy applies",
	delete_webhook: "Webhooks: only one it made",
	test_webhook: "Webhooks: one it made, and an allowed host when its target policy applies",
};

export const TOOLS_START = "<!-- mcp-tools:start -->";
export const TOOLS_END = "<!-- mcp-tools:end -->";

/** The text up to the first full stop that ends a sentence. */
export function firstSentence(text: string): string {
	return /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text;
}

/** An object's properties, with `?` after each optional one. */
function properties(schema: z.ZodObject): string {
	const names = Object.entries(schema.shape).map(
		([name, value]) => `${name}${(value as z.ZodType).isOptional() ? "?" : ""}`,
	);
	return names.length === 0 ? "none" : names.map((name) => `\`${name}\``).join(", ");
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();

function http(operation: Operation): string {
	return operation.routes
		.map((route) => {
			const own = route.id && route.id !== operation.name ? ` (${route.id})` : "";
			return `\`${route.method} /api/v1${route.path}\`${own}`;
		})
		.join("<br>");
}

/** The table, one row for each operation, in the order OPERATIONS has them. */
export function toolsTable(operations: readonly Operation[] = OPERATIONS): string {
	const rows = operations.map((operation) => {
		const needs = NEEDS[operation.name];
		if (needs === undefined) throw new Error(`NEEDS has no entry for ${operation.name}.`);
		return [
			`\`${operation.name}\``,
			firstSentence(operation.description),
			properties(operation.input),
			properties(operation.output),
			http(operation),
			needs,
		].map(cell);
	});
	const head = ["Tool", "What it does", "Input", "Output", "HTTP", "What it needs"];
	// Padded to the widest cell of each column, as Biome writes a Markdown table, so that
	// `pnpm format` leaves the block as it is.
	const widths = head.map((title, column) =>
		Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
	);
	const line = (cells: string[]) =>
		`| ${cells.map((text, column) => text.padEnd(widths[column] ?? 0)).join(" | ")} |`;
	return [
		line(head),
		`| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
		...rows.map(line),
	].join("\n");
}
