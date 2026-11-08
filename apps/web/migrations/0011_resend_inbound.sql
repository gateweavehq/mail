CREATE TABLE `resend_inbound` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`webhook_id` text,
	`sealed_secret` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`received_at` integer,
	`trouble` text,
	`trouble_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resend_inbound_channel_unique` ON `resend_inbound` (`channel`);--> statement-breakpoint
ALTER TABLE `mail_domain` ADD `receives_with` text DEFAULT 'cloudflare' NOT NULL;