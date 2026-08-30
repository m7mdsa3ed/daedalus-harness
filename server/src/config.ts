import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR =
  process.env.DAEDALUS_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data");

// The database file is opened as soon as db/index.ts is imported, and
// better-sqlite3 will not create the directory for it.
mkdirSync(DATA_DIR, { recursive: true });

export interface FcmConfig {
  /** Path to a Firebase service account JSON (server-side sends). */
  serviceAccountPath: string;
  /** Public web app config handed to browsers (apiKey, projectId, messagingSenderId, appId, ...). */
  webConfig: Record<string, string>;
  /** Public VAPID key for web push tokens. */
  vapidKey: string;
}

/**
 * The web-search backend the built-in `web-search` MCP server answers against.
 * Server-global (one pair of credentials, like cc-cli's `.env`), read by the
 * MCP server subprocess at spawn rather than baked into a library row — so a
 * config edit here is picked up by the next `session/new` or respawn, never a
 * stale token cached in the database.
 */
export interface WebSearchConfig {
  /** The search API base URL, e.g. http://localhost:20128 */
  searchApiBaseUrl: string;
  /** Bearer token for the search API. Never exposed to clients. */
  searchApiToken: string;
  /** Model id the search API serves for `/v1/search`. */
  searchModel: string;
  /** Model id the search API serves for `/v1/web/fetch`. */
  fetchModel: string;
}

export interface ServerConfig {
  token: string;
  host: string;
  port: number;
  /** Minutes a session survives with no client attached before its process is killed. */
  sessionIdleMinutes: number;
  fcm?: FcmConfig;
  webSearch?: WebSearchConfig;
  history?: {
    /** Maximum bytes represented by one workspace snapshot. */
    maxSnapshotBytes?: number;
    /** Retained discarded branch heads per thread. Defaults to 20. */
    maxRetainedBranches?: number;
    /** Extra names never snapshotted, on top of the built-in list. Only
        consulted for a workspace that is not a git repo — in one, the
        project's own .gitignore is the authority. */
    ignore?: string[];
  };
}

/*
 * Everything else the harness stores now lives in SQLite (see db/schema.ts).
 * config.json stays a file on purpose: it is bootstrap — the port and host the
 * server binds to, the token it prints, the path to a Firebase service account —
 * and it is the one thing a person edits by hand, sometimes to recover a server
 * they can no longer reach. A row in a database nobody can open yet would be a
 * worse place for it.
 *
 * readJson/writeJson survive for exactly that file and for reading the agents'
 * own config files during discovery (discover.ts) and the one-time JSON import
 * (db/index.ts).
 */
const CONFIG_PATH = join(DATA_DIR, "config.json");

export function readJson<T>(path: string, fallback: T): T {
  // A torn write leaves the file unparseable; the previous good copy is next to
  // it. Preferring a stale config to no config is the right way round here.
  for (const candidate of [path, `${path}.bak`]) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as T;
    } catch (error) {
      console.error(`[config] ${candidate} is not valid JSON`, error);
    }
  }
  return fallback;
}

/** Write via a temp file and rename, so a crash mid-write cannot leave a
    half-written config behind. `rename` is atomic within one filesystem. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(tmp, path);
}

export function loadConfig(): ServerConfig {
  const existing = readJson<Partial<ServerConfig>>(CONFIG_PATH, {});
  const config: ServerConfig = {
    token: existing.token ?? randomBytes(24).toString("hex"),
    // The env wins over the file for the two bind settings, and only those: a
    // process manager (pm2, a container) decides the port it maps, and it must
    // not need the file edited — or, worse, rewritten under a second instance
    // reading the same data dir. Everything else stays the file's.
    host: process.env.DAEDALUS_HOST ?? existing.host ?? "0.0.0.0",
    port: Number(process.env.DAEDALUS_PORT ?? process.env.PORT) || existing.port || 8791,
    sessionIdleMinutes: existing.sessionIdleMinutes ?? 30,
    ...(existing.fcm ? { fcm: existing.fcm as FcmConfig } : {}),
    ...(existing.webSearch ? { webSearch: existing.webSearch as WebSearchConfig } : {}),
    ...(existing.history ? { history: existing.history } : {}),
  };
  // Seeding a token writes the file; write what the file says, not the env
  // override, so a pm2 port does not become the on-disk default.
  if (!existing.token) writeJson(CONFIG_PATH, { ...config, host: existing.host ?? "0.0.0.0", port: existing.port ?? 8791 });
  return config;
}

/** The stored server-global webSearch block, or undefined. Read without the
    token-seeding write that `loadConfig` performs on first boot, and without
    applying env overrides — this is exactly what is on disk. */
export function readWebSearch(): WebSearchConfig | undefined {
  return readJson<Partial<ServerConfig>>(CONFIG_PATH, {}).webSearch;
}

/** Replace the server-global webSearch block, preserving everything else in
    config.json (token, host, port, fcm). Atomic write via `writeJson`. */
export function saveWebSearch(input: WebSearchConfig): WebSearchConfig {
  const existing = readJson<Partial<ServerConfig>>(CONFIG_PATH, {});
  writeJson(CONFIG_PATH, { ...existing, webSearch: input });
  return input;
}
