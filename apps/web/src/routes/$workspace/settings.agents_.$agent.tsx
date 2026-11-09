import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { AgentPage } from "#/components/settings/agent-page";
import { Notice } from "#/components/workspace/notice";
import { getAgentActivity } from "#/lib/agents";
import { useDocumentTitle } from "#/lib/title";

/** How often an agent's page looks again while it is in sight, as an agent can be quick. */
const REFRESH_MS = 15_000;

export const Route = createFileRoute("/$workspace/settings/agents_/$agent")({
	loader: ({ params }) =>
		getAgentActivity({ data: { slug: params.workspace, agentId: params.agent } }),
	component: AgentRoute,
});

function AgentRoute() {
	const activity = Route.useLoaderData();
	const router = useRouter();
	useDocumentTitle(activity ? activity.agent.name : "Agent");

	// Fresh while someone looks: every so often, and on coming back to the tab. An agent that isn't
	// there won't come back.
	const found = activity !== null;
	useEffect(() => {
		if (!found) return;
		const look = () => {
			if (document.visibilityState === "visible") void router.invalidate();
		};
		const timer = setInterval(look, REFRESH_MS);
		document.addEventListener("visibilitychange", look);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", look);
		};
	}, [router, found]);

	if (!activity) {
		return (
			<Notice title="Agent not found">
				It may have been deleted, or only owners and admins of this workspace may see it.
			</Notice>
		);
	}
	return <AgentPage activity={activity} />;
}
