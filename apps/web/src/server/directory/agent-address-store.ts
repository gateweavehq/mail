import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import {
	type AgentAddressPolicy,
	DEFAULT_AGENT_ADDRESS_POLICY,
	readDomains,
} from "../../lib/agent-addresses";
import type { Database } from "../db";
import { schema } from "../db";

// Apart from `agent-addresses.ts`, which reaches auth, so that the agents plugin can read these.

const { agentAddressPolicy, mailAddress, mailDomain } = schema;

/** The names of the domains this workspace has proved, which an agent may be given. */
export async function provedDomains(db: Database, workspaceId: string): Promise<string[]> {
	const rows = await db
		.select({ name: mailDomain.name })
		.from(mailDomain)
		.where(and(eq(mailDomain.organizationId, workspaceId), isNotNull(mailDomain.verifiedAt)))
		.orderBy(asc(mailDomain.name))
		.all();
	return rows.map((row) => row.name);
}

/**
 * What addresses this agent's membership may make: its policy, or none when no one set one. Read as
 * the agent makes one, so a change counts from its next.
 */
export async function addressPolicyOf(db: Database, memberId: string): Promise<AgentAddressPolicy> {
	const row = await db
		.select({
			maxLive: agentAddressPolicy.maxLive,
			maxDays: agentAddressPolicy.maxDays,
			domains: agentAddressPolicy.domains,
		})
		.from(agentAddressPolicy)
		.where(eq(agentAddressPolicy.memberId, memberId))
		.get();
	return row
		? { maxLive: row.maxLive, maxDays: row.maxDays, domains: readDomains(row.domains) }
		: DEFAULT_AGENT_ADDRESS_POLICY;
}

/** Whether an address is live: it hasn't ended. */
export const liveAt = (now: Date) =>
	or(isNull(mailAddress.expiresAt), gt(mailAddress.expiresAt, now));

/** How many live addresses each of these agents' memberships holds. */
export async function liveAddressCounts(
	db: Database,
	memberIds: string[],
	now: Date,
): Promise<Map<string, number>> {
	if (memberIds.length === 0) return new Map();
	const rows = await db
		.select({ memberId: mailAddress.agentMemberId, total: count() })
		.from(mailAddress)
		.where(and(inArray(mailAddress.agentMemberId, memberIds), liveAt(now)))
		.groupBy(mailAddress.agentMemberId)
		.all();
	return new Map(rows.flatMap((row) => (row.memberId ? [[row.memberId, row.total]] : [])));
}
