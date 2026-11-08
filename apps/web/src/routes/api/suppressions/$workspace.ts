import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/suppressions/$workspace")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { readSuppressions } = await import("#/server/suppressions/gateway");
				return readSuppressions(request, params.workspace);
			},
			POST: async ({ request, params }) => {
				const { changeSuppressions } = await import("#/server/suppressions/gateway");
				return changeSuppressions(request, params.workspace);
			},
		},
	},
});
