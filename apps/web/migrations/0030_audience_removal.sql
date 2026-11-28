CREATE TABLE `audience_removal` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`removed_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audience_removal_removed_at_idx` ON `audience_removal` (`removed_at`);--> statement-breakpoint
CREATE INDEX `audience_removal_attempts_idx` ON `audience_removal` (`attempts`,`removed_at`);