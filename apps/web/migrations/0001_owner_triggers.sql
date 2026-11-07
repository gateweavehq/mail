-- Custom SQL migration: what holds however a row comes to change.
--
-- The plugin counts a workspace's owners and then acts, in separate queries, and so does deleting an
-- account, so two owners leaving at the same moment could each see the other still there. A workspace
-- with no owner has nobody who can fix it, so the database refuses the change that would make one. A
-- workspace being deleted has gone by the time its members follow, and they are free to go.
--
-- Better Auth keeps several roles as a list, such as `owner,admin`, and that is an owner too, so the
-- word is looked for as a whole item of the list.
CREATE TRIGGER `member_delete_keeps_an_owner`
BEFORE DELETE ON `member`
WHEN instr(',' || old.`role` || ',', ',owner,') > 0
	AND EXISTS (SELECT 1 FROM `organization` WHERE `id` = old.`organization_id`)
	AND (SELECT count(*) FROM `member` WHERE `organization_id` = old.`organization_id` AND instr(',' || `role` || ',', ',owner,') > 0) <= 1
BEGIN
	SELECT RAISE(ABORT, 'a workspace must keep an owner');
END;--> statement-breakpoint
CREATE TRIGGER `member_update_keeps_an_owner`
BEFORE UPDATE OF `role` ON `member`
WHEN instr(',' || old.`role` || ',', ',owner,') > 0
	AND instr(',' || new.`role` || ',', ',owner,') = 0
	AND (SELECT count(*) FROM `member` WHERE `organization_id` = old.`organization_id` AND instr(',' || `role` || ',', ',owner,') > 0) <= 1
BEGIN
	SELECT RAISE(ABORT, 'a workspace must keep an owner');
END;
