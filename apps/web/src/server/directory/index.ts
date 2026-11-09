import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { parseDomainName, parseLocalPart, splitRecipient } from "../../lib/addresses";
import type { Directory, MailRoute, ResendReceiving } from "../../lib/directory";
import type { SendsWith } from "../../lib/providers";
import { canReadMailbox, isAdminRole, type MemberRole } from "../../lib/roles";
import { AGENT_ROLE, isAgentMembership } from "../auth/agents";
import type { Database } from "../db";
import { schema } from "../db";
import { toRole } from "../workspaces";
import { type LookUpDomain, proofName } from "./dns";

const { mailAddress, mailDomain, mailbox, mailboxAccess, member, providerKey, resendInbound } =
	schema;

// Caps, so a stranger signing up can't fill the database. Two requests at once can pass one by a
// little, which does no harm.
export const MAX_DOMAINS_PER_WORKSPACE = 20;
export const MAX_MAILBOXES_PER_WORKSPACE = 500;
export const MAX_ADDRESSES_PER_WORKSPACE = 5_000;
export const MAX_MAILBOX_NAME = 80;
/** The most people one mailbox can be given to, besides everyone. */
export const MAX_MAILBOX_READERS = 1_000;

/**
 * How long a temporary address keeps its name once it ends, refusing mail all the while. Whatever
 * it signed up for may still write to it, so it shouldn't pass to someone else straight away.
 */
export const ENDED_ADDRESS_KEPT_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const VERIFICATION_PREFIX = "gateweave-mail-verification=";
const CLOUDFLARE_MAIL_HOST = ".mx.cloudflare.net";
/** The hosts Resend gives for a receiving MX record: its own, or Amazon SES's in a region. */
const RESEND_MAIL_HOSTS = [/(^|\.)forge\.rmta\.net$/, /^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/];

export interface Refusal {
	ok: false;
	error: string;
	status: 400 | 404 | 409 | 502;
}
export type Result<T = object> = ({ ok: true } & T) | Refusal;

const refuse = (error: string, status: Refusal["status"] = 400): Refusal => ({
	ok: false,
	error,
	status,
});
const notFound = () => refuse("Not found", 404);

function isUniqueViolation(error: unknown): boolean {
	for (let at = error; at instanceof Error; at = at.cause) {
		if (at.message.includes("UNIQUE constraint failed")) return true;
	}
	return false;
}

const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomUUID().replaceAll("-", "");
const proofValue = (token: string) => `${VERIFICATION_PREFIX}${token}`;

/**
 * The mailbox a message to this address belongs in, or null when there is none: no such address,
 * one past its time, or a domain nobody has proved. This has to read the primary, never a replica,
 * so that an address works from the moment it is made, and `db` does.
 */
export async function findAddress(db: Database, recipient: string, now: Date) {
	const parts = splitRecipient(recipient);
	if (!parts) return null;
	const found = await db
		.select({
			mailboxId: mailAddress.mailboxId,
			workspaceId: mailDomain.organizationId,
			receivesWith: mailDomain.receivesWith,
		})
		.from(mailAddress)
		.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
		.where(
			and(
				eq(mailDomain.name, parts.domain),
				isNotNull(mailDomain.verifiedAt),
				eq(mailAddress.localPart, parts.localPart),
				or(isNull(mailAddress.expiresAt), gt(mailAddress.expiresAt, now)),
			),
		)
		.get();
	return found ?? null;
}

/**
 * Who reads a mailbox besides owners and admins, people and agents apart, as they are chosen, and
 * the agents that may send from it too.
 */
function accessOf(everyone: boolean, grants: { memberId: string; role: string; send: boolean }[]) {
	const ids = (agents: boolean) =>
		grants
			.filter((grant) => isAgentMembership(grant.role) === agents)
			.map((grant) => grant.memberId);
	const senderIds = grants
		.filter((grant) => grant.send && isAgentMembership(grant.role))
		.map((grant) => grant.memberId);
	return { everyone, memberIds: ids(false), agentIds: ids(true), senderIds };
}

/** Who is asking, for what they may see. */
export interface Viewer {
	memberId: string;
	role: MemberRole;
}

/**
 * What a workspace has, as far as this viewer may see: the mailboxes they can read, and for owners
 * and admins every mailbox, with who else can read it, and what they need to prove a domain.
 */
export async function listDirectory(
	db: Database,
	workspaceId: string,
	viewer: Viewer,
): Promise<Directory> {
	const admin = isAdminRole(viewer.role);
	const [domains, mailboxes, addresses] = await db.batch([
		db
			.select()
			.from(mailDomain)
			.where(eq(mailDomain.organizationId, workspaceId))
			.orderBy(asc(mailDomain.name)),
		db
			.select({
				id: mailbox.id,
				name: mailbox.name,
				everyone: mailbox.everyone,
				granted: mailboxAccess.memberId,
			})
			.from(mailbox)
			.leftJoin(
				mailboxAccess,
				and(eq(mailboxAccess.mailboxId, mailbox.id), eq(mailboxAccess.memberId, viewer.memberId)),
			)
			.where(eq(mailbox.organizationId, workspaceId))
			.orderBy(asc(mailbox.name), asc(mailbox.id)),
		db
			.select({
				id: mailAddress.id,
				localPart: mailAddress.localPart,
				domain: mailDomain.name,
				domainVerifiedAt: mailDomain.verifiedAt,
				mailboxId: mailAddress.mailboxId,
				expiresAt: mailAddress.expiresAt,
			})
			.from(mailAddress)
			.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
			.where(eq(mailDomain.organizationId, workspaceId))
			.orderBy(asc(mailDomain.name), asc(mailAddress.localPart)),
	]);
	// A grant to someone since made an owner or admin changes nothing, so it isn't shown.
	const grants = admin
		? (
				await db
					.select({
						mailboxId: mailboxAccess.mailboxId,
						memberId: mailboxAccess.memberId,
						role: member.role,
						send: mailboxAccess.send,
					})
					.from(mailboxAccess)
					.innerJoin(mailbox, eq(mailbox.id, mailboxAccess.mailboxId))
					.innerJoin(member, eq(member.id, mailboxAccess.memberId))
					.where(eq(mailbox.organizationId, workspaceId))
					.orderBy(asc(mailboxAccess.memberId))
			).filter((grant) => !isAdminRole(toRole(grant.role)))
		: [];
	const byMailbox = Map.groupBy(addresses, (address) => address.mailboxId);
	const readers = Map.groupBy(grants, (grant) => grant.mailboxId);
	const readable = mailboxes.filter((box) =>
		canReadMailbox(viewer.role, { everyone: box.everyone, granted: box.granted !== null }),
	);
	return {
		domains: domains.map((domain) => ({
			id: domain.id,
			name: domain.name,
			verifiedAt: domain.verifiedAt?.getTime() ?? null,
			proof:
				admin && !domain.verifiedAt
					? { name: proofName(domain.name), value: proofValue(domain.verificationToken) }
					: null,
			sendsWith: domain.sendsWith,
			receivesWith: domain.receivesWith,
			eventsAt: admin ? (domain.eventsAt?.getTime() ?? null) : null,
		})),
		mailboxes: readable.map((box) => ({
			id: box.id,
			name: box.name,
			addresses: (byMailbox.get(box.id) ?? []).map((address) => ({
				id: address.id,
				address: `${address.localPart}@${address.domain}`,
				expiresAt: address.expiresAt?.getTime() ?? null,
				domainProved: address.domainVerifiedAt !== null,
			})),
			access: admin ? accessOf(box.everyone, readers.get(box.id) ?? []) : null,
		})),
		resendReceiving: admin ? await receivingState(db, workspaceId) : null,
	};
}

/** A claim proves nothing, so it is open to anyone: the real owner must be able to make one. */
export async function addDomain(db: Database, workspaceId: string, input: string): Promise<Result> {
	const name = parseDomainName(input);
	if (!name) return refuse("That isn't a domain name, such as example.com.");
	const held = await db
		.select({ total: count() })
		.from(mailDomain)
		.where(eq(mailDomain.organizationId, workspaceId))
		.get();
	if ((held?.total ?? 0) >= MAX_DOMAINS_PER_WORKSPACE) {
		return refuse(`A workspace can have ${MAX_DOMAINS_PER_WORKSPACE} domains.`, 409);
	}
	try {
		await db
			.insert(mailDomain)
			.values({ id: newId(), organizationId: workspaceId, name, verificationToken: newToken() })
			.run();
	} catch (error) {
		if (isUniqueViolation(error)) return refuse("This workspace already has that domain.", 409);
		throw error;
	}
	return { ok: true };
}

function mailRoute(hosts: string[]): MailRoute {
	if (hosts.length === 0) return "none";
	if (hosts.every((host) => host.endsWith(CLOUDFLARE_MAIL_HOST))) return "cloudflare";
	if (hosts.every((host) => RESEND_MAIL_HOSTS.some((pattern) => pattern.test(host))))
		return "resend";
	return "elsewhere";
}

/** What the Domains page shows of receiving through Resend: whether it is set up, and how it went. */
export async function receivingState(
	db: Database,
	workspaceId: string,
): Promise<ResendReceiving | null> {
	const row = await db
		.select()
		.from(resendInbound)
		.where(eq(resendInbound.organizationId, workspaceId))
		.get();
	return row
		? {
				ready: row.webhookId !== null,
				receivedAt: row.receivedAt?.getTime() ?? null,
				trouble: row.trouble,
				troubleAt: row.troubleAt?.getTime() ?? null,
			}
		: null;
}

/**
 * Asks DNS about a domain and gives it to this workspace if its record is there. Whoever runs a
 * domain's DNS now decides who holds it. A record that has gone doesn't undo a proof, since people
 * remove them once they've served. But a fresh proof replaces an old one, or anyone who once had
 * access could keep a domain from its real owner for good. While the holder's record is there too,
 * it isn't clear who is meant, so nothing moves.
 */
export async function checkDomain(
	db: Database,
	workspaceId: string,
	id: string,
	lookUp: LookUpDomain,
	now: Date,
): Promise<Result<{ proved: boolean; mail: MailRoute }>> {
	const domain = await db
		.select()
		.from(mailDomain)
		.where(and(eq(mailDomain.id, id), eq(mailDomain.organizationId, workspaceId)))
		.get();
	if (!domain) return notFound();

	let records: Awaited<ReturnType<LookUpDomain>>;
	try {
		records = await lookUp(domain.name);
	} catch {
		return refuse("Couldn't ask DNS just now. Try again in a moment.", 502);
	}
	const mail = mailRoute(records.mailHosts);
	if (domain.verifiedAt) return { ok: true, proved: true, mail };
	if (!records.proof.includes(proofValue(domain.verificationToken))) {
		return { ok: true, proved: false, mail };
	}
	const holder = await db
		.select({ id: mailDomain.id, token: mailDomain.verificationToken })
		.from(mailDomain)
		.where(and(eq(mailDomain.name, domain.name), isNotNull(mailDomain.verifiedAt)))
		.get();
	if (holder && records.proof.includes(proofValue(holder.token))) {
		return refuse(
			"Another workspace's record is on this domain too. Remove it, then check again.",
			409,
		);
	}
	const prove = db.update(mailDomain).set({ verifiedAt: now }).where(eq(mailDomain.id, id));
	try {
		if (holder) {
			// One transaction, so the domain is never with both, and the unique index stays happy.
			const release = db
				.update(mailDomain)
				.set({ verifiedAt: null })
				.where(eq(mailDomain.id, holder.id));
			await db.batch([release, prove]);
		} else {
			await prove.run();
		}
	} catch (error) {
		// Someone else proved it between the look and the write.
		if (isUniqueViolation(error)) {
			return refuse("Another workspace proved this domain a moment ago. Check again.", 409);
		}
		throw error;
	}
	return { ok: true, proved: true, mail };
}

/** Its addresses go with it, and mail to them is refused from then on. */
export async function removeDomain(db: Database, workspaceId: string, id: string): Promise<Result> {
	const { meta } = await db
		.delete(mailDomain)
		.where(and(eq(mailDomain.id, id), eq(mailDomain.organizationId, workspaceId)))
		.run();
	return meta.changes ? { ok: true } : notFound();
}

/**
 * How a domain's mail is sent from now on. Resend needs the workspace's key first, so that mail
 * written next has a way to go. Mail already written keeps the way it was written with. When the
 * way changes, when events last came is forgotten, as they were the other provider's.
 */
export async function setDomainSending(
	db: Database,
	workspaceId: string,
	id: string,
	sendsWith: SendsWith,
): Promise<Result> {
	if (sendsWith === "resend") {
		const keyed = await db
			.select({ provider: providerKey.provider })
			.from(providerKey)
			.where(and(eq(providerKey.organizationId, workspaceId), eq(providerKey.provider, "resend")))
			.get();
		if (!keyed) return refuse("Add the workspace's Resend key first.", 409);
	}
	const { meta } = await db
		.update(mailDomain)
		.set({
			sendsWith,
			eventsAt: sql`CASE WHEN ${mailDomain.sendsWith} = ${sendsWith} THEN ${mailDomain.eventsAt} END`,
		})
		.where(and(eq(mailDomain.id, id), eq(mailDomain.organizationId, workspaceId)))
		.run();
	return meta.changes ? { ok: true } : notFound();
}

/** A new mailbox is for owners and admins, and for everyone only when `everyone` says so. */
export async function addMailbox(
	db: Database,
	workspaceId: string,
	input: string,
	everyone = false,
): Promise<Result> {
	const name = input.trim();
	if (!name || name.length > MAX_MAILBOX_NAME) {
		return refuse(`A mailbox's name is 1 to ${MAX_MAILBOX_NAME} characters.`);
	}
	const held = await db
		.select({ total: count() })
		.from(mailbox)
		.where(eq(mailbox.organizationId, workspaceId))
		.get();
	if ((held?.total ?? 0) >= MAX_MAILBOXES_PER_WORKSPACE) {
		return refuse(`A workspace can have ${MAX_MAILBOXES_PER_WORKSPACE} mailboxes.`, 409);
	}
	await db
		.insert(mailbox)
		.values({ id: newId(), organizationId: workspaceId, name, everyone })
		.run();
	return { ok: true };
}

export interface MailboxAccessChange {
	mailboxId: string;
	everyone: boolean;
	/** Every membership that may read it from now on, besides owners and admins. */
	memberIds: string[];
	/** Those of them that may send from it too: agents, as people who read a mailbox send anyway. */
	senderIds: string[];
}

/**
 * Says who may read a mailbox: everyone, and these memberships. Each must be in the workspace now;
 * the database holds to that too (migration 0007). The ids go in as one JSON value, since D1 binds
 * at most 100 values to a query.
 */
export async function setMailboxAccess(
	db: Database,
	workspaceId: string,
	grantedBy: string,
	change: MailboxAccessChange,
): Promise<Result> {
	const ids = [...new Set(change.memberIds)];
	if (ids.length > MAX_MAILBOX_READERS) {
		return refuse(`A mailbox can be given to ${MAX_MAILBOX_READERS} people at most.`);
	}
	const senders = [...new Set(change.senderIds)];
	if (senders.some((id) => !ids.includes(id))) {
		return refuse("Only someone given the mailbox can be let send from it.");
	}
	const box = await db
		.select({ id: mailbox.id })
		.from(mailbox)
		.where(and(eq(mailbox.id, change.mailboxId), eq(mailbox.organizationId, workspaceId)))
		.get();
	if (!box) return notFound();
	const listed = JSON.stringify(ids);
	const chosen = sql`(SELECT value FROM json_each(${listed}))`;
	const members = await db
		.select({ total: count() })
		.from(member)
		.where(and(eq(member.organizationId, workspaceId), sql`${member.id} IN ${chosen}`))
		.get();
	if ((members?.total ?? 0) !== ids.length) {
		return refuse("Someone you chose isn't in this workspace any more. Reload and try again.", 409);
	}
	await db.batch([
		db.update(mailbox).set({ everyone: change.everyone }).where(eq(mailbox.id, box.id)),
		db
			.delete(mailboxAccess)
			.where(
				and(eq(mailboxAccess.mailboxId, box.id), sql`${mailboxAccess.memberId} NOT IN ${chosen}`),
			),
		// Only those still in the workspace, and whoever had it keeps their grant as it was. The
		// select lists every column in the table's order, as Drizzle's insert-select needs.
		db
			.insert(mailboxAccess)
			.select(
				sql`SELECT ${box.id}, ${member.id}, ${grantedBy}, ${Date.now()}, 0 FROM ${member}
					WHERE ${member.organizationId} = ${workspaceId} AND ${member.id} IN ${chosen}`,
			)
			.onConflictDoNothing(),
		// Only an agent may be let send: a person who reads a mailbox sends from it anyway.
		db
			.update(mailboxAccess)
			.set({
				send: sql`${mailboxAccess.memberId} IN (SELECT value FROM json_each(${JSON.stringify(senders)}))
					AND EXISTS (SELECT 1 FROM ${member} WHERE ${member.id} = ${mailboxAccess.memberId}
						AND ${member.role} = ${AGENT_ROLE})`,
			})
			.where(eq(mailboxAccess.mailboxId, box.id)),
	]);
	return { ok: true };
}

/** Its addresses go with it, and mail to them is refused from then on. */
export async function removeMailbox(
	db: Database,
	workspaceId: string,
	id: string,
): Promise<Result> {
	const { meta } = await db
		.delete(mailbox)
		.where(and(eq(mailbox.id, id), eq(mailbox.organizationId, workspaceId)))
		.run();
	return meta.changes ? { ok: true } : notFound();
}

export interface NewAddress {
	domainId: string;
	mailboxId: string;
	localPart: string;
	/** Null is for good. */
	expiresInDays: number | null;
}

export async function addAddress(
	db: Database,
	workspaceId: string,
	createdBy: string,
	input: NewAddress,
	now: Date,
): Promise<Result> {
	const localPart = parseLocalPart(input.localPart);
	if (!localPart) {
		return refuse(
			"An address can have letters, digits, dots, hyphens and underscores, and starts and ends with a letter or digit.",
		);
	}
	const [domain, box, held] = await db.batch([
		db
			.select({ verifiedAt: mailDomain.verifiedAt })
			.from(mailDomain)
			.where(and(eq(mailDomain.id, input.domainId), eq(mailDomain.organizationId, workspaceId))),
		db
			.select({ id: mailbox.id })
			.from(mailbox)
			.where(and(eq(mailbox.id, input.mailboxId), eq(mailbox.organizationId, workspaceId))),
		db
			.select({ total: count() })
			.from(mailAddress)
			.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
			.where(eq(mailDomain.organizationId, workspaceId)),
	]);
	if (!domain[0] || !box[0]) return notFound();
	if (!domain[0].verifiedAt) return refuse("Prove that domain first.", 409);
	if ((held[0]?.total ?? 0) >= MAX_ADDRESSES_PER_WORKSPACE) {
		return refuse(`A workspace can have ${MAX_ADDRESSES_PER_WORKSPACE} addresses.`, 409);
	}
	try {
		await db
			.insert(mailAddress)
			.values({
				id: newId(),
				domainId: input.domainId,
				localPart,
				mailboxId: input.mailboxId,
				expiresAt:
					input.expiresInDays === null
						? null
						: new Date(now.getTime() + input.expiresInDays * DAY_MS),
				createdBy,
			})
			.run();
	} catch (error) {
		if (isUniqueViolation(error)) {
			return refuse(
				`That address is taken, or it ended less than ${ENDED_ADDRESS_KEPT_DAYS} days ago.`,
				409,
			);
		}
		throw error;
	}
	return { ok: true };
}

export async function removeAddress(
	db: Database,
	workspaceId: string,
	id: string,
): Promise<Result> {
	const ours = db
		.select({ id: mailDomain.id })
		.from(mailDomain)
		.where(eq(mailDomain.organizationId, workspaceId));
	const { meta } = await db
		.delete(mailAddress)
		.where(and(eq(mailAddress.id, id), inArray(mailAddress.domainId, ours)))
		.run();
	return meta.changes ? { ok: true } : notFound();
}
