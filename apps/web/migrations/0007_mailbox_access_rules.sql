-- Custom SQL migration: who may read the mailboxes there are already, and what holds however a
-- grant comes to change.
--
-- Until now every member of a workspace could read all of its mailboxes. Those mailboxes stay open
-- to everyone, so nobody loses what they could read; a new one starts with owners and admins only.
UPDATE `mailbox` SET `everyone` = 1;--> statement-breakpoint
-- A grant joins a membership to a mailbox. If they were in different workspaces, someone could read
-- another workspace's mail. The code checks this, and the database refuses it too.
CREATE TRIGGER `mailbox_access_insert_same_workspace`
BEFORE INSERT ON `mailbox_access`
WHEN (SELECT `organization_id` FROM `member` WHERE `id` = new.`member_id`)
	IS NOT (SELECT `organization_id` FROM `mailbox` WHERE `id` = new.`mailbox_id`)
BEGIN
	SELECT RAISE(ABORT, 'a mailbox and the member given it must be in one workspace');
END;--> statement-breakpoint
CREATE TRIGGER `mailbox_access_update_same_workspace`
BEFORE UPDATE OF `mailbox_id`, `member_id` ON `mailbox_access`
WHEN (SELECT `organization_id` FROM `member` WHERE `id` = new.`member_id`)
	IS NOT (SELECT `organization_id` FROM `mailbox` WHERE `id` = new.`mailbox_id`)
BEGIN
	SELECT RAISE(ABORT, 'a mailbox and the member given it must be in one workspace');
END;
