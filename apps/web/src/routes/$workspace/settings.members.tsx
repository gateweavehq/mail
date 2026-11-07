import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { MembersSettings } from "#/components/settings/members-settings";
import { Notice } from "#/components/workspace/notice";
import { getWorkspaceMembers } from "#/lib/members";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/members")({
	validateSearch: z.object({ invite: z.boolean().optional().catch(undefined) }),
	loader: ({ params }) => getWorkspaceMembers({ data: params.workspace }),
	component: MembersPage,
});

function MembersPage() {
	const data = Route.useLoaderData();
	const { invite } = Route.useSearch();
	useDocumentTitle("Members");

	if (!data) {
		return (
			<Notice title="Members unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	return (
		<MembersSettings
			members={data.members}
			invitations={data.invitations}
			inviteByEmail={data.inviteByEmail}
			emailEnabled={data.emailEnabled}
			focusInvite={invite === true}
		/>
	);
}
