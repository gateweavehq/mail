import { createMcpHandler } from "@modelcontextprotocol/server";
import { MAX_SEND_BODY } from "../../lib/outbox";
import { accessFor, agentOfRequest, type NoAgent, noAgentAnswer } from "../agent-api/access";
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
	if (!("key" in agent)) return unauthorized(agent);
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

/**
 * A JSON-RPC error, as an MCP client reads one, for a request without a working key, or with a
 * paused agent's.
 */
function unauthorized(why: NoAgent): Response {
	const { error, status, challenge } = noAgentAnswer(
		why,
		"Mail's MCP server takes an agent's key, as a bearer token. An owner or admin makes one in the workspace's settings, under Agents.",
	);
	return Response.json(
		{ jsonrpc: "2.0", error: { code: -32000, message: error }, id: null },
		{
			status,
			headers: {
				// No resource metadata: there is no OAuth here that a key could be swapped for.
				...(status === 401 ? { "WWW-Authenticate": challenge } : {}),
				"cache-control": "no-store",
			},
		},
	);
}
