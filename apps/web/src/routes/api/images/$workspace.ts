import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/images/$workspace")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { readImageSenders } = await import("#/server/images");
				return readImageSenders(params.workspace);
			},
			POST: async ({ request, params }) => {
				const { changeImageSenders } = await import("#/server/images");
				return changeImageSenders(request, params.workspace);
			},
		},
	},
});
