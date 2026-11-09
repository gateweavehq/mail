/**
 * The senders whose remote images a person lets show by themselves: by the domain a message is
 * proved to come from (`verifiedDomain`), and never by a `From` that nothing proves, which anyone
 * can write. The choice is the member's own (`image_sender`): loading images tells the sender
 * someone opened the message, and each reader of a shared mailbox decides that for themselves.
 */
import { and, count, desc, eq } from "drizzle-orm";
import type { ImageSender } from "../../lib/images";
import type { Database } from "../db";
import { schema } from "../db";

/** The most senders one person allows in one workspace. */
export const MAX_IMAGE_SENDERS = 500;

/** Whether this member lets the images of mail proved to come from `domain` show by themselves. */
export async function allowsImages(db: Database, memberId: string, domain: string) {
	const { imageSender } = schema;
	const row = await db
		.select({ domain: imageSender.domain })
		.from(imageSender)
		.where(and(eq(imageSender.memberId, memberId), eq(imageSender.domain, domain)))
		.get();
	return row !== undefined;
}

/** The senders this member allows, the newest first. */
export async function listImageSenders(db: Database, memberId: string): Promise<ImageSender[]> {
	const { imageSender } = schema;
	const rows = await db
		.select({ domain: imageSender.domain, allowedAt: imageSender.createdAt })
		.from(imageSender)
		.where(eq(imageSender.memberId, memberId))
		.orderBy(desc(imageSender.createdAt), imageSender.domain)
		.limit(MAX_IMAGE_SENDERS)
		.all();
	return rows.map((row) => ({ domain: row.domain, allowedAt: row.allowedAt.getTime() }));
}

/**
 * Lets the member's mail from a proved domain show its images. False when they allow as many as
 * they may already; allowing one they allow already changes nothing.
 */
export async function allowImageSender(
	db: Database,
	memberId: string,
	domain: string,
): Promise<boolean> {
	const { imageSender } = schema;
	if (await allowsImages(db, memberId, domain)) return true;
	const held = await db
		.select({ n: count() })
		.from(imageSender)
		.where(eq(imageSender.memberId, memberId))
		.get();
	if ((held?.n ?? 0) >= MAX_IMAGE_SENDERS) return false;
	await db.insert(imageSender).values({ memberId, domain }).onConflictDoNothing().run();
	return true;
}

/** Stops the images of the member's mail from `domain` showing by themselves. */
export async function stopImageSender(db: Database, memberId: string, domain: string) {
	const { imageSender } = schema;
	await db
		.delete(imageSender)
		.where(and(eq(imageSender.memberId, memberId), eq(imageSender.domain, domain)))
		.run();
}
