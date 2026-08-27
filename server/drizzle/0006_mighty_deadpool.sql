CREATE TABLE `session_events` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_events_seq` ON `session_events` (`session_id`,`seq`);