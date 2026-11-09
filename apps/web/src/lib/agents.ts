import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import type { AgentInfo } from "#/server/auth/agents";
import { isAdminRole } from "./roles";

export type { AgentInfo, AgentKeyInfo } from "#/server/auth/agents";

/**
 * The workspace's agents and their keys, for owners and admins, with where the mail API is.
 * Null if the caller is not a member.
 */
export const getWorkspaceAgents = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { getAuth, db } = await import("#/server/auth");
		const { findMembership } = await import("#/server/workspaces");
		const { provedDomains } = await import("#/server/directory/agent-address-store");
		const { appOrigin } = await import("#/server/origin");
		const auth = getAuth();
		const headers = getRequestHeaders();
		const session = await auth.api.getSession({ headers });
		const membership = session && (await findMembership(db, slug, session.user.id));
		if (!membership) return null;

		const admin = isAdminRole(membership.role);
		const agents: AgentInfo[] = admin
			? await auth.api.listAgents({ query: { organizationId: membership.workspaceId }, headers })
			: [];
		// The domains an agent may be let make addresses on: those the workspace has proved.
		const domains = admin ? await provedDomains(db, membership.workspaceId) : [];
		return { admin, agents, apiUrl: `${appOrigin()}/api`, domains };
	});
