import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail/$workspace/$mailbox/$message/")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { messageAnswer } = await import("#/server/mailbox/read");
				return messageAnswer(params.workspace, params.mailbox, params.message);
			},
			DELETE: async ({ request, params }) => {
				const { deleteMessageAnswer } = await import("#/server/mailbox/read");
				return deleteMessageAnswer(request, params.workspace, params.mailbox, params.message);
			},
		},
	},
});
