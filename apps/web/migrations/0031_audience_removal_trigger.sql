-- Custom SQL migration: a record of every workspace that goes, written as its row is deleted.
--
-- A workspace's audience object keeps its templates outside D1. The Worker empties it at once,
-- but that call can fail or stop part way. So the deletion leaves a row, which the daily run
-- finishes (`finishAudienceRemovals`).
CREATE TRIGGER `organization_delete_records_audience_removal`
AFTER DELETE ON `organization`
BEGIN
	INSERT OR IGNORE INTO `audience_removal` (`organization_id`)
	VALUES (old.`id`);
END;
