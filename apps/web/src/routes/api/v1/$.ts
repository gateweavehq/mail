import { createFileRoute } from "@tanstack/react-router";

async function answer({ request }: { request: Request }) {
	const { handleApiRequest } = await import("#/server/agent-api/rest");
	return handleApiRequest(request);
}

export const Route = createFileRoute("/api/v1/$")({
	server: { handlers: { GET: answer, POST: answer, DELETE: answer, PUT: answer, PATCH: answer } },
});
