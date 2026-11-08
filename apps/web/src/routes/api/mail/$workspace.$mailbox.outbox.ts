import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail/$workspace/$mailbox/outbox")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const { outboxAnswer } = await import("#/server/mailbox/send");
				return outboxAnswer(request, params.workspace, params.mailbox);
			},
		},
	},
});
