ALTER TABLE `mail_domain` ADD `send_attempt_state` text;--> statement-breakpoint
ALTER TABLE `mail_domain` ADD `send_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `mail_domain` ADD `send_attempt_error` text;