CREATE TABLE `agent_policy` (
	`member_id` text PRIMARY KEY NOT NULL,
	`send_per_day` integer NOT NULL,
	`allowed` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `mailbox_access` ADD `send` integer DEFAULT false NOT NULL;