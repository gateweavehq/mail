CREATE TABLE `agent_mailbox` (
	`member_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	PRIMARY KEY(`member_id`, `mailbox_id`),
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
