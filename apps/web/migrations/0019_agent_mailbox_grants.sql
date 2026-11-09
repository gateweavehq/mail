-- Custom SQL migration: `agent_mailbox` remembers each mailbox an agent is given, however the
-- grant comes about, and keeps it after the grant goes, as what the agent wrote stays there.
CREATE TRIGGER `mailbox_access_insert_remembers_agent`
AFTER INSERT ON `mailbox_access`
WHEN EXISTS (SELECT 1 FROM `member` WHERE `id` = new.`member_id` AND `role` = 'agent')
BEGIN
	INSERT OR IGNORE INTO `agent_mailbox` (`member_id`, `mailbox_id`)
	VALUES (new.`member_id`, new.`mailbox_id`);
END;--> statement-breakpoint
CREATE TRIGGER `mailbox_access_update_remembers_agent`
AFTER UPDATE OF `member_id`, `mailbox_id` ON `mailbox_access`
WHEN EXISTS (SELECT 1 FROM `member` WHERE `id` = new.`member_id` AND `role` = 'agent')
BEGIN
	INSERT OR IGNORE INTO `agent_mailbox` (`member_id`, `mailbox_id`)
	VALUES (new.`member_id`, new.`mailbox_id`);
END;--> statement-breakpoint
-- The grants agents have now, and the mailboxes of the addresses they made. A grant taken away
-- before this migration is not known.
INSERT OR IGNORE INTO `agent_mailbox` (`member_id`, `mailbox_id`)
SELECT `mailbox_access`.`member_id`, `mailbox_access`.`mailbox_id`
FROM `mailbox_access` JOIN `member` ON `member`.`id` = `mailbox_access`.`member_id`
WHERE `member`.`role` = 'agent';--> statement-breakpoint
INSERT OR IGNORE INTO `agent_mailbox` (`member_id`, `mailbox_id`)
SELECT `agent_member_id`, `mailbox_id` FROM `mail_address` WHERE `agent_member_id` IS NOT NULL;
