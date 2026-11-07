import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { useMyRole, useWorkspace } from "#/components/workspace/context";
import { authClient } from "#/lib/auth-client";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/workspace")({
	component: WorkspacePage,
});

function WorkspacePage() {
	const workspace = useWorkspace();
	const owner = useMyRole() === "owner";
	const [deleting, setDeleting] = useState(false);
	useDocumentTitle("Workspace");

	return (
		<div className="space-y-10">
			<section aria-labelledby="workspace-heading" className="space-y-3">
				<h2 id="workspace-heading" className="text-base font-semibold">
					Workspace
				</h2>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
					<dt className="text-muted-foreground">Name</dt>
					<dd>{workspace.name}</dd>
					<dt className="text-muted-foreground">URL</dt>
					<dd className="font-mono text-xs leading-5">/{workspace.slug}</dd>
				</dl>
			</section>

			<section
				aria-labelledby="delete-heading"
				className="space-y-3 rounded-lg border border-destructive/40 p-4"
			>
				<h2 id="delete-heading" className="text-base font-semibold">
					Delete this workspace
				</h2>
				<p className="text-sm text-muted-foreground">
					Deletes the workspace for good, with its members and invitations.
				</p>
				{owner ? (
					<Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
						Delete workspace
					</Button>
				) : (
					<p className="text-sm text-muted-foreground">Only an owner can delete the workspace.</p>
				)}
			</section>

			{deleting && (
				<DeleteDialog id={workspace.id} name={workspace.name} onClose={() => setDeleting(false)} />
			)}
		</div>
	);
}

/** Asks for the workspace's name, so it is not deleted by a slip. */
function DeleteDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
	const navigate = useNavigate();
	const [typed, setTyped] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (typed !== name) return;
		setPending(true);
		setError(null);
		const result = await authClient.organization.delete({ organizationId: id });
		if (result.error) {
			setError(result.error.message ?? "The workspace could not be deleted");
			setPending(false);
			return;
		}
		await navigate({ to: "/" });
		toast.success(`${name} was deleted`);
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Delete {name}?</DialogTitle>
						<DialogDescription>
							This cannot be undone. Type the workspace's name to delete it with everything in it.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="delete-name">Workspace name</Label>
						<Input
							id="delete-name"
							autoComplete="off"
							spellCheck={false}
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							placeholder={name}
							autoFocus
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" variant="destructive" disabled={pending || typed !== name}>
							{pending ? "Deleting…" : "Delete workspace"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
