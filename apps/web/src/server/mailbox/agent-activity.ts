import { getRequestHeaders } from "@tanstack/react-start/server";
import { and, asc, eq } from "drizzle-orm";
import { type AgentLogKind, type AgentLogPage, isAgentLogKind } from "../../lib/agent-log";
import { AGENT_PAGE_LISTED, type AgentActivity, type AgentMessage } from "../../lib/agents";
import { isAdminRole } from "../../lib/roles";
import { bearsKey, currentMember } from "../access";
import { agentLogPage } from "../agent-log";
import { db, getAuth } from "../auth";
import { AGENT_ROLE } from "../auth/agents";
import { schema } from "../db";
import { liveAt } from "../directory/agent-address-store";
import type { StoredSummary } from "./durable-object";
import { mailboxStub } from "./index";
import { envelopeRecipients, listed, senderNames } from "./read";

/**
 * What an agent of this workspace has, wrote and received, for an owner or admin signed in: its
 * mailboxes and the addresses it made, the mail it wrote, what of that waits for a person, and the
 * mail that came to its addresses, from every mailbox it was ever given, newest first. Null for
 * anyone else, and for an agent of another workspace, so its id gives nothing away.
 */
export async function agentActivity(slug: string, agentId: string): Promise<AgentActivity | null> {
	// A request with a key is the key's, whatever cookies come with it, and keys see no agent's page.
	if (bearsKey(getRequestHeaders())) return null;
	const member = await currentMember(slug);
	if (!member || !isAdminRole(member.membership.role)) return null;
	const { workspaceId, memberId: me } = member.membership;
	const agents = await getAuth().api.listAgents({
		query: { organizationId: workspaceId },
		headers: getRequestHeaders(),
	});
	const agent = agents.find((one) => one.id === agentId);
	if (!agent) return null;

	const { agentMailbox, mailbox, mailboxAccess, mailAddress, mailDomain } = schema;
	const [mailboxes, grants, addresses] = await Promise.all([
		// Each it was ever given, as what it wrote stays where it wrote it after its grant goes.
		db
			.select({ id: mailbox.id, name: mailbox.name })
			.from(agentMailbox)
			.innerJoin(mailbox, eq(mailbox.id, agentMailbox.mailboxId))
			.where(
				and(eq(agentMailbox.memberId, agent.memberId), eq(mailbox.organizationId, workspaceId)),
			)
			.orderBy(asc(mailbox.name), asc(mailbox.id))
			.all(),
		db
			.select({ mailboxId: mailboxAccess.mailboxId, send: mailboxAccess.send })
			.from(mailboxAccess)
			.where(eq(mailboxAccess.memberId, agent.memberId))
			.all(),
		db
			.select({
				localPart: mailAddress.localPart,
				domain: mailDomain.name,
				mailboxId: mailAddress.mailboxId,
				expiresAt: mailAddress.expiresAt,
			})
			.from(mailAddress)
			.innerJoin(mailDomain, eq(mailDomain.id, mailAddress.domainId))
			.where(and(eq(mailAddress.agentMemberId, agent.memberId), liveAt(new Date())))
			.orderBy(asc(mailAddress.expiresAt), asc(mailAddress.localPart))
			.limit(AGENT_PAGE_LISTED)
			.all(),
	]);
	const names = new Map(mailboxes.map((box) => [box.id, box.name]));
	const sends = new Map(grants.map((grant) => [grant.mailboxId, grant.send]));

	// A mailbox that doesn't answer, such as one whose object still runs the code from before a
	// deploy, leaves the others to show, and the page says which it couldn't read.
	const settled = await Promise.allSettled(
		mailboxes.map(async (box) => ({
			box,
			rows: await mailboxStub(box.id).ofAgent(agent.memberId, AGENT_PAGE_LISTED),
		})),
	);
	const found = settled.flatMap((one) => (one.status === "fulfilled" ? [one.value] : []));
	for (const one of settled) {
		if (one.status === "fulfilled") continue;
		console.error("agent page: a mailbox didn't say what the agent did there", {
			name: one.reason instanceof Error ? one.reason.name : "unknown",
		});
	}
	const unread = mailboxes.filter((_, at) => settled[at]?.status === "rejected");
	const all = found.flatMap(({ rows }) => [...rows.wrote, ...rows.received]);
	const people = await senderNames(workspaceId, all);
	const shown = (pick: (rows: (typeof found)[number]["rows"]) => StoredSummary[]) =>
		found
			.flatMap(({ box, rows }) =>
				pick(rows).map(
					(row): AgentMessage => ({
						...listed(row, people, me),
						mailbox: { id: box.id, name: box.name },
						to: envelopeRecipients(row.envelopeTo),
					}),
				),
			)
			.sort((one, other) => other.arrivedAt - one.arrivedAt || other.id.localeCompare(one.id))
			.slice(0, AGENT_PAGE_LISTED);

	return {
		agent,
		// An agent reads only what it was given: a mailbox open to everyone isn't open to it.
		mailboxes: mailboxes
			.filter((box) => sends.has(box.id))
			.map((box) => ({ id: box.id, name: box.name, send: sends.get(box.id) === true })),
		addresses: addresses.map((address) => ({
			address: `${address.localPart}@${address.domain}`,
			mailbox: { id: address.mailboxId, name: names.get(address.mailboxId) ?? "" },
			expiresAt: address.expiresAt?.getTime() ?? null,
		})),
		held: shown((rows) => rows.held),
		wrote: shown((rows) => rows.wrote),
		received: shown((rows) => rows.received),
		unread,
	};
}

/** The same, as the API's answer: JSON, or 404 for whoever may not see it. */
export async function agentActivityAnswer(slug: string, agentId: string): Promise<Response> {
	const activity = await agentActivity(slug, agentId);
	return Response.json(activity ?? { error: "Not found" }, {
		status: activity ? 200 : 404,
		headers: { "cache-control": "no-store" },
	});
}

/**
 * A page of what an agent of this workspace did and what people did to it, newest first, of one
 * kind or all, for an owner or admin signed in. Null for anyone else, as for `agentActivity`.
 */
export async function agentLog(
	slug: string,
	agentId: string,
	kind: AgentLogKind | null,
	before: { at: number; id: string } | null,
): Promise<AgentLogPage | null> {
	if (bearsKey(getRequestHeaders())) return null;
	const caller = await currentMember(slug);
	if (!caller || !isAdminRole(caller.membership.role)) return null;
	const { workspaceId } = caller.membership;
	const { member } = schema;
	const agent = await db
		.select({ memberId: member.id })
		.from(member)
		.where(
			and(
				eq(member.userId, agentId),
				eq(member.organizationId, workspaceId),
				eq(member.role, AGENT_ROLE),
			),
		)
		.get();
	return agent ? agentLogPage(db, workspaceId, agent.memberId, kind, before) : null;
}

/**
 * The same, as the API's answer, for `GET /api/agents/<workspace>/<agent>/log`, with `kind`, and
 * `beforeAt` and `beforeId` for an older page: JSON, or 404 for whoever may not see it.
 */
export async function agentLogAnswer(slug: string, agentId: string, url: URL): Promise<Response> {
	const headers = { "cache-control": "no-store" };
	const asked = url.searchParams.get("kind");
	if (asked !== null && !isAgentLogKind(asked)) {
		return Response.json({ error: "No such kind" }, { status: 400, headers });
	}
	const at = Number(url.searchParams.get("beforeAt"));
	const id = url.searchParams.get("beforeId");
	const before = id && Number.isSafeInteger(at) && at >= 0 && id.length <= 100 ? { at, id } : null;
	const page = await agentLog(slug, agentId, asked, before);
	return Response.json(page ?? { error: "Not found" }, { status: page ? 200 : 404, headers });
}
