import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail/$workspace/$mailbox/threads/")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { threadsAnswer } = await import("#/server/mailbox/read");
				return threadsAnswer(params.workspace, params.mailbox, new URL(request.url));
			},
		},
	},
});
