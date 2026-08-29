CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`board` text DEFAULT 'default' NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`assignee` text,
	`due_at` integer,
	`note` text,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_board_order` ON `tasks` (`board`,`status`,`order`);