/*
 * The shared backend for the harness's own `knowledge` MCP server.
 *
 * This is the *shared* half — the SQLite storage, the search and the formatting —
 * and it is deliberately free of harness internals and free of import-time side
 * effects, because it is imported by two processes with two different setups:
 *
 *   - the MCP server subprocess (`knowledge-mcp.ts`), spawned by the agent as a
 *     regular stdio server the harness declared on an `McpServerStdio` entry in
 *     `session/new`. It reads `project_id` and the DB path through
 *     `process.env`, and opens its own connection to the SAME `daedalus.db`
 *     file the harness owns, and
 *   - the harness itself (`sessions.ts`), which only needs the server name and
 *     `toKnowledgeServerEnv` to build that env at spawn.
 *
 * The subprocess must NEVER import `db/index.ts` or `config.ts`: the first runs
 * `migrate()` and the legacy-JSON import at import, and both carry harness
 * singletons. So everything this module needs comes from `better-sqlite3` and
 * `node:*`, and every query is scoped by `project_id` — a workspace's knowledge
 * never leaks into another.
 *
 * Search is substring `LIKE` (the "grep" contract the user asked for), ordered by
 * recency, bounded by a limit. There is deliberately NO vector index or FTS5 table
 * here: substring match is the simplest thing that satisfies the requirement, and
 * adding embeddings later is a new feature, not a fix for a gap.
 *
 * `knowledge` is a reserved server name — it becomes the `mcp__knowledge__` tool
 * prefix, and (like `web-search`) a user's library server that happens to share
 * the name would collide.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** The table name, exported so the harness and tests can reference it without a
    literal string in more than one place. */
export const KNOWLEDGE_TABLE = "knowledge";

/** The harness's own server name, both as the agent sees it in the
    `mcp__knowledge__<tool>` prefix and as the `McpServerStdio.name` key.
    Reserved: the same collision a user library server named `web-search` would
    be. */
export const KNOWLEDGE_SERVER_NAME = "knowledge";

/**
 * The default path to the harness database, resolved from this module's own
 * location. Under the build (`dist/knowledge-db.js`) `..` lands in `server/`,
 * and under tsx (`src/knowledge-db.ts`) it lands in the same `server/` — so both
 * agree on `server/data/daedalus.db` without importing `config.ts`.
 */
export const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "daedalus.db");

export type Db = Database.Database;

/**
 * Open a connection to the harness database. Raw better-sqlite3, not Drizzle: the
 * MCP subprocess uses the synchronous prepared-statement API and must not pull in
 * a Drizzle client. WAL + `busy_timeout` make this safe across the several
 * processes (the harness, plus one per attached knowledge server) that share one
 * file — a brief write-lock from the harness never fails a read instantly.
 */
export function openDb(dbPath: string = DB_PATH): Db {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

interface KnowledgeRow {
  id: string;
  project_id: string;
  title: string;
  content: string;
  tags: string | null;
  created_at: number;
  updated_at: number;
}

const SEARCH_LIMIT = 8;
const LIST_LIMIT = 50;
const resultLimit = (n: number | undefined, fallback: number, max: number) => {
  const v = Math.floor(n ?? fallback);
  return v > 0 && v <= max ? v : fallback;
};
const like = (q: string) => `%${q}%`;
const now = () => Date.now();

export function addKnowledge(
  db: Db,
  projectId: string,
  input: { title: string; content: string; tags?: string[] },
): { id: string } {
  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO ${KNOWLEDGE_TABLE} (id, project_id, title, content, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, input.title, input.content, JSON.stringify(input.tags ?? []), t, t);
  return { id };
}

export function searchKnowledge(db: Db, projectId: string, query: string, limit?: number): KnowledgeRow[] {
  const l = resultLimit(limit, SEARCH_LIMIT, 50);
  const pattern = like(query);
  // LIKE is case-insensitive for ASCII by default in SQLite — the "grep" match.
  return db
    .prepare(
      `SELECT * FROM ${KNOWLEDGE_TABLE}
       WHERE project_id = ? AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
       ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
    )
    .all(projectId, pattern, pattern, pattern, l) as KnowledgeRow[];
}

export function listKnowledge(db: Db, projectId: string, limit?: number): KnowledgeRow[] {
  const l = resultLimit(limit, LIST_LIMIT, 200);
  return db
    .prepare(
      `SELECT * FROM ${KNOWLEDGE_TABLE}
       WHERE project_id = ?
       ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
    )
    .all(projectId, l) as KnowledgeRow[];
}

export function deleteKnowledge(db: Db, projectId: string, id: string): boolean {
  // Scoped to project_id so an entry can never cross projects even if ids collide.
  return db
    .prepare(`DELETE FROM ${KNOWLEDGE_TABLE} WHERE id = ? AND project_id = ?`)
    .run(id, projectId).changes > 0;
}

const parseTags = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** A knowledge entry, formatted for the model — title prominent, content quoted. */
export function formatKnowledgeRows(rows: KnowledgeRow[]): string {
  if (rows.length === 0) return "No knowledge entries found.";
  return rows
    .map((r) => {
      const tags = parseTags(r.tags);
      const tagText = tags.length ? `\n   tags: ${tags.join(", ")}` : "";
      return `- [${r.id}] ${r.title}\n   ${r.content}${tagText}`;
    })
    .join("\n");
}

/** The env vars a spawned `knowledge` MCP server reads. The harness fills these
    at spawn from the project the session runs in — nothing is cached in a library
    row, so the project id is always the live one for the thread. */
export function toKnowledgeServerEnv(projectId: string): { name: string; value: string }[] {
  return [
    { name: "KNOWLEDGE_PROJECT_ID", value: projectId },
    { name: "DAEDALUS_DB_PATH", value: DB_PATH },
  ];
}
