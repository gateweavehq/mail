import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/directory/$workspace")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { readDirectory } = await import("#/server/directory/gateway");
				return readDirectory(params.workspace);
			},
			POST: async ({ request, params }) => {
				const { changeDirectory } = await import("#/server/directory/gateway");
				return changeDirectory(request, params.workspace);
			},
		},
	},
});
