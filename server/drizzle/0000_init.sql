CREATE TABLE `agent_options` (
	`key` text PRIMARY KEY NOT NULL,
	`options` text NOT NULL,
	`probed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`args` text NOT NULL,
	`env` text NOT NULL,
	`spawn_categories` text,
	`seeded_version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`dir` text NOT NULL,
	`line` text NOT NULL,
	`req_id` text,
	`res` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_seq` ON `journal` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`headers` text,
	`command` text,
	`args` text,
	`env` text
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`agent_id` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text NOT NULL,
	`default_model` text NOT NULL,
	`models` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_mcp_servers` (
	`project_id` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `mcp_server_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_skills` (
	`project_id` text NOT NULL,
	`skill_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `skill_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cwd` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`project_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`title` text NOT NULL,
	`acp_session_id` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `sessions_live` ON `sessions` (`deleted_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL
);
