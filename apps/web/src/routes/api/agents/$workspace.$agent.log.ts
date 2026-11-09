import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/agents/$workspace/$agent/log")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const { agentLogAnswer } = await import("#/server/mailbox/agent-activity");
				return agentLogAnswer(params.workspace, params.agent, new URL(request.url));
			},
		},
	},
});
