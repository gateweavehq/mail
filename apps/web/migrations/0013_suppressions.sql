CREATE TABLE `mail_suppression` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`address` text NOT NULL,
	`reason` text NOT NULL,
	`provider` text NOT NULL,
	`detail` text,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_suppression_organization_address_unique` ON `mail_suppression` (`organization_id`,`address`);--> statement-breakpoint
CREATE INDEX `mail_suppression_organization_last_at_idx` ON `mail_suppression` (`organization_id`,`last_at`);--> statement-breakpoint
CREATE INDEX `mail_suppression_expires_at_idx` ON `mail_suppression` (`expires_at`);