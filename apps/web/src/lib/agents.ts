import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import type { AgentInfo } from "#/server/auth/agents";
import { AGENT_LOG_KINDS, type AgentLogAction, type AgentLogKind } from "./agent-log";
import type { ListedMessage } from "./mailbox";
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

/** How far back the home screen counts what each agent did, in hours. */
export const GLANCE_HOURS = 24;

/** An agent as the workspace's home shows it to an owner or admin: what it is and did of late. */
export interface AgentGlance {
	id: string;
	name: string;
	createdAt: number;
	paused: AgentInfo["paused"];
	/** How many addresses it holds now. */
	liveAddresses: number;
	/** What it did with its key in the last `GLANCE_HOURS`, counted from its log. */
	recent: {
		sent: number;
		/** What it wrote that went to wait for a person, whether or not it still waits. */
		held: number;
		/** The messages it opened, codes and files it took from them, and its searches. */
		reads: number;
	};
	/** The last thing it did with its key, while its log keeps it: null for none. */
	last: { at: number; action: AgentLogAction } | null;
}

/**
 * The workspace's agents at a glance, from D1 alone, for owners and admins: null for anyone else,
 * and for a request with an agent's key.
 */
export const getAgentsAtAGlance = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { agentsAtAGlance } = await import("#/server/agents-glance");
		return agentsAtAGlance(slug);
	});

/** How many of each list an agent's page shows: the newest, or the addresses soonest to end. */
export const AGENT_PAGE_LISTED = 50;

/** A message on an agent's page: as a mailbox lists it, with its mailbox and who it went to. */
export interface AgentMessage extends ListedMessage {
	mailbox: { id: string; name: string };
	/** For one it wrote, who it went to in To and Cc; for one it got, the address it came to. */
	to: string[];
}

/** What an agent has and did, as its page shows it to an owner or admin. */
export interface AgentActivity {
	agent: AgentInfo;
	/** The mailboxes it was given, and whether it may send from each. */
	mailboxes: { id: string; name: string; send: boolean }[];
	/**
	 * The addresses it holds now, the soonest to end first, at most `AGENT_PAGE_LISTED` of them;
	 * `agent.liveAddresses` counts them all.
	 */
	addresses: { address: string; mailbox: { id: string; name: string }; expiresAt: number | null }[];
	/** What it wrote that waits for a person to approve it, newest first. */
	held: AgentMessage[];
	/** What it wrote, newest first. */
	wrote: AgentMessage[];
	/** What came to the addresses it made, newest first. */
	received: AgentMessage[];
	/** The mailboxes it was given that didn't answer just now, so the lists may lack theirs. */
	unread: { id: string; name: string }[];
}

/** A page of one agent's log, for owners and admins. Null as for `getAgentActivity`. */
export const getAgentLog = createServerFn({ method: "GET" })
	.validator(
		z.object({
			slug: z.string().min(1),
			agentId: z.string().min(1),
			kind: z.enum(Object.keys(AGENT_LOG_KINDS) as [AgentLogKind, ...AgentLogKind[]]).nullable(),
			before: z.object({ at: z.number().int().min(0), id: z.string().min(1).max(100) }).nullable(),
		}),
	)
	.handler(async ({ data }) => {
		const { agentLog } = await import("#/server/mailbox/agent-activity");
		return agentLog(data.slug, data.agentId, data.kind, data.before);
	});

/** One agent's page, for owners and admins. Null for anyone else, or an agent not of the workspace. */
export const getAgentActivity = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), agentId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { agentActivity } = await import("#/server/mailbox/agent-activity");
		return agentActivity(data.slug, data.agentId);
	});
