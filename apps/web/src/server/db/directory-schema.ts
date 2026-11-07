import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organization, user } from "./auth-schema";

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

/** Where a workspace's mail goes. Its contents live in a Durable Object, once that ships. */
export const mailbox = sqliteTable(
	"mailbox",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		createdAt: createdAt(),
	},
	(table) => [index("mailbox_organization_id_idx").on(table.organizationId)],
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
