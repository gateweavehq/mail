CREATE TABLE `provider_key` (
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`sealed` text NOT NULL,
	`hint` text NOT NULL,
	`added_by` text,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `provider`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `mail_domain` ADD `sends_with` text DEFAULT 'cloudflare' NOT NULL;