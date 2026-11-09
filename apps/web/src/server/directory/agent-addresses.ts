import { and, asc, count, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { parseDomainName } from "../../lib/addresses";
import {
	type AgentAddressPolicy,
	agentLocalPart,
	MAX_AGENT_ADDRESS_DAYS,
	randomLocalPart,
} from "../../lib/agent-addresses";
import { bearsKey } from "../access";
import { db } from "../auth";
import type { Database } from "../db";
import { schema } from "../db";
import { openMailbox } from "../mailbox/read";
import { addressPolicyOf, liveAddressCounts, liveAt } from "./agent-address-store";
import { ENDED_ADDRESS_KEPT_DAYS, MAX_ADDRESSES_PER_WORKSPACE } from "./index";

const { mailAddress, mailDomain } = schema;

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
 * Makes an address for an agent, in a mailbox it may send from, as its policy allows: on a domain
 * it names, which the workspace has proved, lasting no longer than it says, while the agent holds
 * fewer than it may at once and has made fewer than that in the last day. The counts are taken in
 * the statement that adds the row, so calls at once can't pass them.
 */
export async function makeAgentAddress(
	db: Database,
	maker: Maker,
	request: AddressRequest,
	now: Date,
): Promise<{ ok: true; address: AgentAddress } | Refusal> {
	const policy = await addressPolicyOf(db, maker.memberId);
	if (policy.maxLive === 0 || policy.domains.length === 0) {
		return refuse(
			"This agent may not make addresses. An owner or admin can let it on Settings → Agents.",
			403,
		);
	}
	const domainName = parseDomainName(request.domain);
	if (!domainName || !policy.domains.includes(domainName)) {
		return refuse("This agent may not make addresses on that domain.", 403);
	}
	const days = request.days ?? policy.maxDays;
	if (days > policy.maxDays) {
		return refuse(
			`This agent's addresses last at most ${policy.maxDays} ${policy.maxDays === 1 ? "day" : "days"}.`,
			400,
		);
	}
	let chosen: string | null = null;
	if (request.localPart !== null) {
		const parsed = agentLocalPart(request.localPart);
		if (!parsed.ok) return refuse(parsed.error, 400);
		chosen = parsed.localPart;
	}
	const domain = await db
		.select({ id: mailDomain.id })
		.from(mailDomain)
		.where(
			and(
				eq(mailDomain.organizationId, maker.workspaceId),
				eq(mailDomain.name, domainName),
				isNotNull(mailDomain.verifiedAt),
			),
		)
		.get();
	if (!domain) return refuse("The workspace hasn't proved that domain.", 409);

	const expiresAt = now.getTime() + days * DAY_MS;
	// A random name that is taken is tried once more; one chosen is the agent's to change.
	for (let tries = chosen === null ? 2 : 1; tries > 0; tries--) {
		const id = crypto.randomUUID();
		const localPart = chosen ?? randomLocalPart();
		const held = sql`(SELECT count(*) FROM ${mailAddress} WHERE ${mailAddress.agentMemberId} = ${maker.memberId}
			AND (${mailAddress.expiresAt} IS NULL OR ${mailAddress.expiresAt} > ${now.getTime()}))`;
		const madeToday = sql`(SELECT count(*) FROM ${mailAddress} WHERE ${mailAddress.agentMemberId} = ${maker.memberId}
			AND ${mailAddress.createdAt} > ${now.getTime() - DAY_MS})`;
		const inWorkspace = sql`(SELECT count(*) FROM ${mailAddress} INNER JOIN ${mailDomain}
			ON ${mailDomain.id} = ${mailAddress.domainId} WHERE ${mailDomain.organizationId} = ${maker.workspaceId})`;
		try {
			// Every column in the table's order, as Drizzle's insert-select needs.
			const { meta } = await db
				.insert(mailAddress)
				.select(
					sql`SELECT ${id}, ${domain.id}, ${localPart}, ${maker.mailboxId}, ${expiresAt},
						${maker.userId}, ${now.getTime()}, ${maker.memberId}
						WHERE ${held} < ${policy.maxLive} AND ${madeToday} < ${policy.maxLive}
							AND ${inWorkspace} < ${MAX_ADDRESSES_PER_WORKSPACE}`,
				)
				.run();
			if (meta.changes === 0) return limitReached(db, maker, policy, now);
			return { ok: true, address: { id, address: `${localPart}@${domainName}`, expiresAt } };
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
		}
	}
	return refuse(
		`That address is taken, or it ended less than ${ENDED_ADDRESS_KEPT_DAYS} days ago.`,
		409,
	);
}

/** Which limit kept an address from being made, in words. */
async function limitReached(
	db: Database,
	maker: Maker,
	policy: AgentAddressPolicy,
	now: Date,
): Promise<Refusal> {
	const held = await db
		.select({ total: count() })
		.from(mailAddress)
		.where(and(eq(mailAddress.agentMemberId, maker.memberId), liveAt(now)))
		.get();
	const many = `${policy.maxLive} ${policy.maxLive === 1 ? "address" : "addresses"}`;
	if ((held?.total ?? 0) >= policy.maxLive) {
		return refuse(`This agent holds ${many}, as many as it may. End one first.`, 409);
	}
	const workspace = await db
		.select({ total: count() })
		.from(mailAddress)
		.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
		.where(eq(mailDomain.organizationId, maker.workspaceId))
		.get();
	if ((workspace?.total ?? 0) >= MAX_ADDRESSES_PER_WORKSPACE) {
		return refuse(`A workspace can have ${MAX_ADDRESSES_PER_WORKSPACE} addresses.`, 409);
	}
	return refuse(`This agent made ${many} in the last day, as many as it may.`, 409);
}

/**
 * Ends one of the live addresses this agent made in this mailbox, now. Its name is kept a while,
 * refusing mail, as any address that ends is.
 */
export async function endAgentAddress(
	db: Database,
	memberId: string,
	mailboxId: string,
	id: string,
	now: Date,
): Promise<boolean> {
	const { meta } = await db
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
		.run();
	return meta.changes > 0;
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
	if (action.action === "end") {
		return (await endAgentAddress(db, memberId, box.id, action.id, now))
			? answer({ ok: true })
			: answer({ ok: false, error: "Not found" }, 404);
	}
	// An address takes mail for the mailbox, and an agent that may only read it shouldn't add one.
	if (!box.agentMaySend) {
		return answer(
			{
				ok: false,
				error:
					"This agent may read this mailbox but not send from it, so it can't add an address to it.",
			},
			403,
		);
	}
	const made = await makeAgentAddress(
		db,
		{ workspaceId, memberId, userId: box.member.userId, mailboxId: box.id },
		{ domain: action.domain, localPart: action.localPart, days: action.days },
		now,
	);
	return made.ok
		? answer({ ok: true, address: made.address })
		: answer({ ok: false, error: made.error }, made.status);
}
