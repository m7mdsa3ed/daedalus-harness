-- The web-search and knowledge opt-ins leave the profile and become library
-- rows (`mcp_servers.type = 'builtin'`), linked like any other server. Every
-- profile that had a toggle on is linked to the injected row, so nothing that
-- searched yesterday stops searching today. The fixed ids are what make the
-- "inject" action idempotent (library.ts BUILTIN_MCP).
ALTER TABLE `mcp_servers` ADD `builtin` text;--> statement-breakpoint
INSERT INTO `mcp_servers` (`id`, `type`, `name`, `builtin`)
  SELECT 'builtin:web-search', 'builtin', 'web-search', 'web-search'
  WHERE EXISTS (SELECT 1 FROM `profiles` WHERE json_extract(`web_search`, '$.enabled') = 1)
    AND NOT EXISTS (SELECT 1 FROM `mcp_servers` WHERE `id` = 'builtin:web-search');--> statement-breakpoint
INSERT INTO `mcp_servers` (`id`, `type`, `name`, `builtin`)
  SELECT 'builtin:knowledge', 'builtin', 'knowledge', 'knowledge'
  WHERE EXISTS (SELECT 1 FROM `profiles` WHERE json_extract(`knowledge`, '$.enabled') = 1)
    AND NOT EXISTS (SELECT 1 FROM `mcp_servers` WHERE `id` = 'builtin:knowledge');--> statement-breakpoint
INSERT OR IGNORE INTO `profile_mcp_servers` (`profile_id`, `mcp_server_id`)
  SELECT `id`, 'builtin:web-search' FROM `profiles` WHERE json_extract(`web_search`, '$.enabled') = 1;--> statement-breakpoint
INSERT OR IGNORE INTO `profile_mcp_servers` (`profile_id`, `mcp_server_id`)
  SELECT `id`, 'builtin:knowledge' FROM `profiles` WHERE json_extract(`knowledge`, '$.enabled') = 1;--> statement-breakpoint
ALTER TABLE `profiles` DROP COLUMN `web_search`;--> statement-breakpoint
ALTER TABLE `profiles` DROP COLUMN `knowledge`;
