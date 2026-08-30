CREATE TABLE `history_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`source_checkpoint_id` text NOT NULL,
	`acp_session_id` text NOT NULL,
	`workspace_snapshot_id` text NOT NULL,
	`label` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`recovered_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `history_branches_session` ON `history_branches` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `history_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`session_id` text NOT NULL,
	`prompt_text` text NOT NULL,
	`parent_acp_session_id` text NOT NULL,
	`child_acp_session_id` text NOT NULL,
	`pre_snapshot_id` text NOT NULL,
	`post_manifest` text,
	`parent_checkpoint_id` text,
	`branch_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_checkpoints_turn_id_unique` ON `history_checkpoints` (`turn_id`);--> statement-breakpoint
CREATE INDEX `history_checkpoints_session` ON `history_checkpoints` (`session_id`,`created_at`);