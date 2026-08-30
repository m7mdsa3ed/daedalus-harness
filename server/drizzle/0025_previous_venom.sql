ALTER TABLE `scheduled_messages` ADD `enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_messages` ADD `skipped_at` integer;--> statement-breakpoint
ALTER TABLE `scheduled_messages` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `scheduled_messages` ADD `skip_count` integer DEFAULT 0 NOT NULL;