import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { KEYED_PROVIDERS, RECEIVES_WITH, SENDS_WITH } from "../../lib/providers";
import { SUPPRESSION_REASONS } from "../../lib/suppressions";
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
		/**
		 * How its mail is sent: `cloudflare`, through Email Service's binding, or `resend`, with the
		 * workspace's key in `provider_key`.
		 */
		sendsWith: text("sends_with", { enum: SENDS_WITH }).default("cloudflare").notNull(),
		/**
		 * How its mail arrives: `cloudflare`, through Email Routing to `email()`, or `resend`, through
		 * the workspace's webhook in `resend_inbound`, which takes mail only for domains set to it.
		 */
		receivesWith: text("receives_with", { enum: RECEIVES_WITH }).default("cloudflare").notNull(),
		/**
		 * When delivery events last came from the provider it sends with: Email Service's through the
		 * deployment's queue, whoever sent the mail, or Resend's through the workspace's webhook. Null
		 * until the first, as while its event subscription is missing, and again when it changes how it
		 * sends.
		 */
		eventsAt: integer("events_at", { mode: "timestamp_ms" }),
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
		/**
		 * Whether an agent given the mailbox may also send from it. A person who reads a mailbox may
		 * send from it anyway, so it means nothing for people.
		 */
		send: integer("send", { mode: "boolean" }).default(false).notNull(),
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
		/**
		 * The agent that made it for itself, by membership, within `agent_address_policy`. Triggers
		 * stand in for a reference (migration 0016), as Drizzle Kit's `ADD COLUMN` drops `ON DELETE`:
		 * the membership must be in the mailbox's workspace, and when it goes, the address ends and
		 * this becomes null.
		 */
		agentMemberId: text("agent_member_id"),
	},
	(table) => [
		uniqueIndex("mail_address_domain_local_part_unique").on(table.domainId, table.localPart),
		index("mail_address_mailbox_id_idx").on(table.mailboxId),
		index("mail_address_expires_at_idx").on(table.expiresAt),
		index("mail_address_agent_member_id_idx").on(table.agentMemberId),
	],
);

/**
 * A name that was taken from a live address, by hand or with its mailbox, domain or workspace: a
 * trigger writes it as the row goes (migration 0016). People may take the name again at once, as a
 * person chose to let it go, but an agent may not until it has been kept as long as an ended
 * address is. Whatever wrote to the old address may still, and an agent mustn't be the one to
 * catch it. No reference, as the domain may be gone too; the daily run deletes it.
 */
export const removedAddress = sqliteTable(
	"removed_address",
	{
		domainId: text("domain_id").notNull(),
		/** Lower case. */
		localPart: text("local_part").notNull(),
		removedAt: integer("removed_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.domainId, table.localPart] }),
		index("removed_address_removed_at_idx").on(table.removedAt),
	],
);

/**
 * What an agent may send, set by owners and admins. An agent without a row has the defaults in
 * `lib/agent-policy.ts`. It belongs to the membership, so it goes with the agent.
 */
export const agentPolicy = sqliteTable("agent_policy", {
	memberId: text("member_id")
		.primaryKey()
		.references(() => member.id, { onDelete: "cascade" }),
	/** Messages it may write a day, held or not. Zero stops it sending. */
	sendPerDay: integer("send_per_day").notNull(),
	/** Addresses and whole domains (`@example.com`) its mail goes to without a person, as JSON. */
	allowed: text("allowed").notNull(),
	updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * What addresses an agent may make for itself, set by owners and admins. An agent without a row
 * makes none (`lib/agent-addresses.ts`). It belongs to the membership, so it goes with the agent.
 */
export const agentAddressPolicy = sqliteTable("agent_address_policy", {
	memberId: text("member_id")
		.primaryKey()
		.references(() => member.id, { onDelete: "cascade" }),
	/** Live addresses it may hold at once, and make in a day. Zero stops it making any. */
	maxLive: integer("max_live").notNull(),
	/** The longest one of them may last, in days. */
	maxDays: integer("max_days").notNull(),
	/** The domains it may make them on, by name, as JSON. */
	domains: text("domains").notNull(),
	updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * An agent an owner or admin paused. While its row is here, its keys do nothing
 * (`findAgentByKey`), what it wrote that waits to be tried again goes to a person instead, and its
 * own webhooks hear nothing. Resuming it deletes the row. It belongs to the membership, so it goes
 * with the agent.
 */
export const agentPause = sqliteTable("agent_pause", {
	memberId: text("member_id")
		.primaryKey()
		.references(() => member.id, { onDelete: "cascade" }),
	pausedBy: text("paused_by").references(() => user.id, { onDelete: "set null" }),
	pausedAt: integer("paused_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Every mailbox an agent was ever given, kept after its grant goes, as what it wrote stays there:
 * its page asks only these. A trigger adds the row as a grant is made, however that comes about
 * (migration 0019). It goes with the agent, or the mailbox.
 */
export const agentMailbox = sqliteTable(
	"agent_mailbox",
	{
		memberId: text("member_id")
			.notNull()
			.references(() => member.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailbox.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.memberId, table.mailboxId] })],
);

/**
 * A workspace's key for a mail provider, sealed with the deployment's `SECRETS_KEY` and the
 * workspace's id (`server/secrets.ts`). It is never sent to a browser: pages see its last four
 * characters. It goes with the workspace.
 */
export const providerKey = sqliteTable(
	"provider_key",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		provider: text("provider", { enum: KEYED_PROVIDERS }).notNull(),
		sealed: text("sealed").notNull(),
		/** The key's last four characters. */
		hint: text("hint").notNull(),
		addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
		addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.organizationId, table.provider] })],
);

/**
 * A workspace's webhook in its Resend account, which tells Mail of mail Resend received for it. It
 * is there while any of the workspace's domains receives with Resend. The channel is in the
 * webhook's address and finds the row; the signing secret, sealed like the key, proves a delivery
 * came from Resend. It goes with the workspace.
 */
export const resendInbound = sqliteTable("resend_inbound", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	/** Random, so the webhook's address says nothing and can't be guessed. */
	channel: text("channel").notNull().unique(),
	/** Resend's id for the webhook, once it is made. */
	webhookId: text("webhook_id"),
	/** Its signing secret, sealed, once it is made. */
	sealedSecret: text("sealed_secret"),
	createdAt: createdAt(),
	/** When Mail last stored mail that came through it. */
	receivedAt: integer("received_at", { mode: "timestamp_ms" }),
	/** What went wrong last, as a code `receivingTrouble` puts in words, until mail is stored again. */
	trouble: text("trouble"),
	troubleAt: integer("trouble_at", { mode: "timestamp_ms" }),
	/**
	 * Since when none of the workspace's domains sends or receives with Resend. The webhook stays a
	 * while for what Resend still tells of mail sent before, then the daily run removes it.
	 */
	unusedSince: integer("unused_since", { mode: "timestamp_ms" }),
});

/**
 * An address a workspace's mail won't go to, from a provider's delivery events: one per address, so
 * every mailbox of the workspace stops writing to it. Another workspace's events never reach it.
 * It goes with the workspace, and the daily run deletes it once it has ended.
 */
export const mailSuppression = sqliteTable(
	"mail_suppression",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** Lower case. */
		address: text("address").notNull(),
		reason: text("reason", { enum: SUPPRESSION_REASONS }).notNull(),
		/** Whose event said so. */
		provider: text("provider", { enum: SENDS_WITH }).notNull(),
		/** What the receiving server or the provider said, cut short. */
		detail: text("detail"),
		firstAt: integer("first_at", { mode: "timestamp_ms" }).notNull(),
		lastAt: integer("last_at", { mode: "timestamp_ms" }).notNull(),
		/** Null for one that lasts until someone removes it. */
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		/**
		 * When someone removed it. The row stays a while, so that an event from before then, which a
		 * queue may hand over again, doesn't put it back.
		 */
		removedAt: integer("removed_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("mail_suppression_organization_address_unique").on(
			table.organizationId,
			table.address,
		),
		index("mail_suppression_organization_last_at_idx").on(table.organizationId, table.lastAt),
		index("mail_suppression_expires_at_idx").on(table.expiresAt),
		index("mail_suppression_removed_at_idx").on(table.removedAt),
	],
);
