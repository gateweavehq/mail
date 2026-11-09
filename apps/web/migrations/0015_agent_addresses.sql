CREATE TABLE `agent_address_policy` (
	`member_id` text PRIMARY KEY NOT NULL,
	`max_live` integer NOT NULL,
	`max_days` integer NOT NULL,
	`domains` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `mail_address` ADD `agent_member_id` text;--> statement-breakpoint
CREATE INDEX `mail_address_agent_member_id_idx` ON `mail_address` (`agent_member_id`);