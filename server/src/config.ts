import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
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
  /** Days a *retired* thread's event log is kept so the transcript can be read
      back without spawning an agent. Only ever applied to threads with no live
      process: a running thread's log is what its peers are attached to, and
      trimming the head of one would hand the next attach a transcript that
      silently starts in the middle. 0 disables the archive entirely, which is
      the pre-archive behaviour. Defaults to 30. */
  sessionJournalRetentionDays: number;
  /**
   * Origin (scheme + host, no trailing slash) an OAuth authorization server
   * should redirect back to when connecting an MCP server — the `/oauth/mcp/
   * callback` route hangs off it.
   *
   * Unset is the ordinary case: the base is then derived from the request that
   * started the flow (`X-Forwarded-Proto`/`X-Forwarded-Host`, then `Origin`,
   * then `Host`), because the browser is already talking to this server and
   * whatever origin it used is reachable by definition. Set it for a named
   * tunnel or a reverse proxy — and for an authorization server that only
   * accepts a loopback redirect, which is the one case nothing can be derived
   * for. It has to match what was registered byte for byte; when it changes,
   * the client is re-registered rather than reused.
   */
  mcpOauthRedirectBase?: string;
  /** Where `POST /api/projects/from-template` puts a new app when the request
      names no parent. Absent means `~/daedalus-apps` — see `appsDir()`. */
  appsDir?: string;
  fcm?: FcmConfig;
  webSearch?: WebSearchConfig;
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
    sessionJournalRetentionDays: existing.sessionJournalRetentionDays ?? 30,
    ...(existing.mcpOauthRedirectBase ? { mcpOauthRedirectBase: existing.mcpOauthRedirectBase } : {}),
    ...(existing.appsDir ? { appsDir: existing.appsDir } : {}),
    ...(existing.fcm ? { fcm: existing.fcm as FcmConfig } : {}),
    ...(existing.webSearch ? { webSearch: existing.webSearch as WebSearchConfig } : {}),
  };
  // Seeding a token writes the file; write what the file says, not the env
  // override, so a pm2 port does not become the on-disk default.
  if (!existing.token) writeJson(CONFIG_PATH, { ...config, host: existing.host ?? "0.0.0.0", port: existing.port ?? 8791 });
  return config;
}

/** `loadConfig()`, once. `loadConfig` re-reads and re-parses config.json on
    every call, which is fine at boot and wasteful on every spawn
    (`SessionManager.serversFor`). The file is bootstrap and hand-edited only
    while the server is down — the one runtime writer is `saveWebSearch`, which
    invalidates this cache, so a web-search edit still reaches the next spawn. */
let cachedConfig: ServerConfig | null = null;
export function getConfig(): ServerConfig {
  return (cachedConfig ??= loadConfig());
}

/** The directory new apps are scaffolded into by default. A function rather
    than a resolved field so the file keeps carrying only what the user wrote —
    the token-seeding write on first boot would otherwise pin this machine's
    home directory into `config.json`. */
export function appsDir(): string {
  return getConfig().appsDir?.trim() || join(homedir(), "daedalus-apps");
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
  cachedConfig = null; // the next getConfig() re-reads what was just written
  return input;
}
