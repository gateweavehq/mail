-- Custom SQL migration: what holds however a row comes to change.
--
-- An address joins a domain to a mailbox, and each of those belongs to a workspace. If they were
-- different workspaces, mail for one workspace's domain would land in another's mailbox. The code
-- checks this, and the database refuses it too, since a mistake here would hand someone's mail to a
-- stranger without anyone noticing.
CREATE TRIGGER `mail_address_insert_same_workspace`
BEFORE INSERT ON `mail_address`
WHEN (SELECT `organization_id` FROM `mail_domain` WHERE `id` = new.`domain_id`)
	IS NOT (SELECT `organization_id` FROM `mailbox` WHERE `id` = new.`mailbox_id`)
BEGIN
	SELECT RAISE(ABORT, 'an address and its mailbox must be in one workspace');
END;--> statement-breakpoint
CREATE TRIGGER `mail_address_update_same_workspace`
BEFORE UPDATE OF `domain_id`, `mailbox_id` ON `mail_address`
WHEN (SELECT `organization_id` FROM `mail_domain` WHERE `id` = new.`domain_id`)
	IS NOT (SELECT `organization_id` FROM `mailbox` WHERE `id` = new.`mailbox_id`)
BEGIN
	SELECT RAISE(ABORT, 'an address and its mailbox must be in one workspace');
END;
