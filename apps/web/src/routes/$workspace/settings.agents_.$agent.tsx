import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { AgentPage } from "#/components/settings/agent-page";
import { Notice } from "#/components/workspace/notice";
import { getAgentActivity, getAgentLog } from "#/lib/agents";
import { useDocumentTitle } from "#/lib/title";

/** How often an agent's page looks again while it is in sight, as an agent can be quick. */
const REFRESH_MS = 15_000;

export const Route = createFileRoute("/$workspace/settings/agents_/$agent")({
	loader: async ({ params }) => {
		const asked = { slug: params.workspace, agentId: params.agent };
		const [activity, log] = await Promise.all([
			getAgentActivity({ data: asked }),
			getAgentLog({ data: { ...asked, kind: null, before: null } }),
		]);
		return activity && log ? { activity, log } : null;
	},
	component: AgentRoute,
});

function AgentRoute() {
	const found = Route.useLoaderData();
	const router = useRouter();
	useDocumentTitle(found ? found.activity.agent.name : "Agent");

	// Fresh while someone looks: every so often, and on coming back to the tab. An agent that isn't
	// there won't come back.
	const there = found !== null;
	useEffect(() => {
		if (!there) return;
		const look = () => {
			if (document.visibilityState === "visible") void router.invalidate();
		};
		const timer = setInterval(look, REFRESH_MS);
		document.addEventListener("visibilitychange", look);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", look);
		};
	}, [router, there]);

	if (!found) {
		return (
			<Notice title="Agent not found">
				It may have been deleted, or only owners and admins of this workspace may see it.
			</Notice>
		);
	}
	return <AgentPage activity={found.activity} log={found.log} />;
}
