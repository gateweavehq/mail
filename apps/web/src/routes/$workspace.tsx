import { createFileRoute, Link, notFound, Outlet, redirect } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { AppShell } from "#/components/workspace/app-shell";
import { WorkspaceProvider } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { getSession } from "#/lib/session";
import { getWorkspace } from "#/lib/workspace";

export const Route = createFileRoute("/$workspace")({
	beforeLoad: async ({ location }) => {
		if (!(await getSession()))
			throw redirect({ to: "/login", search: { redirect: location.href } });
	},
	loader: async ({ params }) => {
		const workspace = await getWorkspace({ data: params.workspace });
		if (!workspace) throw notFound();
		return workspace;
	},
	component: WorkspaceLayout,
	notFoundComponent: WorkspaceNotFound,
});

function WorkspaceLayout() {
	const workspace = Route.useLoaderData();
	return (
		<WorkspaceProvider workspace={workspace}>
			<AppShell>
				<Outlet />
			</AppShell>
		</WorkspaceProvider>
	);
}

// A missing workspace and one the user may not see look the same, on purpose: the response must
// not reveal which slugs exist.
function WorkspaceNotFound() {
	return (
		<main className="grid min-h-svh place-items-center">
			<Notice
				title="Workspace not found"
				action={
					<Button asChild variant="outline">
						<Link to="/">Your workspaces</Link>
					</Button>
				}
			>
				It doesn't exist, or your account doesn't have access to it. If someone invited you, open
				the link they sent.
			</Notice>
		</main>
	);
}
