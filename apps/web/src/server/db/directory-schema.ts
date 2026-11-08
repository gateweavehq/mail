import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { member, organization, user } from "./auth-schema";

const createdAt = () =>
	integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull();

/**
 * A domain a workspace wants mail on. Adding one proves nothing, so two workspaces may both be
 * trying, and neither can keep the real owner out. Only the one that proves it gets the mail, which
 * the partial index holds to.
 */
export const mailDomain = sqliteTable(
	"mail_domain",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** Lower case, with no trailing dot. */
		name: text("name").notNull(),
		/** What the domain's TXT record has to hold to prove it. */
		verificationToken: text("verification_token").notNull(),
		verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("mail_domain_verified_name_unique")
			.on(table.name)
			.where(sql`verified_at IS NOT NULL`),
		uniqueIndex("mail_domain_organization_name_unique").on(table.organizationId, table.name),
	],
);

/** Where a workspace's mail goes. Its messages live in its own Durable Object and in R2. */
export const mailbox = sqliteTable(
	"mailbox",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/**
		 * Every person in the workspace may read it. An agent never counts as everyone: it reads a
		 * mailbox only when it is given that one.
		 */
		everyone: integer("everyone", { mode: "boolean" }).default(false).notNull(),
		createdAt: createdAt(),
	},
	(table) => [index("mailbox_organization_id_idx").on(table.organizationId)],
);

/**
 * One membership's access to read one mailbox. Owners and admins read every mailbox without one. It
 * belongs to the membership, not the person, so it ends when they leave the workspace and doesn't
 * come back if they join again. Migration 0007 keeps the two in one workspace.
 */
export const mailboxAccess = sqliteTable(
	"mailbox_access",
	{
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailbox.id, { onDelete: "cascade" }),
		memberId: text("member_id")
			.notNull()
			.references(() => member.id, { onDelete: "cascade" }),
		grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
	},
	(table) => [
		primaryKey({ columns: [table.mailboxId, table.memberId] }),
		index("mailbox_access_member_id_idx").on(table.memberId),
	],
);

/**
 * A mailbox that has gone, until its mail has gone too. A trigger writes the row as the mailbox's
 * row is deleted, however that comes about, a workspace's deletion included (migration 0005).
 * Removing a mailbox deletes its mail at once, and the daily run does it again an hour or more
 * later, for a removal that stopped part way and for a delivery that found the mailbox just before
 * it went. Then the row goes.
 */
export const mailboxRemoval = sqliteTable(
	"mailbox_removal",
	{
		mailboxId: text("mailbox_id").primaryKey(),
		// No reference, as the workspace may be gone too. Its id names where the mail is in R2.
		organizationId: text("organization_id").notNull(),
		removedAt: integer("removed_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [index("mailbox_removal_removed_at_idx").on(table.removedAt)],
);

/** One address on one domain, for one mailbox. Migration 0003 keeps all three in one workspace. */
export const mailAddress = sqliteTable(
	"mail_address",
	{
		id: text("id").primaryKey(),
		domainId: text("domain_id")
			.notNull()
			.references(() => mailDomain.id, { onDelete: "cascade" }),
		/** Lower case. */
		localPart: text("local_part").notNull(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailbox.id, { onDelete: "cascade" }),
		/** A temporary address's end. Null is for good. */
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex("mail_address_domain_local_part_unique").on(table.domainId, table.localPart),
		index("mail_address_mailbox_id_idx").on(table.mailboxId),
		index("mail_address_expires_at_idx").on(table.expiresAt),
	],
);
