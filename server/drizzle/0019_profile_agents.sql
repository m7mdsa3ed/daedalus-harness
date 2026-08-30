-- A profile used to bind to exactly one agent (`agent_id`). It now names the
-- set of agents it can spawn as a JSON map, `agents`, keyed by agent id — one
-- provider (credentials + catalog) serves several runtimes, and the old shape
-- forced the same key and model list to be entered once per agent. Existing
-- rows keep their one agent with no per-agent overrides.
ALTER TABLE `profiles` ADD `agents` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE `profiles` SET `agents` = json_object(`agent_id`, json_object()) WHERE `agent_id` IS NOT NULL AND `agent_id` <> '';--> statement-breakpoint
ALTER TABLE `profiles` DROP COLUMN `agent_id`;
