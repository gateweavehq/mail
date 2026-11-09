import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { ApiError, INTERNAL_FAILURE, logFailure, type MailAccess } from "../agent-api/mail-access";
import { OPERATIONS } from "../agent-api/operations";

/** Builds the MCP server for one request: a tool for each of the agent's operations. */
export function createMailServer(access: MailAccess): McpServer {
	const server = new McpServer({ name: "gateweave-mail", version: "1.0.0" });
	for (const operation of OPERATIONS) {
		server.registerTool(
			operation.name,
			{
				title: operation.title,
				description: operation.description,
				inputSchema: operation.input,
				outputSchema: operation.output,
				annotations: operation.hints,
			},
			(input, ctx) => run(operation.name, () => operation.run(access, input, ctx.mcpReq.signal)),
		);
	}
	return server;
}

/**
 * Runs a tool, returning its result as structured content or its failure as a tool error. A
 * failure of Mail's own is logged and told in the same words as over REST, never in what a
 * database or a message said.
 */
async function run(
	name: string,
	body: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
	try {
		const result = await body();
		return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
	} catch (error) {
		if (error instanceof ApiError) {
			return { content: [{ type: "text", text: error.message }], isError: true };
		}
		logFailure(name, error);
		return { content: [{ type: "text", text: INTERNAL_FAILURE }], isError: true };
	}
}
