CREATE TABLE `web_search_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool` text NOT NULL,
	`status` text NOT NULL,
	`thread_title` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_name` text NOT NULL,
	`project_id` text NOT NULL,
	`project_name` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_search_usage_call` ON `web_search_usage` (`session_id`,`tool_call_id`);--> statement-breakpoint
CREATE INDEX `web_search_usage_started` ON `web_search_usage` (`started_at`);