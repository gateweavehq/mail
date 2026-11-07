import { createFileRoute } from "@tanstack/react-router";
import { handleAuthRequest, postToAuth } from "#/server/auth";

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: ({ request }) => handleAuthRequest(request),
			POST: ({ request }) => postToAuth(request),
		},
	},
});
