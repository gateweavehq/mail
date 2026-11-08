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
 * Whether a request carries a bearer token, which makes it an agent's, whatever cookies come with
 * it. Another scheme, such as Basic auth from a proxy in front of the app, carries no key.
 */
export const bearsKey = (headers: Headers) =>
	/^bearer(\s|$)/i.test(headers.get("authorization")?.trim() ?? "");

/**
 * The caller for what an agent may also do: reading the mailboxes it was given, listing them, and
 * sending from those that let it. A request with a bearer token is an agent's (`bearsKey`): a key
 * that doesn't work is turned away, never tried as someone's session instead. A key works only in
 * the workspace it was made for. Without one, the session decides. Other changes stay with
 * `currentMember`, for people.
 */
export async function currentCaller(slug: string): Promise<Caller | null> {
	const headers = getRequestHeaders();
	const authorization = headers.get("authorization")?.trim() ?? "";
	if (!bearsKey(headers)) {
		const member = await currentMember(slug);
		return member && { userId: member.user.id, membership: member.membership };
	}
	const key = /^bearer\s+(\S+)$/i.exec(authorization)?.[1];
	const agent = key ? await findAgentByKey(db, key) : null;
	if (!agent || agent.slug !== slug) return null;
	const membership = await findMembership(db, slug, agent.userId);
	return membership && { userId: agent.userId, membership };
}
