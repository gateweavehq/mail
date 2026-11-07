import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/")({
	component: WorkspaceHome,
});

function WorkspaceHome() {
	const { name, slug } = useWorkspace();
	const admin = isAdminRole(useMyRole());
	useDocumentTitle("Home");

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">{name}</h1>
			</header>
			<section className="space-y-3 rounded-lg border p-6">
				<h2 className="text-sm font-medium">No mailboxes yet</h2>
				<p className="text-sm text-muted-foreground">
					Gateweave Mail is early. Today it has accounts and workspaces, and it refuses all incoming
					mail, because no address exists yet. Mailboxes will appear here once they ship.
				</p>
				{admin ? (
					<Button asChild size="sm" variant="outline">
						<Link
							to="/$workspace/settings/members"
							params={{ workspace: slug }}
							search={{ invite: true }}
						>
							Invite people
						</Link>
					</Button>
				) : (
					<p className="text-sm text-muted-foreground">An owner or admin can invite people.</p>
				)}
			</section>
		</div>
	);
}
