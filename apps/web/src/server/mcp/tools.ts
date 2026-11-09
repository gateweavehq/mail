import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { ApiError, type MailAccess } from "../agent-api/mail-access";
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
			(input, ctx) => run(() => operation.run(access, input, ctx.mcpReq.signal)),
		);
	}
	return server;
}

/** Runs a tool, returning its result as structured content or its failure as a tool error. */
async function run(body: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
	try {
		const result = await body();
		return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
	} catch (error) {
		if (!(error instanceof ApiError)) throw error;
		return { content: [{ type: "text", text: error.message }], isError: true };
	}
}
