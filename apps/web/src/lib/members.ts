import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import type { MemberRole } from "./roles";

/**
 * The invitation behind an invitation link, and who is signed in, if anyone. Works signed out,
 * so the page can say who invited whom before asking the recipient to sign in.
 */
export const previewInvitation = createServerFn({ method: "GET" })
	.validator(z.string().min(1).max(128))
	.handler(async ({ data: invitationId }) => {
		const { getAuth, db, emailEnabled } = await import("#/server/auth");
		const auth = getAuth();
		const { findPendingInvitation } = await import("#/server/workspaces");
		const [invitation, session] = await Promise.all([
			findPendingInvitation(db, invitationId),
			auth.api.getSession({ headers: getRequestHeaders() }),
		]);
		return {
			invitation,
			viewer: session
				? { email: session.user.email, emailVerified: session.user.emailVerified }
				: null,
			// Where the server can email, accepting requires a verified address (see auth config).
			verificationRequired: emailEnabled,
		};
	});

export interface WorkspaceMember {
	/** Better Auth's id for the membership, which its member endpoints take. */
	memberId: string;
	userId: string;
	name: string;
	email: string;
	image: string | null;
	role: MemberRole;
	joinedAt: number;
}

export interface PendingInvitation {
	id: string;
	email: string;
	role: MemberRole;
	expiresAt: number;
}

/**
 * The members of the workspace with this slug, from D1, which owns membership. Pending
 * invitations come along only for those who can invite. Null if the caller is not a member.
 */
export const getWorkspaceMembers = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { getAuth, db, emailEnabled } = await import("#/server/auth");
		const auth = getAuth();
		const { findMembership, toRole } = await import("#/server/workspaces");
		const headers = getRequestHeaders();
		const session = await auth.api.getSession({ headers });
		const membership = session && (await findMembership(db, slug, session.user.id));
		if (!membership) return null;

		const organizationId = membership.workspaceId;
		const { members } = await auth.api.listMembers({
			query: { organizationId, limit: 1000 },
			headers,
		});
		const canInvite = membership.role !== "member";
		const invitations = canInvite
			? await auth.api.listInvitations({ query: { organizationId }, headers })
			: [];
		const now = Date.now();

		return {
			emailEnabled,
			// Matches when the server emails an invitation (see sendInvitationEmail).
			inviteByEmail: canInvite && emailEnabled && session.user.emailVerified,
			members: members
				.map(
					(member): WorkspaceMember => ({
						memberId: member.id,
						userId: member.userId,
						name: member.user.name,
						email: member.user.email,
						image: member.user.image ?? null,
						role: toRole(member.role),
						joinedAt: new Date(member.createdAt).getTime(),
					}),
				)
				.sort((a, b) => a.name.localeCompare(b.name)),
			invitations: invitations
				.filter((invitation) => invitation.status === "pending")
				.map(
					(invitation): PendingInvitation => ({
						id: invitation.id,
						email: invitation.email,
						role: toRole(invitation.role ?? "member"),
						expiresAt: new Date(invitation.expiresAt).getTime(),
					}),
				)
				.filter((invitation) => invitation.expiresAt > now)
				.sort((a, b) => a.email.localeCompare(b.email)),
		};
	});

/** The link that opens an invitation. Share it with the person it is for. */
export function invitationUrl(invitationId: string): string {
	return new URL(`/invite/${encodeURIComponent(invitationId)}`, window.location.origin).href;
}

export const ROLE_LABELS: Record<MemberRole, string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
};
