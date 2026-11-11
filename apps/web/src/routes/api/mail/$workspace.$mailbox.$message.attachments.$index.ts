import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail/$workspace/$mailbox/$message/attachments/$index")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { messageAttachment } = await import("#/server/mailbox/read");
				return messageAttachment(params.workspace, params.mailbox, params.message, params.index);
			},
		},
	},
});
