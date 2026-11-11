import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/agents/$workspace/")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { agentsAtAGlanceAnswer } = await import("#/server/agents-glance");
				return agentsAtAGlanceAnswer(params.workspace);
			},
		},
	},
});
