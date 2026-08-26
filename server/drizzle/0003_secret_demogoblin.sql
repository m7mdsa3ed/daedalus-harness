CREATE TABLE `pm_activity` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`field` text NOT NULL,
	`from` text,
	`to` text,
	FOREIGN KEY (`task_id`) REFERENCES `pm_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pm_activity_seq` ON `pm_activity` (`task_id`,`seq`);--> statement-breakpoint
CREATE TABLE `pm_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`key_prefix` text NOT NULL,
	`next_key` integer DEFAULT 1 NOT NULL,
	`default_view` text DEFAULT 'kanban' NOT NULL,
	`saved_views` text NOT NULL,
	`automations` text NOT NULL,
	`archived_at` integer,
	`deleted_at` integer,
	`template_for` text
);
--> statement-breakpoint
CREATE TABLE `pm_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`category` text NOT NULL,
	`wip_limit` integer,
	`order` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `pm_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pm_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author` text NOT NULL,
	`body_md` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `pm_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pm_custom_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`order` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `pm_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pm_issue_types` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`is_epic` integer DEFAULT false NOT NULL,
	`order` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `pm_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pm_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	FOREIGN KEY (`board_id`) REFERENCES `pm_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pm_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`date` integer,
	`reached_at` integer,
	FOREIGN KEY (`board_id`) REFERENCES `pm_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pm_sprints` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`goal` text,
	`start_date` integer,
	`end_date` integer,
	`state` text DEFAULT 'planned' NOT NULL,
	`snapshot` text,
	FOREIGN KEY (`board_id`) REFERENCES `pm_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pm_task_deps` (
	`task_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_id`),
	FOREIGN KEY (`task_id`) REFERENCES `pm_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_id`) REFERENCES `pm_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pm_task_labels` (
	`task_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `label_id`),
	FOREIGN KEY (`task_id`) REFERENCES `pm_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `pm_labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pm_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description_md` text,
	`column_id` text NOT NULL,
	`type_id` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`assignees` text NOT NULL,
	`start_date` integer,
	`due_date` integer,
	`story_points` integer,
	`estimate_minutes` integer,
	`epic_id` text,
	`parent_id` text,
	`sprint_id` text,
	`milestone_id` text,
	`recurrence` text,
	`custom_field_values` text NOT NULL,
	`checklists` text NOT NULL,
	`order` integer NOT NULL,
	`backlog_rank` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`archived_at` integer,
	`deleted_at` integer,
	`recurrence_parent_id` text,
	FOREIGN KEY (`board_id`) REFERENCES `pm_boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `pm_columns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`type_id`) REFERENCES `pm_issue_types`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`epic_id`) REFERENCES `pm_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `pm_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sprint_id`) REFERENCES `pm_sprints`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`milestone_id`) REFERENCES `pm_milestones`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pm_tasks_board_key` ON `pm_tasks` (`board_id`,`key`);--> statement-breakpoint
CREATE INDEX `pm_tasks_board_live` ON `pm_tasks` (`board_id`,`deleted_at`,`archived_at`);--> statement-breakpoint
CREATE INDEX `pm_tasks_board_column_order` ON `pm_tasks` (`board_id`,`column_id`,`order`);--> statement-breakpoint
CREATE INDEX `pm_tasks_board_sprint` ON `pm_tasks` (`board_id`,`sprint_id`);--> statement-breakpoint
CREATE INDEX `pm_tasks_board_due` ON `pm_tasks` (`board_id`,`due_date`);