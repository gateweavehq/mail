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
END;
