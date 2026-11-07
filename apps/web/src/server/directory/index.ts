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
				domainVerifiedAt: mailDomain.verifiedAt,
				mailboxId: mailAddress.mailboxId,
				expiresAt: mailAddress.expiresAt,
			})
			.from(mailAddress)
			.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
			.where(eq(mailDomain.organizationId, workspaceId))
			.orderBy(asc(mailDomain.name), asc(mailAddress.localPart)),
	]);
	const byMailbox = Map.groupBy(addresses, (address) => address.mailboxId);
	return {
		domains: domains.map((domain) => ({
			id: domain.id,
			name: domain.name,
			verifiedAt: domain.verifiedAt?.getTime() ?? null,
			proof:
				admin && !domain.verifiedAt
					? { name: proofName(domain.name), value: proofValue(domain.verificationToken) }
					: null,
		})),
		mailboxes: mailboxes.map((box) => ({
			...box,
			addresses: (byMailbox.get(box.id) ?? []).map((address) => ({
				id: address.id,
				address: `${address.localPart}@${address.domain}`,
				expiresAt: address.expiresAt?.getTime() ?? null,
				domainProved: address.domainVerifiedAt !== null,
			})),
		})),
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
	return hosts.every((host) => host.endsWith(CLOUDFLARE_MAIL_HOST)) ? "cloudflare" : "elsewhere";
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
