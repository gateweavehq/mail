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

/**
 * People, as opposed to agents: whom "everyone in the workspace" means. Named here, as admins are,
 * so a role added later isn't counted among them without anyone deciding it.
 */
export function isPersonRole(role: MemberRole): boolean {
	return role === "owner" || role === "admin" || role === "member";
}

/**
 * Whether someone may read a mailbox. Owners and admins read every one. Anyone else reads one they
 * were given, or one open to everyone when they are a person: opening a mailbox to the team never
 * opens it to an agent.
 */
export function canReadMailbox(
	role: MemberRole,
	{ everyone, granted }: { everyone: boolean; granted: boolean },
): boolean {
	return isAdminRole(role) || granted || (everyone && isPersonRole(role));
}
