import { getRequestHeaders } from "@tanstack/react-start/server";
import { db, getAuth } from "./auth";
import { findAgentByKey, KEY_PREFIX } from "./auth/agents";
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
	/** Whether it asks with an agent's key, rather than as someone signed in. */
	keyed: boolean;
}

/**
 * Whether a request carries an agent's key: a bearer token in Mail's shape (`gwm_…`), which makes
 * it an agent's, whatever cookies come with it, even when the rest of it is wrong. Another bearer
 * token, such as an ID token a proxy in front of the app adds, or another scheme, carries no key,
 * and the session decides.
 */
export function bearsKey(headers: Headers): boolean {
	const token = /^bearer\s+(\S+)/i.exec(headers.get("authorization")?.trim() ?? "")?.[1];
	return token?.toLowerCase().startsWith(KEY_PREFIX) ?? false;
}

/**
 * The caller for what an agent may also do: reading the mailboxes it was given, listing them, and
 * sending from those that let it. A request with an agent's key is the key's (`bearsKey`): a key
 * that doesn't work is turned away, never tried as someone's session instead. A key works only in
 * the workspace it was made for. Without one, the session decides. Other changes stay with
 * `currentMember`, for people.
 */
export async function currentCaller(slug: string): Promise<Caller | null> {
	const headers = getRequestHeaders();
	if (!bearsKey(headers)) {
		const member = await currentMember(slug);
		return member && { userId: member.user.id, membership: member.membership, keyed: false };
	}
	const key = /^bearer\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "")?.[1];
	const agent = key ? await findAgentByKey(db, key) : null;
	// A paused agent's key reaches nothing, as a revoked one doesn't; the gateways say why.
	if (!agent || "paused" in agent || agent.slug !== slug) return null;
	const membership = await findMembership(db, slug, agent.userId);
	return membership && { userId: agent.userId, membership, keyed: true };
}
