import { createFileRoute } from "@tanstack/react-router";

// Resend's webhook for mail it received, signed with the workspace's secret: see
// `server/resend-inbound.ts`. It carries no cookie, and the signature is what admits it.
export const Route = createFileRoute("/api/inbound/resend/$channel")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const [{ db }, { receiveFromResend }] = await Promise.all([
					import("#/server/auth"),
					import("#/server/resend-inbound"),
				]);
				return receiveFromResend(db, request, params.channel);
			},
		},
	},
});
