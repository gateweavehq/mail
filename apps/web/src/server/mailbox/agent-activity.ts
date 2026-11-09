import { getRequestHeaders } from "@tanstack/react-start/server";
import { and, asc, eq } from "drizzle-orm";
import { AGENT_PAGE_LISTED, type AgentActivity, type AgentMessage } from "../../lib/agents";
import { isAdminRole } from "../../lib/roles";
import { bearsKey, currentMember } from "../access";
import { db, getAuth } from "../auth";
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
