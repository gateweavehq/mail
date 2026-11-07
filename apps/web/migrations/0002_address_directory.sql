CREATE TABLE `mail_address` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`expires_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `mail_domain`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_address_domain_local_part_unique` ON `mail_address` (`domain_id`,`local_part`);--> statement-breakpoint
CREATE INDEX `mail_address_mailbox_id_idx` ON `mail_address` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `mail_address_expires_at_idx` ON `mail_address` (`expires_at`);--> statement-breakpoint
CREATE TABLE `mail_domain` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`verification_token` text NOT NULL,
	`verified_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_domain_verified_name_unique` ON `mail_domain` (`name`) WHERE verified_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_domain_organization_name_unique` ON `mail_domain` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `mailbox` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_organization_id_idx` ON `mailbox` (`organization_id`);