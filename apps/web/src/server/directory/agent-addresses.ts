import { and, asc, count, eq, gt, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { parseDomainName } from "../../lib/addresses";
import { agentLocalPart, MAX_AGENT_ADDRESS_DAYS, randomLocalPart } from "../../lib/agent-addresses";
import { bearsKey } from "../access";
import { noteAgent } from "../agent-log";
import { db } from "../auth";
import type { Database } from "../db";
import { schema } from "../db";
import { openMailbox } from "../mailbox/read";
import { addressPolicyOf, liveAddressCounts, liveAt } from "./agent-address-store";
import { ENDED_ADDRESS_KEPT_DAYS, MAX_ADDRESSES_PER_WORKSPACE } from "./index";

const { agentAddressPolicy, mailAddress, mailboxAccess, mailDomain, removedAddress } = schema;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An address an agent made, as it sees it. */
export interface AgentAddress {
	id: string;
	address: string;
	expiresAt: number;
}

/** The live addresses this agent made in this mailbox, oldest first. */
async function madeIn(db: Database, memberId: string, mailboxId: string, now: Date) {
	const rows = await db
		.select({
			id: mailAddress.id,
			localPart: mailAddress.localPart,
			domain: mailDomain.name,
			expiresAt: mailAddress.expiresAt,
		})
		.from(mailAddress)
		.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
		.where(
			and(
				eq(mailAddress.agentMemberId, memberId),
				eq(mailAddress.mailboxId, mailboxId),
				liveAt(now),
			),
		)
		.orderBy(asc(mailAddress.createdAt), asc(mailAddress.id))
		.all();
	return rows.map(
		(row): AgentAddress => ({
			id: row.id,
			address: `${row.localPart}@${row.domain}`,
			// An agent's address always ends; the trigger and `makeAgentAddress` both set one.
			expiresAt: row.expiresAt?.getTime() ?? now.getTime(),
		}),
	);
}

export interface Refusal {
	ok: false;
	error: string;
	status: 400 | 403 | 404 | 409;
}

const refuse = (error: string, status: Refusal["status"]): Refusal => ({
	ok: false,
	error,
	status,
});

function isUniqueViolation(error: unknown): boolean {
	for (let at = error; at instanceof Error; at = at.cause) {
		if (at.message.includes("UNIQUE constraint failed")) return true;
	}
	return false;
}

/** The agent making an address, and the mailbox it goes to, as the route has checked them. */
export interface Maker {
	workspaceId: string;
	memberId: string;
	userId: string;
	mailboxId: string;
}

export interface AddressRequest {
	domain: string;
	/** Mail picks one when there is none. */
	localPart: string | null;
	/** The agent's longest when there is none. */
	days: number | null;
}

/**
 * How many addresses a workspace's agents may have made, counting ended ones while their names are
 * kept: half the workspace's cap, so that agents ending and making addresses never keep people from
 * adding theirs.
 */
export const MAX_AGENT_ADDRESSES_PER_WORKSPACE = MAX_ADDRESSES_PER_WORKSPACE / 2;

const KEPT_MS = ENDED_ADDRESS_KEPT_DAYS * DAY_MS;

const TAKEN = `That address is taken, or it ended less than ${ENDED_ADDRESS_KEPT_DAYS} days ago.`;

/**
 * Makes an address for an agent, in a mailbox it may send from, as its policy allows: on a domain
 * it names, which the workspace has proved, lasting no longer than it says, while the agent holds
 * fewer than it may at once and has made fewer than that in the last day, and while the workspace's
 * agents have made fewer than their share. A name a person removed is kept from it a while. All of
 * it is checked in the statement that adds the row, so neither calls at once nor an admin's change
 * in the meantime can pass it; only when it refuses is the reason looked for.
 */
export async function makeAgentAddress(
	db: Database,
	maker: Maker,
	request: AddressRequest,
	now: Date,
): Promise<{ ok: true; address: AgentAddress } | Refusal> {
	let chosen: string | null = null;
	if (request.localPart !== null) {
		const parsed = agentLocalPart(request.localPart);
		if (!parsed.ok) return refuse(parsed.error, 400);
		chosen = parsed.localPart;
	}
	// The length when the agent gives none. The statement checks it against the policy again.
	const days = request.days ?? (await addressPolicyOf(db, maker.memberId)).maxDays;
	const domainName = parseDomainName(request.domain);
	const domain = domainName ? await provedDomain(db, maker.workspaceId, domainName) : undefined;
	if (!domainName || !domain) return whyNot(db, maker, domainName, days, now);

	const at = now.getTime();
	const expiresAt = at + days * DAY_MS;
	// A random name that is taken is tried once more; one chosen is the agent's to change.
	for (let tries = chosen === null ? 2 : 1; tries > 0; tries--) {
		const id = crypto.randomUUID();
		const localPart = chosen ?? randomLocalPart();
		const held = sql`(SELECT count(*) FROM ${mailAddress} WHERE ${mailAddress.agentMemberId} = ${maker.memberId}
			AND (${mailAddress.expiresAt} IS NULL OR ${mailAddress.expiresAt} > ${at}))`;
		const madeToday = sql`(SELECT count(*) FROM ${mailAddress} WHERE ${mailAddress.agentMemberId} = ${maker.memberId}
			AND ${mailAddress.createdAt} > ${at - DAY_MS})`;
		const inWorkspace = sql`(SELECT count(*) FROM ${mailAddress} INNER JOIN ${mailDomain}
			ON ${mailDomain.id} = ${mailAddress.domainId} WHERE ${mailDomain.organizationId} = ${maker.workspaceId})`;
		const agentsMade = sql`(SELECT count(*) FROM ${mailAddress} INNER JOIN ${mailDomain}
			ON ${mailDomain.id} = ${mailAddress.domainId} WHERE ${mailDomain.organizationId} = ${maker.workspaceId}
				AND ${mailAddress.agentMemberId} IS NOT NULL)`;
		try {
			// Every column in the table's order, as Drizzle's insert-select needs. The row comes from
			// the agent's policy, and only when all of it holds.
			const { meta } = await db
				.insert(mailAddress)
				.select(
					sql`SELECT ${id}, ${domain.id}, ${localPart}, ${maker.mailboxId}, ${expiresAt},
						${maker.userId}, ${at}, ${maker.memberId}
						FROM ${agentAddressPolicy}
						WHERE ${agentAddressPolicy.memberId} = ${maker.memberId}
							AND ${agentAddressPolicy.maxDays} >= ${days}
							AND EXISTS (SELECT 1 FROM json_each(${agentAddressPolicy.domains}) WHERE value = ${domainName})
							AND EXISTS (SELECT 1 FROM ${mailboxAccess} WHERE ${mailboxAccess.mailboxId} = ${maker.mailboxId}
								AND ${mailboxAccess.memberId} = ${maker.memberId} AND ${mailboxAccess.send} = 1)
							AND EXISTS (SELECT 1 FROM ${mailDomain} WHERE ${mailDomain.id} = ${domain.id}
								AND ${mailDomain.organizationId} = ${maker.workspaceId} AND ${mailDomain.verifiedAt} IS NOT NULL)
							AND ${held} < ${agentAddressPolicy.maxLive}
							AND ${madeToday} < ${agentAddressPolicy.maxLive}
							AND ${agentsMade} < ${MAX_AGENT_ADDRESSES_PER_WORKSPACE}
							AND ${inWorkspace} < ${MAX_ADDRESSES_PER_WORKSPACE}
							AND NOT EXISTS (SELECT 1 FROM ${removedAddress} WHERE ${removedAddress.domainId} = ${domain.id}
								AND ${removedAddress.localPart} = ${localPart} AND ${removedAddress.removedAt} > ${at - KEPT_MS})`,
				)
				.run();
			if (meta.changes === 0) return whyNot(db, maker, domainName, days, now);
			return { ok: true, address: { id, address: `${localPart}@${domainName}`, expiresAt } };
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
		}
	}
	return refuse(TAKEN, 409);
}

async function provedDomain(db: Database, workspaceId: string, name: string) {
	return db
		.select({ id: mailDomain.id })
		.from(mailDomain)
		.where(
			and(
				eq(mailDomain.organizationId, workspaceId),
				eq(mailDomain.name, name),
				isNotNull(mailDomain.verifiedAt),
			),
		)
		.get();
}

/** Why the statement made no address, in words, in the order an agent should hear it. */
async function whyNot(
	db: Database,
	maker: Maker,
	domainName: string | null,
	days: number,
	now: Date,
): Promise<Refusal> {
	const grant = await db
		.select({ send: mailboxAccess.send })
		.from(mailboxAccess)
		.where(
			and(eq(mailboxAccess.mailboxId, maker.mailboxId), eq(mailboxAccess.memberId, maker.memberId)),
		)
		.get();
	if (!grant?.send) {
		return refuse(
			"This agent may read this mailbox but not send from it, so it can't add an address to it.",
			403,
		);
	}
	const policy = await addressPolicyOf(db, maker.memberId);
	if (policy.maxLive === 0 || policy.domains.length === 0) {
		return refuse(
			"This agent may not make addresses. An owner or admin can let it on Settings → Agents.",
			403,
		);
	}
	if (!domainName || !policy.domains.includes(domainName)) {
		return refuse("This agent may not make addresses on that domain.", 403);
	}
	if (days > policy.maxDays) {
		return refuse(
			`This agent's addresses last at most ${policy.maxDays} ${policy.maxDays === 1 ? "day" : "days"}.`,
			400,
		);
	}
	if (!(await provedDomain(db, maker.workspaceId, domainName))) {
		return refuse("The workspace hasn't proved that domain.", 409);
	}
	const inWorkspace = eq(mailDomain.organizationId, maker.workspaceId);
	const [held, made, agents, workspace] = await db.batch([
		db
			.select({ total: count() })
			.from(mailAddress)
			.where(and(eq(mailAddress.agentMemberId, maker.memberId), liveAt(now))),
		db
			.select({ total: count() })
			.from(mailAddress)
			.where(
				and(
					eq(mailAddress.agentMemberId, maker.memberId),
					gt(mailAddress.createdAt, new Date(now.getTime() - DAY_MS)),
				),
			),
		db
			.select({ total: count() })
			.from(mailAddress)
			.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
			.where(and(inWorkspace, isNotNull(mailAddress.agentMemberId))),
		db
			.select({ total: count() })
			.from(mailAddress)
			.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
			.where(inWorkspace),
	]);
	const many = `${policy.maxLive} ${policy.maxLive === 1 ? "address" : "addresses"}`;
	if ((held[0]?.total ?? 0) >= policy.maxLive) {
		return refuse(`This agent holds ${many}, as many as it may. End one first.`, 409);
	}
	if ((agents[0]?.total ?? 0) >= MAX_AGENT_ADDRESSES_PER_WORKSPACE) {
		return refuse(
			`A workspace's agents can have made ${MAX_AGENT_ADDRESSES_PER_WORKSPACE} of its addresses, counting those that ended in the last ${ENDED_ADDRESS_KEPT_DAYS} days.`,
			409,
		);
	}
	if ((workspace[0]?.total ?? 0) >= MAX_ADDRESSES_PER_WORKSPACE) {
		return refuse(`A workspace can have ${MAX_ADDRESSES_PER_WORKSPACE} addresses.`, 409);
	}
	if ((made[0]?.total ?? 0) >= policy.maxLive) {
		return refuse(`This agent made ${many} in the last day, as many as it may.`, 409);
	}
	// What is left is the name: a person removed it lately, or someone took it in the meantime.
	return refuse(TAKEN, 409);
}

/**
 * Ends one of the live addresses this agent made in this mailbox, now, and gives it, or null when
 * there was none. Its name is kept a while, refusing mail, as any address that ends is.
 */
export async function endAgentAddress(
	db: Database,
	memberId: string,
	mailboxId: string,
	id: string,
	now: Date,
): Promise<string | null> {
	const [ended] = await db
		.update(mailAddress)
		.set({ expiresAt: now })
		.where(
			and(
				eq(mailAddress.id, id),
				eq(mailAddress.agentMemberId, memberId),
				eq(mailAddress.mailboxId, mailboxId),
				liveAt(now),
			),
		)
		.returning({ localPart: mailAddress.localPart, domainId: mailAddress.domainId })
		.all();
	if (!ended) return null;
	const domain = await db
		.select({ name: mailDomain.name })
		.from(mailDomain)
		.where(eq(mailDomain.id, ended.domainId))
		.get();
	return `${ended.localPart}@${domain?.name ?? ""}`;
}

const Id = z.string().min(1).max(64);

const Action = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("make"),
		domain: z.string().max(300),
		localPart: z.string().max(300).nullable().default(null),
		days: z.number().int().min(1).max(MAX_AGENT_ADDRESS_DAYS).nullable().default(null),
	}),
	z.object({ action: z.literal("end"), id: Id }),
]);

export type AgentAddressAction = z.input<typeof Action>;

function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/**
 * The addresses an agent makes for itself, at `/api/mail/<workspace>/<mailbox>/addresses`, for a
 * key only: people add addresses on the workspace's page. `GET` gives the agent's limits and the
 * live addresses it made in the mailbox; `POST` makes one, in a mailbox it may send from, or ends
 * one of its own.
 */
export async function agentAddressesAnswer(
	request: Request,
	slug: string,
	mailboxId: string,
): Promise<Response> {
	if (!bearsKey(request.headers)) {
		return answer(
			{
				ok: false,
				error:
					"Only an agent makes addresses here, with its key. People add them on the workspace's page.",
			},
			403,
		);
	}
	const box = await openMailbox(slug, mailboxId);
	if (!box) return answer({ ok: false, error: "Not found" }, 404);
	const { workspaceId, memberId } = box.member.membership;
	const now = new Date();

	if (request.method === "GET") {
		const [policy, addresses, counts] = await Promise.all([
			addressPolicyOf(db, memberId),
			madeIn(db, memberId, box.id, now),
			liveAddressCounts(db, [memberId], now),
		]);
		return answer({ ok: true, policy, live: counts.get(memberId) ?? 0, addresses });
	}

	const parsed = Action.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return answer({ ok: false, error: "That isn't a change we know." }, 400);
	const action = parsed.data;
	const note = { workspaceId, agentMemberId: memberId, by: "agent" as const, mailboxId: box.id };
	if (action.action === "end") {
		const ended = await endAgentAddress(db, memberId, box.id, action.id, now);
		if (ended === null) return answer({ ok: false, error: "Not found" }, 404);
		await noteAgent(db, { ...note, action: "address.ended", targetId: action.id, detail: ended });
		return answer({ ok: true });
	}
	// An address takes mail for the mailbox, so the agent must be let send from it, which the
	// statement that adds it checks with the rest.
	const made = await makeAgentAddress(
		db,
		{ workspaceId, memberId, userId: box.member.userId, mailboxId: box.id },
		{ domain: action.domain, localPart: action.localPart, days: action.days },
		now,
	);
	if (!made.ok) return answer({ ok: false, error: made.error }, made.status);
	await noteAgent(db, {
		...note,
		action: "address.made",
		targetId: made.address.id,
		detail: made.address.address,
	});
	return answer({ ok: true, address: made.address });
}
