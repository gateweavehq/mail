import { getRequestHeaders } from "@tanstack/react-start/server";
import { db, getAuth } from "./auth";
import { findAgentByKey } from "./auth/agents";
import { findMembership, type Membership } from "./workspaces";

/**
 * The signed-in user and their membership in the workspace with this slug, or null when nobody
 * is signed in or the user is not a member. Server functions that read or change a workspace
 * start here.
 */
export async function currentMember(slug: string) {
	const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
	if (!session) return null;
	const membership = await findMembership(db, slug, session.user.id);
	return membership && { user: session.user, membership };
}

/** Whoever asks to read: a signed-in member, or an agent by its key. */
export interface Caller {
	userId: string;
	membership: Membership;
}

/**
 * The caller for what an agent may also do: reading the mailboxes it was given, and listing them.
 * A request with a bearer token is an agent's, whatever cookies come with it: a key that doesn't
 * work is turned away, never tried as someone's session instead. A key works only in the workspace
 * it was made for. Another scheme, such as Basic auth from a proxy in front of the app, carries no
 * key, so the session decides. Changes stay with `currentMember`, for people.
 */
export async function currentCaller(slug: string): Promise<Caller | null> {
	const authorization = getRequestHeaders().get("authorization")?.trim() ?? "";
	if (!/^bearer(\s|$)/i.test(authorization)) {
		const member = await currentMember(slug);
		return member && { userId: member.user.id, membership: member.membership };
	}
	const key = /^bearer\s+(\S+)$/i.exec(authorization)?.[1];
	const agent = key ? await findAgentByKey(db, key) : null;
	if (!agent || agent.slug !== slug) return null;
	const membership = await findMembership(db, slug, agent.userId);
	return membership && { userId: agent.userId, membership };
}
