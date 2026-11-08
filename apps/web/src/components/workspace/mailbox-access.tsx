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
import { getWorkspaceAgents } from "#/lib/agents";
import { changeDirectory, type DirectoryMailbox } from "#/lib/directory";
import { getWorkspaceMembers } from "#/lib/members";
import { isAdminRole, isPersonRole } from "#/lib/roles";

type Access = NonNullable<DirectoryMailbox["access"]>;

/** Someone the dialog can give the mailbox to. */
interface Reader {
	memberId: string;
	name: string;
	detail: string | null;
}

const counted = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** Who can read a mailbox, in a sentence, and which agents can send from it. */
export function accessSummary(access: Access): string {
	const senders = access.senderIds.length;
	const sending = senders
		? ` ${senders === access.agentIds.length && senders > 1 ? "All of the agents" : counted(senders, "agent", "agents")} can send from it too.`
		: "";
	return readersSummary(access) + sending;
}

function readersSummary(access: Access): string {
	const agents = access.agentIds.length ? counted(access.agentIds.length, "agent", "agents") : null;
	if (access.everyone) {
		return agents
			? `Everyone in the workspace can read it, and ${agents}.`
			: "Everyone in the workspace can read it.";
	}
	const people = access.memberIds.length
		? counted(access.memberIds.length, "other person", "other people")
		: null;
	if (people && agents) return `Owners, admins, ${people} and ${agents} can read it.`;
	if (people || agents) return `Owners, admins and ${people ?? agents} can read it.`;
	return "Only owners and admins can read it.";
}

/**
 * Chooses who may read a mailbox. Owners and admins read every one, so only the others are listed.
 * Agents are apart: "everyone" means people, so an agent reads a mailbox only when it is ticked
 * here, and sends from it only when let. What is saved is what the dialog shows: with everyone
 * ticked, no person needs a grant of their own, so none are kept, and a grant to someone since made
 * an admin goes.
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
	const [readers, setReaders] = useState<{ people: Reader[]; agents: Reader[] } | null>(null);
	const [everyone, setEveryone] = useState(access.everyone);
	const [chosen, setChosen] = useState(() => new Set([...access.memberIds, ...access.agentIds]));
	const [senders, setSenders] = useState(() => new Set(access.senderIds));
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	useEffect(() => {
		let live = true;
		Promise.all([getWorkspaceMembers({ data: slug }), getWorkspaceAgents({ data: slug })]).then(
			([members, agents]) => {
				if (!live) return;
				setReaders({
					people: (members?.members ?? [])
						.filter((member) => isPersonRole(member.role) && !isAdminRole(member.role))
						.map((member) => ({
							memberId: member.memberId,
							name: member.name,
							detail: member.email,
						})),
					agents: (agents?.agents ?? []).map((agent) => ({
						memberId: agent.memberId,
						name: agent.name,
						detail: null,
					})),
				});
			},
			() => {
				if (live) setError("The workspace's people didn't load. Close this and try again.");
			},
		);
		return () => {
			live = false;
		};
	}, [slug]);

	const toggled = (set: Set<string>, memberId: string, on: boolean) => {
		const next = new Set(set);
		if (on) next.add(memberId);
		else next.delete(memberId);
		return next;
	};

	function toggle(memberId: string, on: boolean) {
		setChosen((current) => toggled(current, memberId, on));
		// An agent that can't read a mailbox can't send from it either.
		if (!on) setSenders((current) => toggled(current, memberId, false));
	}

	async function save() {
		if (!readers) return;
		setPending(true);
		setError(null);
		const picked = (list: Reader[]) =>
			list.filter((reader) => chosen.has(reader.memberId)).map((reader) => reader.memberId);
		// A grant to someone listed in neither, such as a role this version doesn't know, stays.
		const listed = new Set([...readers.people, ...readers.agents].map((r) => r.memberId));
		const unlisted = [...chosen].filter((memberId) => !listed.has(memberId));
		const memberIds = [
			...(everyone ? [] : picked(readers.people)),
			...picked(readers.agents),
			...unlisted,
		];
		const result = await changeDirectory(slug, {
			action: "set-mailbox-access",
			mailboxId: box.id,
			everyone,
			memberIds,
			senderIds: memberIds.filter((memberId) => senders.has(memberId)),
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

	const list = (
		kind: string,
		rows: Reader[],
		ticked: (reader: Reader) => boolean,
		sends = false,
	) => (
		<ul className="max-h-48 space-y-2 overflow-y-auto">
			{rows.map((reader) => {
				const id = `${kind}-${box.id}-${reader.memberId}`;
				return (
					<li key={reader.memberId} className="flex items-center gap-2">
						<Checkbox
							id={id}
							checked={ticked(reader)}
							onCheckedChange={(checked) => toggle(reader.memberId, checked === true)}
						/>
						<Label htmlFor={id} className="min-w-0 flex-1 break-words font-normal">
							{reader.name}
							{reader.detail && (
								<span className="break-all text-muted-foreground"> {reader.detail}</span>
							)}
						</Label>
						{sends && (
							<span className="flex shrink-0 items-center gap-1.5">
								<Checkbox
									id={`send-${id}`}
									checked={chosen.has(reader.memberId) && senders.has(reader.memberId)}
									disabled={!chosen.has(reader.memberId)}
									onCheckedChange={(checked) =>
										setSenders((current) => toggled(current, reader.memberId, checked === true))
									}
								/>
								<Label htmlFor={`send-${id}`} className="font-normal text-muted-foreground">
									<span className="sr-only">{reader.name} </span>can send
								</Label>
							</span>
						)}
					</li>
				);
			})}
		</ul>
	);

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

					{readers === null ? (
						!error && <p className="text-sm text-muted-foreground">Loading people…</p>
					) : (
						<>
							<fieldset className="space-y-2" disabled={everyone || pending}>
								<legend className="text-sm text-muted-foreground">
									{everyone ? "Everyone below can read it." : "Or only these people:"}
								</legend>
								{readers.people.length === 0 ? (
									<p className="text-sm text-muted-foreground">
										Everyone here is an owner or admin, so there is nobody else to choose yet.
									</p>
								) : (
									list(
										"reader",
										readers.people,
										(reader) => everyone || chosen.has(reader.memberId),
									)
								)}
							</fieldset>
							{readers.agents.length > 0 && (
								<fieldset className="space-y-2" disabled={pending}>
									<legend className="text-sm text-muted-foreground">
										Agents, which read it only when ticked here. One that can send mails the
										addresses its settings allow on its own, and anything else waits for someone
										here to approve it:
									</legend>
									{list("agent", readers.agents, (reader) => chosen.has(reader.memberId), true)}
								</fieldset>
							)}
						</>
					)}

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
					<Button onClick={save} disabled={pending || readers === null}>
						{pending ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
