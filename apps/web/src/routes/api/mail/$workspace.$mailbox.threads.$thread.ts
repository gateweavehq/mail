import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail/$workspace/$mailbox/threads/$thread")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const { threadAnswer } = await import("#/server/mailbox/read");
				return threadAnswer(params.workspace, params.mailbox, params.thread, new URL(request.url));
			},
		},
	},
});
