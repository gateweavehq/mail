import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/webhooks/$workspace")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const { changeWebhooks } = await import("#/server/webhooks/gateway");
				return changeWebhooks(request, params.workspace);
			},
		},
	},
});
