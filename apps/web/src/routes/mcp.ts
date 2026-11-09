import { createFileRoute } from "@tanstack/react-router";

// Mail's MCP server, for an agent with its key. GET and DELETE are the 2025 protocol's session
// requests, which a stateless server answers with 405 itself.
const serve = async ({ request }: { request: Request }) => {
	const { handleMcpRequest } = await import("#/server/mcp");
	return handleMcpRequest(request);
};

export const Route = createFileRoute("/mcp")({
	server: { handlers: { GET: serve, POST: serve, DELETE: serve } },
});
