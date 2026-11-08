import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail/$workspace/$mailbox/")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { mailboxAnswer } = await import("#/server/mailbox/read");
				return mailboxAnswer(params.workspace, params.mailbox, new URL(request.url));
			},
		},
	},
});
