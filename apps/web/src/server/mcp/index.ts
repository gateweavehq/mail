import { createMcpHandler } from "@modelcontextprotocol/server";
import { MAX_SEND_BODY } from "../../lib/outbox";
import { accessFor, agentOfRequest } from "../agent-api/access";
import { createMailServer } from "./tools";

/**
 * Mail's MCP server at `/mcp`, for an agent with its key. It is a gateway like the agent's REST
 * routes, and every tool goes through the same functions they do, as the same key: the request's
 * own `Authorization` is what `currentCaller` reads. So a key reaches only the workspace it was
 * made for and the mailboxes it was given, and what it sends waits for a person as its policy has
 * it. Session cookies are never enough here: without a key the answer is 401, whatever comes with
 * it.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
	const agent = await agentOfRequest(request);
	if (!("key" in agent)) return unauthorized(agent.hadKey);
	return mcpHandler.fetch(request, {
		authInfo: {
			token: agent.key,
			// One id per agent, whichever key it uses.
			clientId: `agent:${agent.userId}`,
			scopes: [],
			extra: { slug: agent.slug },
		},
	});
}

const mcpHandler = createMcpHandler(
	({ authInfo }) => {
		const slug = authInfo?.extra?.slug;
		// `handleMcpRequest` only lets a found key through, and always names its workspace.
		if (typeof slug !== "string" || !authInfo?.token) {
			throw new Error("MCP request without a verified key");
		}
		return createMailServer(accessFor(slug, authInfo.token));
	},
	// A message's files come in its call, in Base64; every tool's input bounds the rest.
	{ maxRequestBodySize: MAX_SEND_BODY },
);

/** A JSON-RPC error, as an MCP client reads one, for a request without a working key. */
function unauthorized(hadKey: boolean): Response {
	return Response.json(
		{
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: hadKey
					? "That agent key doesn't work: it was revoked, or its agent deleted."
					: "Mail's MCP server takes an agent's key, as a bearer token. An owner or admin makes one in the workspace's settings, under Agents.",
			},
			id: null,
		},
		{
			status: 401,
			headers: {
				// No resource metadata: there is no OAuth here that a key could be swapped for.
				"WWW-Authenticate": hadKey
					? 'Bearer realm="Gateweave Mail", error="invalid_token"'
					: 'Bearer realm="Gateweave Mail"',
				"cache-control": "no-store",
			},
		},
	);
}
