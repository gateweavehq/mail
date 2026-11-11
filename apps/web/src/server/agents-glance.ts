import { getRequestHeaders } from "@tanstack/react-start/server";
import { and, count, eq, getTableName, gte, inArray, sql } from "drizzle-orm";
import { AGENT_LOG_KINDS, type AgentLogAction } from "../lib/agent-log";
import { type AgentGlance, GLANCE_HOURS } from "../lib/agents";
import { isAdminRole } from "../lib/roles";
import { bearsKey, currentMember } from "./access";
import { db, getAuth } from "./auth";
import { AGENT_ROLE } from "./auth/agents";
import { type Database, schema } from "./db";

// The workspace's agents at a glance, for its home. It reads D1 only, the agents and their log,
// so it costs the same however many mailboxes they have, and the page can ask it often.

const SENT = "message.sent" satisfies AgentLogAction;
const HELD = "message.held" satisfies AgentLogAction;
const READS: readonly string[] = AGENT_LOG_KINDS.reads;
const COUNTED = [SENT, HELD, ...READS];

type Recent = Pick<AgentGlance, "recent" | "last">;

/**
 * What each agent of the workspace did with its key since a time, and the last thing it did, by
 * membership. Two statements, whatever the number of agents: the counts by the log's index on
 * the agent and the time, the last by the same index read from its newest end.
 */
export async function agentsRecently(
	database: Database,
	workspaceId: string,
	since: Date,
): Promise<Map<string, Recent>> {
	const { agentLog, member } = schema;
	const agents = and(eq(member.organizationId, workspaceId), eq(member.role, AGENT_ROLE));
	// A select from one table names its columns without the table, which inside the subquery would
	// be the log's own `id`: so the agent's is named in full.
	const agentId = sql`${sql.identifier(getTableName(member))}.${sql.identifier(member.id.name)}`;
	const newest = <T>(column: typeof agentLog.at | typeof agentLog.action) => sql<T | null>`(
		SELECT ${column} FROM ${agentLog}
		WHERE ${agentLog.agentMemberId} = ${agentId} AND ${agentLog.organizationId} = ${workspaceId}
			AND ${agentLog.byAgent} = 1
		ORDER BY ${agentLog.at} DESC, ${agentLog.id} DESC LIMIT 1
	)`;
	const [counts, lasts] = await database.batch([
		database
			.select({ memberId: agentLog.agentMemberId, action: agentLog.action, total: count() })
			.from(member)
			.innerJoin(
				agentLog,
				and(
					eq(agentLog.agentMemberId, member.id),
					eq(agentLog.organizationId, workspaceId),
					eq(agentLog.byAgent, true),
					gte(agentLog.at, since),
					inArray(agentLog.action, COUNTED),
				),
			)
			.where(agents)
			.groupBy(agentLog.agentMemberId, agentLog.action),
		database
			.select({
				memberId: member.id,
				// Raw, as a subquery's column is: the time in milliseconds, null when it found none.
				at: newest<number>(agentLog.at),
				action: newest<string>(agentLog.action),
			})
			.from(member)
			.where(agents),
	]);

	const recently = new Map<string, Recent>();
	for (const row of lasts) {
		recently.set(row.memberId, {
			recent: { sent: 0, held: 0, reads: 0 },
			last:
				row.at === null || row.action === null
					? null
					: { at: row.at, action: row.action as AgentLogAction },
		});
	}
	for (const row of counts) {
		const recent = recently.get(row.memberId)?.recent;
		if (!recent) continue;
		if (row.action === SENT) recent.sent += row.total;
		else if (row.action === HELD) recent.held += row.total;
		else if (READS.includes(row.action)) recent.reads += row.total;
	}
	return recently;
}

/**
 * The workspace's agents, each with what it holds and did of late, for an owner or admin signed
 * in. Null for anyone else, and for a request with a key, the agent's own included.
 */
export async function agentsAtAGlance(
	slug: string,
	now = Date.now(),
): Promise<AgentGlance[] | null> {
	const headers = getRequestHeaders();
	if (bearsKey(headers)) return null;
	const caller = await currentMember(slug);
	if (!caller || !isAdminRole(caller.membership.role)) return null;
	const { workspaceId } = caller.membership;
	const [agents, recently] = await Promise.all([
		getAuth().api.listAgents({ query: { organizationId: workspaceId }, headers }),
		agentsRecently(db, workspaceId, new Date(now - GLANCE_HOURS * 60 * 60 * 1000)),
	]);
	return agents.map((agent) => {
		const used = agent.keys.flatMap((key) => (key.lastUsedAt === null ? [] : [key.lastUsedAt]));
		return {
			id: agent.id,
			name: agent.name,
			paused: agent.paused,
			liveAddresses: agent.liveAddresses,
			...(recently.get(agent.memberId) ?? { recent: { sent: 0, held: 0, reads: 0 }, last: null }),
			keyUsedAt: used.length > 0 ? Math.max(...used) : null,
		};
	});
}

/** The same, as the API's answer, for `GET /api/agents/<workspace>`: JSON, or 404. */
export async function agentsAtAGlanceAnswer(slug: string): Promise<Response> {
	const agents = await agentsAtAGlance(slug);
	return Response.json(agents ? { agents } : { error: "Not found" }, {
		status: agents ? 200 : 404,
		headers: { "cache-control": "no-store" },
	});
}
