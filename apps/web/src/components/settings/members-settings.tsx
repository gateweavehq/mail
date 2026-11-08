import { useNavigate, useRouter } from "@tanstack/react-router";
import { Copy, Ellipsis, Mail } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/members/member-avatar";
import { InvitationNotice, resentNotice } from "#/components/settings/invitation-notice";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { VerifyEmailButton } from "#/components/verify-email";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdminRole, useMyRole, useWorkspace } from "#/components/workspace/context";
import { authClient } from "#/lib/auth-client";
import { formatRelative, formatShortDate } from "#/lib/dates";
import {
	invitationUrl,
	type PendingInvitation,
	ROLE_LABELS,
	type WorkspaceMember,
} from "#/lib/members";
import type { MemberRole, PersonRole } from "#/lib/roles";

/** The roles the current user may hand out: only owners make owners. */
function assignableRoles(myRole: MemberRole): PersonRole[] {
	return myRole === "owner" ? ["member", "admin", "owner"] : ["member", "admin"];
}

async function copyLink(invitationId: string) {
	try {
		await navigator.clipboard.writeText(invitationUrl(invitationId));
		toast.success("Invite link copied");
	} catch {
		toast.error("Could not copy the link", { description: invitationUrl(invitationId) });
	}
}

export function MembersSettings({
	members,
	invitations,
	inviteByEmail,
	emailEnabled,
	focusInvite,
}: {
	members: WorkspaceMember[];
	invitations: PendingInvitation[];
	/** Whether the server emails invitations from this user, or they share links themselves. */
	inviteByEmail: boolean;
	/** Whether the server sends email at all. */
	emailEnabled: boolean;
	/** Puts the cursor in the invite form, for links like "Invite people". */
	focusInvite: boolean;
}) {
	const role = useMyRole();
	const { userId } = useWorkspace();
	const owners = members.filter((member) => member.role === "owner").length;
	const myEmail = members.find((member) => member.userId === userId)?.email;
	// Invitations wait for the inviter's own address to be verified before they are emailed.
	const verifyFirst = emailEnabled && !inviteByEmail && myEmail ? myEmail : null;
	return (
		<div className="space-y-12">
			{isAdminRole(role) && (
				<InviteSection
					invitations={invitations}
					byEmail={inviteByEmail}
					verifyEmail={verifyFirst}
					focus={focusInvite}
				/>
			)}
			<section aria-labelledby="members-heading" className="space-y-4">
				<h2 id="members-heading" className="text-base font-semibold">
					Members <span className="font-normal text-muted-foreground">{members.length}</span>
				</h2>
				<ul className="divide-y rounded-lg border">
					{members.map((member) => (
						<MemberRow
							key={member.memberId}
							member={member}
							lastOwner={member.role === "owner" && owners === 1}
						/>
					))}
				</ul>
			</section>
		</div>
	);
}

function InviteSection({
	invitations,
	byEmail,
	verifyEmail,
	focus,
}: {
	invitations: PendingInvitation[];
	byEmail: boolean;
	/** The inviter's address, when verifying it would let Track email their invitations. */
	verifyEmail: string | null;
	focus: boolean;
}) {
	const { id: organizationId } = useWorkspace();
	const myRole = useMyRole();
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<PersonRole>("member");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<{ id: string; email: string } | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		// `resend` returns the pending invitation for this address, with a fresh expiry, instead
		// of failing, so asking for a link twice gives the same link (and emails it again).
		const result = await authClient.organization.inviteMember({
			email: email.trim(),
			role,
			organizationId,
			resend: true,
		});
		setPending(false);
		if (result.error || !result.data) {
			setError(result.error?.message ?? "Could not create the invitation");
			return;
		}
		setCreated({ id: result.data.id, email: result.data.email });
		setEmail("");
		await router.invalidate();
	}

	return (
		<section aria-labelledby="invite-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="invite-heading" className="text-base font-semibold">
					Invite people
				</h2>
				<p className="text-sm text-muted-foreground">
					{byEmail
						? "We email them a link to join. It works for their address only, for 7 days."
						: "Create a link for someone's email address and send it to them. It works for that address only, for 7 days."}
				</p>
			</div>
			{verifyEmail && (
				<div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-sm sm:flex-row sm:items-center">
					<p className="flex-1">
						Verify your email address, and Track will email your invitations for you.
					</p>
					<VerifyEmailButton email={verifyEmail} variant="outline" size="sm" />
				</div>
			)}
			<form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
				<Input
					type="email"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					placeholder="name@company.com"
					aria-label="Email address"
					autoFocus={focus}
					required
					className="sm:flex-1"
				/>
				<RoleSelect
					value={role}
					roles={assignableRoles(myRole).filter((r) => r !== "owner")}
					onChange={setRole}
					label="Role for the invited person"
				/>
				<Button type="submit" disabled={pending || !email.trim()}>
					{byEmail ? "Send invite" : "Create invite link"}
				</Button>
			</form>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{created && (
				<div className="space-y-2 rounded-lg border bg-muted/40 p-3" aria-live="polite">
					<p className="text-sm">
						<InvitationNotice byEmail={byEmail} email={created.email} />
					</p>
					<div className="flex gap-2">
						<Input
							readOnly
							value={invitationUrl(created.id)}
							aria-label="Invite link"
							onFocus={(event) => event.currentTarget.select()}
							className="font-mono text-xs"
						/>
						<Button variant="outline" onClick={() => copyLink(created.id)}>
							<Copy />
							Copy
						</Button>
					</div>
				</div>
			)}
			{invitations.length > 0 && (
				<div className="space-y-2">
					<h3 className="text-sm font-medium text-muted-foreground">Pending invitations</h3>
					<ul className="divide-y rounded-lg border">
						{invitations.map((invitation) => (
							<InvitationRow key={invitation.id} invitation={invitation} byEmail={byEmail} />
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

function InvitationRow({
	invitation,
	byEmail,
}: {
	invitation: PendingInvitation;
	byEmail: boolean;
}) {
	const { id: organizationId } = useWorkspace();
	const router = useRouter();
	const [revoking, setRevoking] = useState(false);

	async function resend() {
		const result = await authClient.organization.inviteMember({
			email: invitation.email,
			role: invitation.role,
			organizationId,
			resend: true,
		});
		if (result.error) {
			toast.error("Could not resend the invitation", { description: result.error.message });
			return;
		}
		const { title, description } = resentNotice(invitation.email);
		toast.success(title, { description });
		await router.invalidate();
	}

	async function revoke() {
		const result = await authClient.organization.cancelInvitation({
			invitationId: invitation.id,
		});
		if (result.error) {
			toast.error("Could not revoke the invitation", { description: result.error.message });
			return;
		}
		toast.success(`Invitation for ${invitation.email} revoked`);
		await router.invalidate();
	}

	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
			<Mail className="size-4 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1 truncate">{invitation.email}</span>
			<span className="text-muted-foreground">{ROLE_LABELS[invitation.role]}</span>
			<span className="text-xs text-muted-foreground">
				Expires {formatRelative(invitation.expiresAt)}
			</span>
			<div className="flex gap-1">
				{byEmail && (
					<Button variant="ghost" size="sm" onClick={resend}>
						Resend
					</Button>
				)}
				<Button variant="ghost" size="sm" onClick={() => copyLink(invitation.id)}>
					Copy link
				</Button>
				<Button variant="ghost" size="sm" onClick={() => setRevoking(true)}>
					Revoke
				</Button>
			</div>
			{revoking && (
				<ConfirmDialog
					title={`Revoke the invitation for ${invitation.email}?`}
					confirmLabel="Revoke"
					onConfirm={revoke}
					onClose={() => setRevoking(false)}
				>
					Its link stops working. You can invite them again later.
				</ConfirmDialog>
			)}
		</li>
	);
}

function MemberRow({ member, lastOwner }: { member: WorkspaceMember; lastOwner: boolean }) {
	const { id: organizationId, userId, name: workspaceName } = useWorkspace();
	const myRole = useMyRole();
	const router = useRouter();
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState<"remove" | "leave" | null>(null);
	const isMe = member.userId === userId;
	// Admins manage members and admins; only owners manage owners.
	const canManage = isAdminRole(myRole) && !isMe && (myRole === "owner" || member.role !== "owner");
	// Agents have their own page, so a role read as an agent's here is one this version doesn't know:
	// it can be removed, but there is no such role to hand out.
	const canChangeRole = canManage && member.role !== "agent";

	async function changeRole(role: PersonRole) {
		const result = await authClient.organization.updateMemberRole({
			memberId: member.memberId,
			role,
			organizationId,
		});
		if (result.error) {
			toast.error("Could not change the role", { description: result.error.message });
			return;
		}
		toast.success(`${member.name} is now ${ROLE_LABELS[role].toLowerCase()}`);
		await router.invalidate();
	}

	async function remove() {
		const result = await authClient.organization.removeMember({
			memberIdOrEmail: member.memberId,
			organizationId,
		});
		if (result.error) {
			toast.error(`Could not remove ${member.name}`, { description: result.error.message });
			return;
		}
		toast.success(`${member.name} was removed from ${workspaceName}`);
		await router.invalidate();
	}

	async function leave() {
		const result = await authClient.organization.leave({ organizationId });
		if (result.error) {
			toast.error(`Could not leave ${workspaceName}`, { description: result.error.message });
			return;
		}
		await navigate({ to: "/" });
		toast.success(`You left ${workspaceName}`);
	}

	return (
		<li className="flex items-center gap-3 px-4 py-3">
			<MemberAvatar member={member} className="size-8 text-xs" />
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">
					{member.name}
					{isMe && <span className="font-normal text-muted-foreground"> (you)</span>}
				</p>
				<p className="truncate text-xs text-muted-foreground">{member.email}</p>
			</div>
			<span className="hidden text-xs text-muted-foreground sm:block">
				Joined {formatShortDate(member.joinedAt)}
			</span>
			{canChangeRole ? (
				<RoleSelect
					value={member.role}
					roles={assignableRoles(myRole)}
					onChange={changeRole}
					label={`Role of ${member.name}`}
				/>
			) : (
				<span className="w-24 shrink-0 px-2 text-sm text-muted-foreground">
					{ROLE_LABELS[member.role]}
				</span>
			)}
			{canManage || isMe ? (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-8"
							aria-label={`More for ${member.name}`}
						>
							<Ellipsis />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{isMe && lastOwner ? (
							// A workspace always keeps an owner; the server refuses this too.
							<DropdownMenuItem disabled className="flex-col items-start gap-0.5">
								<span>Leave {workspaceName}</span>
								<span className="text-xs">Make someone else an owner first</span>
							</DropdownMenuItem>
						) : (
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onSelect={() => setConfirming(isMe ? "leave" : "remove")}
							>
								{isMe ? `Leave ${workspaceName}` : "Remove from workspace"}
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			) : (
				<span className="size-8" />
			)}
			{confirming === "remove" && (
				<ConfirmDialog
					title={`Remove ${member.name}?`}
					confirmLabel="Remove"
					onConfirm={remove}
					onClose={() => setConfirming(null)}
				>
					They lose access to {workspaceName} right away. Issues they created or were assigned keep
					their name.
				</ConfirmDialog>
			)}
			{confirming === "leave" && (
				<ConfirmDialog
					title={`Leave ${workspaceName}?`}
					confirmLabel="Leave"
					onConfirm={leave}
					onClose={() => setConfirming(null)}
				>
					You lose access right away, and this browser forgets the workspace. To come back, ask an
					admin for a new invitation.
				</ConfirmDialog>
			)}
		</li>
	);
}

function RoleSelect({
	value,
	roles,
	onChange,
	label,
}: {
	value: MemberRole;
	roles: PersonRole[];
	onChange: (role: PersonRole) => void;
	label: string;
}) {
	return (
		<select
			value={value}
			aria-label={label}
			onChange={(event) => {
				const role = roles.find((candidate) => candidate === event.target.value);
				if (role) onChange(role);
			}}
			className="h-9 w-24 shrink-0 rounded-md border bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		>
			{roles.map((role) => (
				<option key={role} value={role}>
					{ROLE_LABELS[role]}
				</option>
			))}
		</select>
	);
}
