import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { LegalLinks } from "#/components/legal-links";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { getLegalLinks, getSession } from "#/lib/session";
import { slugify, slugProblem } from "#/lib/slug";

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		const session = await getSession();
		if (!session) throw redirect({ to: "/login" });
		return { session };
	},
	loader: () => getLegalLinks(),
	component: WorkspacesPage,
});

function WorkspacesPage() {
	const { session } = Route.useRouteContext();
	const legal = Route.useLoaderData();
	const router = useRouter();
	const workspaces = authClient.useListOrganizations();

	return (
		<main className="mx-auto max-w-lg space-y-10 p-6 pt-24">
			<header className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>
					<p className="text-sm text-muted-foreground">Signed in as {session.user.email}</p>
				</div>
				<div className="flex items-center gap-1">
					<Button variant="ghost" size="sm" asChild>
						<Link to="/settings/account">Your account</Link>
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={async () => {
							await authClient.signOut();
							await router.invalidate();
						}}
					>
						Sign out
					</Button>
				</div>
			</header>

			<section className="space-y-2">
				{workspaces.isPending ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : workspaces.data?.length ? (
					<ul className="divide-y rounded-lg border">
						{workspaces.data.map((workspace) => (
							<li key={workspace.id}>
								<Link
									to="/$workspace"
									params={{ workspace: workspace.slug }}
									className="flex items-center justify-between px-4 py-3 text-sm hover:bg-accent"
								>
									<span className="font-medium">{workspace.name}</span>
									<span className="text-muted-foreground">/{workspace.slug}</span>
								</Link>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">You are not in any workspace yet.</p>
				)}
			</section>

			<CreateWorkspace />

			<LegalLinks links={legal} />
		</main>
	);
}

function CreateWorkspace() {
	const router = useRouter();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugEdited, setSlugEdited] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const effectiveSlug = slugEdited ? slug : slugify(name);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		const problem = slugProblem(effectiveSlug);
		if (problem) {
			setError(problem);
			return;
		}
		setPending(true);
		const result = await authClient.organization.create({ name, slug: effectiveSlug });
		setPending(false);
		if (result.error) {
			setError(result.error.message ?? "Could not create the workspace");
			return;
		}
		await router.navigate({ to: "/$workspace", params: { workspace: effectiveSlug } });
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
			<h2 className="text-sm font-medium">New workspace</h2>
			<div className="space-y-2">
				<Label htmlFor="workspace-name">Name</Label>
				<Input
					id="workspace-name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Acme Inc."
					required
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="workspace-slug">URL</Label>
				<Input
					id="workspace-slug"
					value={effectiveSlug}
					onChange={(event) => {
						setSlugEdited(true);
						setSlug(event.target.value);
					}}
					placeholder="acme"
					required
				/>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<Button type="submit" disabled={pending || !name}>
				Create workspace
			</Button>
		</form>
	);
}
