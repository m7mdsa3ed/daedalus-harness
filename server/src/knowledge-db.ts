/*
 * The shared backend for the harness's own `knowledge` MCP server.
 *
 * This is the *shared* half — the storage, the search and the formatting —
 * and it is deliberately free of harness internals and free of import-time side
 * effects, because it is imported by two processes with two different setups:
 *
 *   - the MCP server subprocess (`knowledge-mcp.ts`), spawned by the agent as a
 *     regular stdio server the harness declared on an `McpServerStdio` entry in
 *     `session/new`. It reads `project_id` and the connection string through
 *     `process.env`, and opens its own connection to the SAME database the
 *     harness owns, and
 *   - the harness itself (`sessions.ts`), which only needs the server name and
 *     `toKnowledgeServerEnv` to build that env at spawn.
 *
 * The subprocess must NEVER import `db/index.ts` or `config.ts`: the first
 * pushes the schema and runs the legacy imports at import time, and both carry
 * harness singletons. So everything this module needs comes from `pg` and
 * `node:*`, and every query is scoped by `project_id` — a workspace's knowledge
 * never leaks into another.
 *
 * Search is substring `ILIKE` (the "grep" contract the user asked for), ordered
 * by recency, bounded by a limit. There is deliberately NO vector index and no
 * use of the journal's tsvector index here: substring match is the simplest
 * thing that satisfies the requirement, and adding embeddings later is a new
 * feature, not a fix for a gap.
 *
 * `knowledge` is a reserved server name — it becomes the `mcp__knowledge__` tool
 * prefix, and (like `web-search`) a user's library server that happens to share
 * the name would collide.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";

/** The table name, exported so the harness and tests can reference it without a
    literal string in more than one place. */
export const KNOWLEDGE_TABLE = "knowledge";

/** The harness's own server name, both as the agent sees it in the
    `mcp__knowledge__<tool>` prefix and as the `McpServerStdio.name` key.
    Reserved: the same collision a user library server named `web-search` would
    be. */
export const KNOWLEDGE_SERVER_NAME = "knowledge";

/**
 * The default connection string, matching `config.ts`'s own default without
 * importing it (this module must stay free of harness singletons). The harness
 * injects the configured one at spawn, so this is only what a bare
 * `node dist/knowledge-mcp.js` falls back to.
 */
export const DEFAULT_DATABASE_URL = "postgres://postgres@localhost:5432/daedalus";

export type Db = pg.Pool;

/**
 * Open a connection to the harness database. Raw `pg`, not Drizzle: the MCP
 * subprocess must not pull in a Drizzle client, and it answers four tools over
 * stdio — a pool of two is more than the concurrency it can generate.
 *
 * `bigint` is parsed into a number here for the same reason `db/index.ts` does
 * it: every int8 in this schema is an epoch-millisecond stamp, decades short of
 * 2^53, and the formatter reads `created_at`/`updated_at` as numbers.
 */
export function openDb(connectionString: string = DEFAULT_DATABASE_URL): Db {
  pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
  pool.on("error", (error) => process.stderr.write(`knowledge db error: ${String(error)}\n`));
  return pool;
}

interface KnowledgeRow {
  id: string;
  project_id: string;
  title: string;
  content: string;
  /** `jsonb`, so pg hands this back already parsed — not the JSON text SQLite
      stored. `parseTags` still accepts both. */
  tags: string[] | string | null;
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

export async function addKnowledge(
  db: Db,
  projectId: string,
  input: { title: string; content: string; tags?: string[] },
): Promise<{ id: string }> {
  const id = randomUUID();
  const t = now();
  await db.query(
    `INSERT INTO ${KNOWLEDGE_TABLE} (id, project_id, title, content, tags, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, projectId, input.title, input.content, JSON.stringify(input.tags ?? []), t, t],
  );
  return { id };
}

export async function searchKnowledge(
  db: Db,
  projectId: string,
  query: string,
  limit?: number,
): Promise<KnowledgeRow[]> {
  const l = resultLimit(limit, SEARCH_LIMIT, 50);
  const pattern = like(query);
  /* ILIKE, because SQLite's LIKE was case-insensitive for ASCII by default and
     Postgres's is not — the "grep" match is the same match either way. `tags`
     is jsonb, so it is cast to text before the pattern is applied. */
  const result = await db.query<KnowledgeRow>(
    `SELECT * FROM ${KNOWLEDGE_TABLE}
     WHERE project_id = $1
       AND (title ILIKE $2 OR content ILIKE $2 OR tags::text ILIKE $2)
     ORDER BY updated_at DESC, created_at DESC LIMIT $3`,
    [projectId, pattern, l],
  );
  return result.rows;
}

export async function listKnowledge(db: Db, projectId: string, limit?: number): Promise<KnowledgeRow[]> {
  const l = resultLimit(limit, LIST_LIMIT, 200);
  const result = await db.query<KnowledgeRow>(
    `SELECT * FROM ${KNOWLEDGE_TABLE}
     WHERE project_id = $1
     ORDER BY updated_at DESC, created_at DESC LIMIT $2`,
    [projectId, l],
  );
  return result.rows;
}

export async function deleteKnowledge(db: Db, projectId: string, id: string): Promise<boolean> {
  // Scoped to project_id so an entry can never cross projects even if ids collide.
  const result = await db.query(
    `DELETE FROM ${KNOWLEDGE_TABLE} WHERE id = $1 AND project_id = $2`,
    [id, projectId],
  );
  return (result.rowCount ?? 0) > 0;
}

const parseTags = (raw: string[] | string | null): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
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
    at spawn from the project the session runs in and from its own configured
    database — nothing is cached in a library row, so the project id is always
    the live one for the thread. */
export function toKnowledgeServerEnv(projectId: string, url: string): { name: string; value: string }[] {
  return [
    { name: "KNOWLEDGE_PROJECT_ID", value: projectId },
    { name: "DATABASE_URL", value: url },
  ];
}
