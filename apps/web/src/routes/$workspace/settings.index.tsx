import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$workspace/settings/")({
	beforeLoad: ({ params }) => {
		throw redirect({ to: "/$workspace/settings/members", params, replace: true });
	},
});
