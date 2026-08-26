CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`argument_hint` text,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_commands` (
	`project_id` text NOT NULL,
	`command_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `command_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `commands`(`id`) ON UPDATE no action ON DELETE cascade
);
