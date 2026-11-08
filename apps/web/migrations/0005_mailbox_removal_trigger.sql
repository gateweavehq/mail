-- Custom SQL migration: a record of every mailbox that goes, written as its row is deleted.
--
-- A mailbox's mail is in R2 and its index in a Durable Object, and both have to follow it. The
-- Worker removes them at once, but it can stop part way, and a delivery that found the mailbox
-- just before it went can still land. So each removal leaves a row, which the daily run finishes
-- (`finishRemovals`). A workspace's mailboxes go by cascade, and a cascade fires this trigger too.
CREATE TRIGGER `mailbox_delete_records_removal`
AFTER DELETE ON `mailbox`
BEGIN
	INSERT OR IGNORE INTO `mailbox_removal` (`mailbox_id`, `organization_id`)
	VALUES (old.`id`, old.`organization_id`);
END;
