import { and, asc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "../auth";
import { schema } from "../db";

/**
 * The addresses a mailbox may send from: its own, on a domain the workspace has proved, that
 * haven't run out. Lower case, the oldest first.
 */
export async function senderAddresses(workspaceId: string, mailboxId: string): Promise<string[]> {
	const { mailAddress, mailDomain } = schema;
	const rows = await db
		.select({ localPart: mailAddress.localPart, domain: mailDomain.name })
		.from(mailAddress)
		.innerJoin(mailDomain, eq(mailAddress.domainId, mailDomain.id))
		.where(
			and(
				eq(mailAddress.mailboxId, mailboxId),
				eq(mailDomain.organizationId, workspaceId),
				isNotNull(mailDomain.verifiedAt),
				or(isNull(mailAddress.expiresAt), gt(mailAddress.expiresAt, new Date())),
			),
		)
		.orderBy(asc(mailAddress.createdAt), asc(mailAddress.id))
		.all();
	return rows.map((row) => `${row.localPart}@${row.domain}`.toLowerCase());
}

/**
 * Which of a mailbox's addresses a reply goes from: the one the answered message came to or from,
 * so the other side sees the address they wrote to, or else the mailbox's first.
 */
export const replySender = (answered: string[], senders: string[]): string | null =>
	answered.find((address) => senders.includes(address)) ?? senders[0] ?? null;

/** The addresses a message was to and from, as its envelope has them, lower case. */
export const envelopeAddresses = (row: { envelopeTo: string; envelopeFrom: string }) =>
	[row.envelopeTo, row.envelopeFrom]
		.flatMap((value) => value.split(","))
		.map((address) => address.trim().toLowerCase())
		.filter(Boolean);
