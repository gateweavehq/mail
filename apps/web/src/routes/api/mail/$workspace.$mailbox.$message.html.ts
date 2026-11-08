import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail/$workspace/$mailbox/$message/html")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { messageHtml } = await import("#/server/mailbox/read");
				return messageHtml(params.workspace, params.mailbox, params.message, new URL(request.url));
			},
		},
	},
});
