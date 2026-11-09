import { createFileRoute } from "@tanstack/react-router";
import { WebhooksSettings } from "#/components/settings/webhooks-settings";
import { Notice } from "#/components/workspace/notice";
import { useDocumentTitle } from "#/lib/title";
import { getWorkspaceWebhooks } from "#/lib/webhooks";

export const Route = createFileRoute("/$workspace/settings/webhooks")({
	loader: ({ params }) => getWorkspaceWebhooks({ data: params.workspace }),
	component: WebhooksPage,
});

function WebhooksPage() {
	const data = Route.useLoaderData();
	useDocumentTitle("Webhooks");

	if (!data) {
		return (
			<Notice title="Webhooks unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	if (!data.admin) {
		return (
			<section aria-labelledby="webhooks-heading" className="space-y-1">
				<h2 id="webhooks-heading" className="text-base font-semibold">
					Webhooks
				</h2>
				<p className="text-sm text-muted-foreground">
					Webhooks tell a URL of the workspace's choosing of mail as it arrives. Owners and admins
					manage them.
				</p>
			</section>
		);
	}
	return <WebhooksSettings data={data} />;
}
