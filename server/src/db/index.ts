import Database from "better-sqlite3";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { DATA_DIR, readJson } from "../config.js";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

const DB_PATH = join(DATA_DIR, "daedalus.db");
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

/*
 * better-sqlite3 rather than node:sqlite: it is what Drizzle's Node driver
 * binds to, and — more to the point — it is synchronous. `getProfile`,
 * `getAgent` and `listProjects` are called from synchronous paths (spawnProc
 * builds a child process's env from all three), so an async driver would push
 * `await` through sessions.ts and registry.ts to buy nothing.
 *
 * Every query in this codebase goes through the `db` exported here, so swapping
 * the driver is a change to this file and no other.
 */
const client = new Database(DB_PATH);
// WAL so a long read (a journal replay) never blocks the writes still streaming
// in from the agent. NORMAL trades an fsync per commit for the OS's word that
// the write landed — correct across a crashed process, which is the failure
// this actually has to survive; a lost machine can lose the last frames.
client.pragma("journal_mode = WAL");
client.pragma("synchronous = NORMAL");
// Off by default in SQLite, and the whole reason the join tables can be trusted.
client.pragma("foreign_keys = ON");
client.pragma("busy_timeout = 5000");

export const db = drizzle(client, { schema });

migrate(db, { migrationsFolder: MIGRATIONS });
importLegacyJson();

/**
 * Move a pre-SQLite install's `data/*.json` into the database, once.
 *
 * Idempotent by rename: an imported file becomes `<name>.json.imported`, so a
 * second boot finds nothing to do and the original is still there to read if
 * the import got something wrong. Runs in one transaction — a half-imported
 * install would be worse than either outcome.
 */
function importLegacyJson(): void {
  const legacy = (name: string) => join(DATA_DIR, name);
  const present = [
    "agents.json",
    "profiles.json",
    "projects.json",
    "mcp-servers.json",
    "skills.json",
    "sessions.json",
    "push-tokens.json",
  ].filter((name) => existsSync(legacy(name)));
  if (present.length === 0) return;

  interface LegacyProject {
    id: string;
    name?: string;
    cwd?: string;
    mcpServerIds?: string[];
    skillIds?: string[];
  }
  interface LegacySession {
    id: string;
    profileId?: string;
    projectId?: string;
    agentId?: string;
    model?: string;
    effort?: string;
    title?: string;
    acpSessionId?: string;
    createdAt?: number;
    deletedAt?: number | null;
  }

  const agents = readJson<(typeof schema.agents.$inferSelect)[]>(legacy("agents.json"), []);
  const profiles = readJson<(typeof schema.profiles.$inferSelect)[]>(legacy("profiles.json"), []);
  const projects = readJson<LegacyProject[]>(legacy("projects.json"), []);
  const mcp = readJson<(typeof schema.mcpServers.$inferSelect)[]>(legacy("mcp-servers.json"), []);
  const skills = readJson<(typeof schema.skills.$inferSelect)[]>(legacy("skills.json"), []);
  const sessions = readJson<LegacySession[]>(legacy("sessions.json"), []);
  const tokens = readJson<string[]>(legacy("push-tokens.json"), []);

  const now = Date.now();
  client.transaction(() => {
    for (const agent of agents) {
      db.insert(schema.agents)
        .values({
          id: agent.id,
          name: agent.name,
          command: agent.command,
          args: agent.args ?? [],
          env: agent.env ?? {},
          spawnCategories: agent.spawnCategories ?? null,
          // 0, so the DEFAULT_AGENTS merge in registry.ts still gets to add
          // whatever this install has never seen.
          seededVersion: 0,
        })
        .onConflictDoNothing()
        .run();
    }
    for (const profile of profiles) {
      db.insert(schema.profiles)
        .values({
          id: profile.id,
          name: profile.name,
          agentId: profile.agentId,
          baseUrl: profile.baseUrl ?? "",
          apiKey: profile.apiKey ?? "",
          defaultModel: profile.defaultModel ?? "",
          models: profile.models ?? [],
        })
        .onConflictDoNothing()
        .run();
    }
    for (const server of mcp) {
      db.insert(schema.mcpServers).values({ ...server }).onConflictDoNothing().run();
    }
    for (const skill of skills) {
      db.insert(schema.skills).values({ ...skill }).onConflictDoNothing().run();
    }
    // Projects before their links, and the links only for library entries that
    // actually exist — the JSON files had no way to enforce that, so a stale id
    // in an old file is exactly what this import is likely to be handed.
    const haveMcp = new Set(mcp.map((s) => s.id));
    const haveSkill = new Set(skills.map((s) => s.id));
    for (const project of projects) {
      db.insert(schema.projects)
        .values({ id: project.id, name: project.name ?? "", cwd: project.cwd ?? "" })
        .onConflictDoNothing()
        .run();
      for (const id of (project.mcpServerIds ?? []).filter((x) => haveMcp.has(x))) {
        db.insert(schema.projectMcpServers)
          .values({ projectId: project.id, mcpServerId: id })
          .onConflictDoNothing()
          .run();
      }
      for (const id of (project.skillIds ?? []).filter((x) => haveSkill.has(x))) {
        db.insert(schema.projectSkills)
          .values({ projectId: project.id, skillId: id })
          .onConflictDoNothing()
          .run();
      }
    }
    for (const session of sessions) {
      db.insert(schema.sessions)
        .values({
          id: session.id,
          profileId: session.profileId ?? "",
          projectId: session.projectId ?? "",
          agentId: session.agentId ?? "",
          model: session.model ?? "",
          effort: session.effort ?? "",
          title: session.title ?? "New thread",
          acpSessionId: session.acpSessionId ?? null,
          createdAt: session.createdAt ?? now,
          deletedAt: session.deletedAt ?? null,
        })
        .onConflictDoNothing()
        .run();
    }
    for (const token of tokens) {
      db.insert(schema.pushTokens)
        .values({ token, createdAt: now })
        .onConflictDoNothing()
        .run();
    }
  })();

  for (const name of present) renameSync(legacy(name), `${legacy(name)}.imported`);
  console.log(
    `[db] imported ${present.length} legacy JSON file(s) into ${DB_PATH}; ` +
      `originals kept as *.json.imported`,
  );
}
