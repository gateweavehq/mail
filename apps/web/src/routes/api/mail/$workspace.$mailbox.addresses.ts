import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail/$workspace/$mailbox/addresses")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { agentAddressesAnswer } = await import("#/server/directory/agent-addresses");
				return agentAddressesAnswer(request, params.workspace, params.mailbox);
			},
			POST: async ({ request, params }) => {
				const { agentAddressesAnswer } = await import("#/server/directory/agent-addresses");
				return agentAddressesAnswer(request, params.workspace, params.mailbox);
			},
		},
	},
});
