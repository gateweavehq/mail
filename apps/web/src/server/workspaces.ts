import { and, eq, gt } from "drizzle-orm";
import type { MemberRole } from "#/lib/roles";
import type { Database } from "./db";
import { schema } from "./db";

export interface Membership {
	workspaceId: string;
	workspaceName: string;
	role: MemberRole;
}

/** Resolves a workspace slug to the caller's membership, or null if they are not a member. */
export async function findMembership(
	db: Database,
	slug: string,
	userId: string,
): Promise<Membership | null> {
	const row = await db
		.select({
			workspaceId: schema.member.organizationId,
			workspaceName: schema.organization.name,
			role: schema.member.role,
		})
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
		.where(and(eq(schema.organization.slug, slug), eq(schema.member.userId, userId)))
		.get();
	return row ? { ...row, role: toRole(row.role) } : null;
}

/** The user's membership in the workspace with this id, with its slug, or null. */
export async function findMembershipById(
	db: Database,
	workspaceId: string,
	userId: string,
): Promise<(Membership & { slug: string }) | null> {
	const row = await db
		.select({
			workspaceId: schema.member.organizationId,
			workspaceName: schema.organization.name,
			slug: schema.organization.slug,
			role: schema.member.role,
		})
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
		.where(and(eq(schema.organization.id, workspaceId), eq(schema.member.userId, userId)))
		.get();
	return row ? { ...row, role: toRole(row.role) } : null;
}

export interface WorkspaceSummary {
	slug: string;
	name: string;
	role: MemberRole;
}

/** Every workspace the user belongs to, by name. */
export async function listWorkspaces(db: Database, userId: string): Promise<WorkspaceSummary[]> {
	const rows = await db
		.select({
			slug: schema.organization.slug,
			name: schema.organization.name,
			role: schema.member.role,
		})
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
		.where(eq(schema.member.userId, userId))
		.orderBy(schema.organization.name)
		.all();
	return rows.map((row) => ({ ...row, role: toRole(row.role) }));
}

/** The names of the workspace's members, by user id. */
export async function memberNames(db: Database, workspaceId: string): Promise<Map<string, string>> {
	const rows = await db
		.select({ userId: schema.member.userId, name: schema.user.name })
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
		.where(eq(schema.member.organizationId, workspaceId))
		.all();
	return new Map(rows.map((row) => [row.userId, row.name]));
}

export interface InvitationPreview {
	workspaceName: string;
	workspaceSlug: string;
	inviterName: string;
	email: string;
	role: MemberRole;
	expiresAt: number;
}

/**
 * A pending, unexpired invitation, with what its recipient needs to decide before signing in.
 * The id is the secret here, just as it is in the invitation link.
 */
export async function findPendingInvitation(
	db: Database,
	invitationId: string,
): Promise<InvitationPreview | null> {
	const row = await db
		.select({
			workspaceName: schema.organization.name,
			workspaceSlug: schema.organization.slug,
			inviterName: schema.user.name,
			email: schema.invitation.email,
			role: schema.invitation.role,
			expiresAt: schema.invitation.expiresAt,
		})
		.from(schema.invitation)
		.innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
		.innerJoin(schema.user, eq(schema.invitation.inviterId, schema.user.id))
		.where(
			and(
				eq(schema.invitation.id, invitationId),
				eq(schema.invitation.status, "pending"),
				gt(schema.invitation.expiresAt, new Date()),
			),
		)
		.get();
	return row
		? { ...row, role: toRole(row.role ?? "member"), expiresAt: row.expiresAt.getTime() }
		: null;
}

/** Better Auth stores roles as a comma-separated list; the highest one wins. */
export function toRole(role: string): MemberRole {
	const roles = role.split(",").map((r) => r.trim());
	if (roles.includes("owner")) return "owner";
	if (roles.includes("admin")) return "admin";
	return "member";
}
