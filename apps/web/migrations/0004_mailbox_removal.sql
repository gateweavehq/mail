CREATE TABLE `mailbox_removal` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`removed_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_removal_removed_at_idx` ON `mailbox_removal` (`removed_at`);