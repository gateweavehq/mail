import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/templates/$workspace")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { templateVersions } = await import("#/server/audience/gateway");
				return templateVersions(request, params.workspace);
			},
			POST: async ({ request, params }) => {
				const { changeTemplates } = await import("#/server/audience/gateway");
				return changeTemplates(request, params.workspace);
			},
		},
	},
});
