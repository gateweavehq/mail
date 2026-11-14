CREATE TABLE `webhooks_sealed` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`sealed_under` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
