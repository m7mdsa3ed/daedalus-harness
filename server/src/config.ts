import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR =
  process.env.DAEDALUS_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export interface FcmConfig {
  /** Path to a Firebase service account JSON (server-side sends). */
  serviceAccountPath: string;
  /** Public web app config handed to browsers (apiKey, projectId, messagingSenderId, appId, ...). */
  webConfig: Record<string, string>;
  /** Public VAPID key for web push tokens. */
  vapidKey: string;
}

export interface ServerConfig {
  token: string;
  host: string;
  port: number;
  /** Minutes a session survives with no client attached before its process is killed. */
  sessionIdleMinutes: number;
  fcm?: FcmConfig;
}

const CONFIG_PATH = join(DATA_DIR, "config.json");

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function loadConfig(): ServerConfig {
  const existing = readJson<Partial<ServerConfig>>(CONFIG_PATH, {});
  const config: ServerConfig = {
    token: existing.token ?? randomBytes(24).toString("hex"),
    host: existing.host ?? "0.0.0.0",
    port: existing.port ?? 8791,
    sessionIdleMinutes: existing.sessionIdleMinutes ?? 30,
    ...(existing.fcm ? { fcm: existing.fcm as FcmConfig } : {}),
  };
  if (!existing.token) writeJson(CONFIG_PATH, config);
  return config;
}
