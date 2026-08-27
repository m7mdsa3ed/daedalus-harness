import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/*
 * The harness's own data. Everything that used to be a `data/*.json` file lives
 * here; `data/config.json` is the one deliberate holdout (see config.ts — it is
 * bootstrap, and it has to stay hand-editable).
 *
 * Two things the JSON files could not express and this schema does:
 *
 *   - **Links are real.** A project's MCP servers and skills were arrays of ids
 *     that nothing kept honest, so deleting a library entry left its id behind
 *     in every project that referenced it and the readers filtered the corpses
 *     out at spawn time. They are join tables now, and the cascade does it.
 *   - **The event log is not in memory.** It was an unbounded array per live
 *     session, which is what made a long thread expensive to hold and its
 *     transcript expensive to fetch. It is a table keyed by (session, seq), so
 *     the tail costs nothing to keep and a replay is a range scan.
 */

/** One model in a profile's catalog. Nested, and only ever read as a whole. */
export interface ModelDef {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts: string[];
}

/** `{name, value}` pairs — the shape the MCP library already stores. */
export interface NameValue {
  name: string;
  value: string;
}

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  command: text("command").notNull(),
  args: text("args", { mode: "json" }).$type<string[]>().notNull(),
  env: text("env", { mode: "json" }).$type<Record<string, string>>().notNull(),
  /** ACP config categories this agent can only take at spawn time, mapped to
      the session field that feeds its env template. Anything not listed here
      is applied live over `session/set_config_option` instead of respawning. */
  spawnCategories: text("spawn_categories", { mode: "json" })
    .$type<Record<string, "model" | "effort">>(),
  /** Which release of DEFAULT_AGENTS seeded this row. A later release can add
      an agent to an install that already has rows without touching user edits —
      the old seed-if-the-file-is-empty rule could never do that. */
  seededVersion: integer("seeded_version").notNull(),
});

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Not a foreign key: a profile naming an agent that has since been removed
      is a broken profile the user should see and fix, not a row that vanishes. */
  agentId: text("agent_id").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  defaultModel: text("default_model").notNull(),
  models: text("models", { mode: "json" }).$type<ModelDef[]>().notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  cwd: text("cwd").notNull(),
  /** Optional free-text notes; null on rows from before the column existed. */
  description: text("description"),
});

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["http", "stdio"] }).notNull(),
  name: text("name").notNull(),
  // http
  url: text("url"),
  headers: text("headers", { mode: "json" }).$type<NameValue[]>(),
  // stdio
  command: text("command"),
  args: text("args", { mode: "json" }).$type<string[]>(),
  env: text("env", { mode: "json" }).$type<NameValue[]>(),
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Directory on the server holding SKILL.md. */
  path: text("path").notNull(),
});

export const commands = sqliteTable("commands", {
  id: text("id").primaryKey(),
  /** Invocation name — becomes `/name`, and `<name>.md` on disk. */
  name: text("name").notNull(),
  description: text("description").notNull(),
  /** Placeholder shown while the arguments are still untyped (frontmatter `argument-hint`). */
  argumentHint: text("argument_hint"),
  /** Markdown prompt body; `$ARGUMENTS` receives whatever follows the name. */
  content: text("content").notNull(),
});

export const projectMcpServers = sqliteTable(
  "project_mcp_servers",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mcpServerId: text("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.mcpServerId] })],
);

export const projectSkills = sqliteTable(
  "project_skills",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.skillId] })],
);

export const projectCommands = sqliteTable(
  "project_commands",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    commandId: text("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.commandId] })],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    /* None of these three are foreign keys, on purpose. A thread has to outlive
       the profile or project it was started from: the conversation is still in
       the agent's own store, and the client already knows how to say "this
       thread's project no longer exists" rather than losing the row. */
    profileId: text("profile_id").notNull(),
    projectId: text("project_id").notNull(),
    agentId: text("agent_id").notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull(),
    title: text("title").notNull(),
    /** The agent's own session id — what `session/load` is called with. */
    acpSessionId: text("acp_session_id"),
    createdAt: integer("created_at").notNull(),
    /** Epoch ms this thread was deleted; null = live. Deleted threads keep
        their row (and their acpSessionId) so a delete stays undoable. */
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("sessions_live").on(t.deletedAt, t.createdAt)],
);

/**
 * A thread's durable event log — the same events the live socket sends.
 *
 * This used to be raw ACP frames, which forced the client to carry a second
 * parser: one for live `session/update` notifications and another that sniffed
 * JSON-RPC out of the replayed log. Now live and replay are the same events, so
 * they take the same path on the other end and there is one parser.
 */
export const sessionEvents = sqliteTable(
  "session_events",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** Position in this session's event log. This is what `cursor` indexes —
        it is monotonic and a replay is a range scan on (session_id, seq). */
    seq: integer("seq").notNull(),
    /** The event's discriminant: "update" | "session_config" | "turn_started" |
        "turn_ended". It duplicates `payload.ev`, which is the point — the table
        stays readable in db:studio and filterable without parsing JSON. */
    kind: text("kind").notNull(),
    /** The event exactly as the socket sends it (see src/protocol.ts). */
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
  },
  (t) => [uniqueIndex("session_events_seq").on(t.sessionId, t.seq)],
);

export const pushTokens = sqliteTable("push_tokens", {
  token: text("token").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

/**
 * What a profile's agent answered when we asked it what it can be configured
 * with (see probe.ts). Cached because the only way to ask is to spawn the agent
 * and throw it away, and the answer changes only when the agent or the cwd does.
 */
export const agentOptions = sqliteTable("agent_options", {
  /** `profileId:agentId:cwd` — cwd is in the key because it changes the answer. */
  key: text("key").primaryKey(),
  options: text("options", { mode: "json" }).$type<unknown>().notNull(),
  probedAt: integer("probed_at").notNull(),
});
