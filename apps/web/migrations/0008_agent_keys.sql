CREATE TABLE `agent_key` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`start` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_key_hash_unique` ON `agent_key` (`hash`);--> statement-breakpoint
CREATE INDEX `agentKey_userId_idx` ON `agent_key` (`user_id`);--> statement-breakpoint
CREATE INDEX `agentKey_organizationId_idx` ON `agent_key` (`organization_id`);