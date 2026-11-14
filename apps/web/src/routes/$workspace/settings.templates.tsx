import { createFileRoute } from "@tanstack/react-router";
import { TemplatesSettings } from "#/components/settings/templates-settings";
import { Notice } from "#/components/workspace/notice";
import { useDocumentTitle } from "#/lib/title";
import { getWorkspaceTemplates } from "#/lib/workspace-templates";

export const Route = createFileRoute("/$workspace/settings/templates")({
	loader: ({ params }) => getWorkspaceTemplates({ data: params.workspace }),
	component: TemplatesPage,
});

function TemplatesPage() {
	const data = Route.useLoaderData();
	useDocumentTitle("Templates");

	if (!data) {
		return (
			<Notice title="Templates unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	return <TemplatesSettings data={data} admin={data.admin} />;
}
