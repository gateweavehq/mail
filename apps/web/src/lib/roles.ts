/** A person's role in a workspace, highest first. Better Auth's organization roles. */
export const MEMBER_ROLES = ["owner", "admin", "member"] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Owners and admins manage members and invitations. Decide it here, by naming the roles that may,
 * and never by comparing a role with `member`: a role added later (an agent's) would then be an
 * admin without anyone having granted it.
 */
export function isAdminRole(role: MemberRole): boolean {
	return role === "owner" || role === "admin";
}
