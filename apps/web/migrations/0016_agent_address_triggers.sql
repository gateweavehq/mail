-- Custom SQL migration: what holds for the addresses an agent makes, however a row comes to change.
--
-- `mail_address.agent_member_id` names the agent that made an address. Drizzle Kit's ADD COLUMN
-- drops a reference's ON DELETE, so these triggers stand in for one.
--
-- The agent must be an agent of the workspace whose mailbox the address points at. Were it another
-- workspace's, that workspace's agent would count, see and end this one's addresses.
CREATE TRIGGER `mail_address_insert_agent_same_workspace`
BEFORE INSERT ON `mail_address`
WHEN new.`agent_member_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `member`
	WHERE `id` = new.`agent_member_id` AND `role` = 'agent'
		AND `organization_id` = (SELECT `organization_id` FROM `mailbox` WHERE `id` = new.`mailbox_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'an address an agent made and its mailbox must be in the agent''s workspace');
END;--> statement-breakpoint
CREATE TRIGGER `mail_address_update_agent_same_workspace`
BEFORE UPDATE OF `agent_member_id`, `mailbox_id` ON `mail_address`
WHEN new.`agent_member_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `member`
	WHERE `id` = new.`agent_member_id` AND `role` = 'agent'
		AND `organization_id` = (SELECT `organization_id` FROM `mailbox` WHERE `id` = new.`mailbox_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'an address an agent made and its mailbox must be in the agent''s workspace');
END;--> statement-breakpoint
-- When an agent goes, however that comes about, the addresses it made end now. Nobody asked for
-- what still comes to them, and the agent may have gone because its key leaked. They keep their
-- names for a while, refusing mail, as any address that ends does, and no longer name the agent.
CREATE TRIGGER `member_delete_ends_agent_addresses`
BEFORE DELETE ON `member`
BEGIN
	UPDATE `mail_address`
	SET
		`expires_at` = min(
			coalesce(`expires_at`, cast(unixepoch('subsecond') * 1000 as integer)),
			cast(unixepoch('subsecond') * 1000 as integer)
		),
		`agent_member_id` = NULL
	WHERE `agent_member_id` = old.`id`;
END;--> statement-breakpoint
-- So do those it made in a mailbox it may no longer send from, as it couldn't make them there now.
-- It can't see or end them there either, and they would count against it until they ended.
CREATE TRIGGER `mailbox_access_delete_ends_agent_addresses`
AFTER DELETE ON `mailbox_access`
BEGIN
	UPDATE `mail_address`
	SET `expires_at` = cast(unixepoch('subsecond') * 1000 as integer)
	WHERE `agent_member_id` = old.`member_id` AND `mailbox_id` = old.`mailbox_id`
		AND (`expires_at` IS NULL OR `expires_at` > cast(unixepoch('subsecond') * 1000 as integer));
END;--> statement-breakpoint
CREATE TRIGGER `mailbox_access_send_off_ends_agent_addresses`
AFTER UPDATE OF `send` ON `mailbox_access`
WHEN old.`send` = 1 AND new.`send` = 0
BEGIN
	UPDATE `mail_address`
	SET `expires_at` = cast(unixepoch('subsecond') * 1000 as integer)
	WHERE `agent_member_id` = old.`member_id` AND `mailbox_id` = old.`mailbox_id`
		AND (`expires_at` IS NULL OR `expires_at` > cast(unixepoch('subsecond') * 1000 as integer));
END;--> statement-breakpoint
-- A name taken from an address that still took mail, or stopped less than 30 days ago
-- (ENDED_ADDRESS_KEPT_DAYS), however the row goes: by hand, or with its mailbox, domain or
-- workspace. People may take it again at once; an agent waits until 30 days after the address
-- stopped taking mail, as for one that ended. The daily run's own deletes are older than that.
CREATE TRIGGER `mail_address_delete_keeps_name_from_agents`
AFTER DELETE ON `mail_address`
WHEN old.`expires_at` IS NULL
	OR old.`expires_at` > cast(unixepoch('subsecond') * 1000 as integer) - 30 * 86400000
BEGIN
	INSERT INTO `removed_address` (`domain_id`, `local_part`, `removed_at`)
	VALUES (
		old.`domain_id`,
		old.`local_part`,
		min(
			coalesce(old.`expires_at`, cast(unixepoch('subsecond') * 1000 as integer)),
			cast(unixepoch('subsecond') * 1000 as integer)
		)
	)
	ON CONFLICT (`domain_id`, `local_part`) DO UPDATE SET
		`removed_at` = max(`removed_at`, excluded.`removed_at`);
END;
