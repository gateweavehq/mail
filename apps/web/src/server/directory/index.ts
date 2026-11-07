import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { parseDomainName, parseLocalPart, splitRecipient } from "../../lib/addresses";
import type { Directory, MailRoute } from "../../lib/directory";
import type { Database } from "../db";
import { schema } from "../db";
import { type LookUpDomain, proofName } from "./dns";

const { mailAddress, mailDomain, mailbox } = schema;

// Caps, so a stranger signing up can't fill the database. Two requests at once can pass one by a
// little, which does no harm.
export const MAX_DOMAINS_PER_WORKSPACE = 20;
export const MAX_MAILBOXES_PER_WORKSPACE = 500;
export const MAX_ADDRESSES_PER_WORKSPACE = 5_000;
export const MAX_MAILBOX_NAME = 80;

/**
 * How long a temporary address keeps its name once it ends, refusing mail all the while. Whatever
 * it signed up for may still write to it, so it shouldn't pass to someone else straight away.
 */
export const ENDED_ADDRESS_KEPT_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const VERIFICATION_PREFIX = "gateweave-mail-verification=";
const CLOUDFLARE_MAIL_HOST = ".mx.cloudflare.net";

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

/**
 * The mailbox a message to this address belongs in, or null when there is none: no such address,
 * one past its time, or a domain nobody has proved. This has to read the primary, never a replica,
 * so that an address works from the moment it is made, and `db` does.
 */
export async function findAddress(db: Database, recipient: string, now: Date) {
	const parts = splitRecipient(recipient);
	if (!parts) return null;
	const found = await db
		.select({ mailboxId: mailAddress.mailboxId, workspaceId: mailDomain.organizationId })
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

/** What a workspace has. `admin` adds what only someone who can act on it needs to see. */
export async function listDirectory(
	db: Database,
	workspaceId: string,
	{ admin }: { admin: boolean },
): Promise<Directory> {
	const [domains, mailboxes, addresses] = await db.batch([
		db
			.select()
			.from(mailDomain)
			.where(eq(mailDomain.organizationId, workspaceId))
			.orderBy(asc(mailDomain.name)),
		db
			.select({ id: mailbox.id, name: mailbox.name })
			.from(mailbox)
			.where(eq(mailbox.organizationId, workspaceId))
			.orderBy(asc(mailbox.name), asc(mailbox.id)),
		db
			.select({
				id: mailAddress.id,
				localPart: mailAddress.localPart,
				domain: mailDomain.name,
				mailboxId: mailAddress.mailboxId,
				expiresAt: mailAddress.expiresAt,
			})
			.from(mailAddress)
			.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
			.where(eq(mailDomain.organizationId, workspaceId))
			.orderBy(asc(mailDomain.name), asc(mailAddress.localPart)),
	]);
	return {
		domains: domains.map((domain) => ({
			id: domain.id,
			name: domain.name,
			verifiedAt: domain.verifiedAt?.getTime() ?? null,
			proof:
				admin && !domain.verifiedAt
					? {
							name: proofName(domain.name),
							value: `${VERIFICATION_PREFIX}${domain.verificationToken}`,
						}
					: null,
		})),
		mailboxes: mailboxes.map((box) => ({
			...box,
			addresses: addresses
				.filter((address) => address.mailboxId === box.id)
				.map((address) => ({
					id: address.id,
					address: `${address.localPart}@${address.domain}`,
					expiresAt: address.expiresAt?.getTime() ?? null,
				})),
		})),
	};
}

const PROVED_ELSEWHERE = "Another workspace on this server has proved this domain.";

export async function addDomain(db: Database, workspaceId: string, input: string): Promise<Result> {
	const name = parseDomainName(input);
	if (!name) return refuse("That isn't a domain name, such as example.com.");
	const proved = await db
		.select({ workspaceId: mailDomain.organizationId })
		.from(mailDomain)
		.where(and(eq(mailDomain.name, name), isNotNull(mailDomain.verifiedAt)))
		.get();
	if (proved && proved.workspaceId !== workspaceId) return refuse(PROVED_ELSEWHERE, 409);
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
	return hosts.every((host) => host.endsWith(CLOUDFLARE_MAIL_HOST)) ? "cloudflare" : "elsewhere";
}

/**
 * Asks DNS about a domain and records the proof if it is there. Proof that later goes away doesn't
 * undo it, since people remove such records once they've served, so a domain stays with whoever
 * proved it until they remove it.
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
	if (!records.proof.includes(`${VERIFICATION_PREFIX}${domain.verificationToken}`)) {
		return { ok: true, proved: false, mail };
	}
	try {
		await db.update(mailDomain).set({ verifiedAt: now }).where(eq(mailDomain.id, id)).run();
	} catch (error) {
		if (isUniqueViolation(error)) return refuse(PROVED_ELSEWHERE, 409);
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

export async function addMailbox(
	db: Database,
	workspaceId: string,
	input: string,
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
	await db.insert(mailbox).values({ id: newId(), organizationId: workspaceId, name }).run();
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
		return refuse("An address can have letters, digits, dots, hyphens and underscores.");
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
