CREATE TABLE `mailbox_access` (
	`mailbox_id` text NOT NULL,
	`member_id` text NOT NULL,
	`granted_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`mailbox_id`, `member_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mailbox_access_member_id_idx` ON `mailbox_access` (`member_id`);--> statement-breakpoint
ALTER TABLE `mailbox` ADD `everyone` integer DEFAULT false NOT NULL;