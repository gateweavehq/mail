import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import { useWorkspace } from "#/components/workspace/context";
import { changeDirectory, type DirectoryMailbox } from "#/lib/directory";
import { getWorkspaceMembers, type WorkspaceMember } from "#/lib/members";
import { isAdminRole } from "#/lib/roles";

type Access = NonNullable<DirectoryMailbox["access"]>;

/** Who can read a mailbox, in a sentence. */
export function accessSummary(access: Access): string {
	if (access.everyone) return "Everyone in the workspace can read it.";
	const people = access.memberIds.length;
	if (people === 0) return "Only owners and admins can read it.";
	return `Owners, admins and ${people === 1 ? "1 other person" : `${people} other people`} can read it.`;
}

/**
 * Chooses who may read a mailbox. Owners and admins read every one, so only the others are listed.
 * What is saved is what the dialog shows: a grant to someone who has since become an admin goes.
 */
export function MailboxAccessDialog({
	box,
	access,
	onClose,
}: {
	box: DirectoryMailbox;
	access: Access;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [people, setPeople] = useState<WorkspaceMember[] | null>(null);
	const [everyone, setEveryone] = useState(access.everyone);
	const [chosen, setChosen] = useState(() => new Set(access.memberIds));
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	useEffect(() => {
		let live = true;
		getWorkspaceMembers({ data: slug }).then(
			(result) => {
				if (live) setPeople((result?.members ?? []).filter((m) => !isAdminRole(m.role)));
			},
			() => {
				if (live) setError("The workspace's people didn't load. Close this and try again.");
			},
		);
		return () => {
			live = false;
		};
	}, [slug]);

	function toggle(memberId: string, on: boolean) {
		setChosen((current) => {
			const next = new Set(current);
			if (on) next.add(memberId);
			else next.delete(memberId);
			return next;
		});
	}

	async function save() {
		if (!people) return;
		setPending(true);
		setError(null);
		const result = await changeDirectory(slug, {
			action: "set-mailbox-access",
			mailboxId: box.id,
			everyone,
			memberIds: people.filter((person) => chosen.has(person.memberId)).map((p) => p.memberId),
		});
		if (result.ok) {
			await router.invalidate();
			setPending(false);
			onClose();
		} else {
			setError(result.error);
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="wrap-anywhere">Who can read {box.name}</DialogTitle>
					<DialogDescription>
						Owners and admins can read every mailbox. Choose who else can.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="flex items-center gap-2">
						<Checkbox
							id={`everyone-${box.id}`}
							checked={everyone}
							onCheckedChange={(checked) => setEveryone(checked === true)}
							disabled={pending}
						/>
						<Label htmlFor={`everyone-${box.id}`}>Everyone in the workspace</Label>
					</div>

					<fieldset className="space-y-2" disabled={everyone || pending}>
						<legend className="text-sm text-muted-foreground">
							{everyone ? "Everyone below can read it." : "Or only these people:"}
						</legend>
						{people === null ? (
							!error && <p className="text-sm text-muted-foreground">Loading people…</p>
						) : people.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								Everyone here is an owner or admin, so there is nobody else to choose yet.
							</p>
						) : (
							<ul className="max-h-64 space-y-2 overflow-y-auto">
								{people.map((person) => (
									<li key={person.memberId} className="flex items-center gap-2">
										<Checkbox
											id={`reader-${box.id}-${person.memberId}`}
											checked={everyone || chosen.has(person.memberId)}
											onCheckedChange={(checked) => toggle(person.memberId, checked === true)}
										/>
										<Label
											htmlFor={`reader-${box.id}-${person.memberId}`}
											className="min-w-0 break-words font-normal"
										>
											{person.name}{" "}
											<span className="break-all text-muted-foreground">{person.email}</span>
										</Label>
									</li>
								))}
							</ul>
						)}
					</fieldset>

					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
				</div>

				<DialogFooter className="gap-2">
					<Button variant="outline" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button onClick={save} disabled={pending || people === null}>
						{pending ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
