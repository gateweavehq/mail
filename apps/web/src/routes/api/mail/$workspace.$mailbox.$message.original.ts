import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail/$workspace/$mailbox/$message/original")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { originalMessage } = await import("#/server/mailbox/read");
				return originalMessage(params.workspace, params.mailbox, params.message);
			},
		},
	},
});
