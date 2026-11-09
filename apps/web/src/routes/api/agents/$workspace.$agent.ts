import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/agents/$workspace/$agent")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { agentActivityAnswer } = await import("#/server/mailbox/agent-activity");
				return agentActivityAnswer(params.workspace, params.agent);
			},
		},
	},
});
