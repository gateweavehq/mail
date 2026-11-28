ALTER TABLE `audience_removal` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `audience_removal_attempts_idx` ON `audience_removal` (`attempts`,`removed_at`);