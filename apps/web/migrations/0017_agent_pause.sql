CREATE TABLE `agent_pause` (
	`member_id` text PRIMARY KEY NOT NULL,
	`paused_by` text,
	`paused_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`paused_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
