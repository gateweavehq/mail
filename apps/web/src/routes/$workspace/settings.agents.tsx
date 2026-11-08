import { createFileRoute } from "@tanstack/react-router";
import { AgentsSettings } from "#/components/settings/agents-settings";
import { Notice } from "#/components/workspace/notice";
import { getWorkspaceAgents } from "#/lib/agents";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/agents")({
	loader: ({ params }) => getWorkspaceAgents({ data: params.workspace }),
	component: AgentsPage,
});

function AgentsPage() {
	const data = Route.useLoaderData();
	useDocumentTitle("Agents");

	if (!data) {
		return (
			<Notice title="Agents unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	return <AgentsSettings admin={data.admin} agents={data.agents} apiUrl={data.apiUrl} />;
}
