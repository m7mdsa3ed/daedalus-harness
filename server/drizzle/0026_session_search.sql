-- Custom migration (drizzle-kit cannot model virtual tables — the same reason
-- 0019 was hand-written).
--
-- Full-text search over the *prose* of the journal: what the user typed, what
-- the agent said and thought, and tool titles — extracted from the payload by
-- src/search.ts, never the raw JSON. A plain (content-storing) FTS5 table
-- rather than contentless/external-content: deletes have to work per session
-- (a revive clears and refills the log), and external content would point at
-- rows whose text column does not exist. The duplication is bounded — only the
-- extracted prose is stored, not payloads.
CREATE VIRTUAL TABLE `session_events_fts` USING fts5(
	`text`,
	`session_id` UNINDEXED,
	`seq` UNINDEXED,
	`at` UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- One-row bookkeeping for the boot-time backfill of the table above (and any
-- future search-index migration). Not in schema.ts on purpose: drizzle-kit
-- would try to create it a second time in a generated migration.
CREATE TABLE `search_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
