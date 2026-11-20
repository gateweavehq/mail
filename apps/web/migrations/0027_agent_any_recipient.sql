ALTER TABLE `agent_policy` ADD `any_recipient` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_policy` ADD `webhook_hosts_seeded` integer DEFAULT false NOT NULL;