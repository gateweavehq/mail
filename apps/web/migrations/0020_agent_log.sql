CREATE TABLE `agent_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`agent_member_id` text NOT NULL,
	`by_agent` integer NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`mailbox_id` text,
	`target_id` text,
	`thread_id` text,
	`subject` text,
	`detail` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_log_agent_idx` ON `agent_log` (`agent_member_id`,`at`,`id`);--> statement-breakpoint
CREATE INDEX `agent_log_at_idx` ON `agent_log` (`at`);