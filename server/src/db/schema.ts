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

/** One model in a profile's catalog. Nested, and only ever read as a whole.
    The optional metadata past `reasoningEfforts` is filled from models.dev (or
    an agent's own advertising) and is display/enrichment only — nothing at
    spawn time reads it except `description`, which feeds the Codex catalog. */
export interface ModelDef {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts: string[];
  /** One-line capability blurb, when known. */
  description?: string;
  /** USD per million tokens. */
  pricing?: { input: number; output: number };
  /** Input modalities, e.g. ["text", "image"]. */
  modalities?: string[];
  /** Provenance when enriched: "providerId/modelId" in models.dev, so the
      entry can be re-looked-up later without guessing by id. */
  devRef?: string;
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

export interface WebSearchProfile {
  /** Replace the agent's built-in WebSearch/WebFetch with the harness's own
      `web-search` MCP server. Off by default; a profile opts in. */
  enabled: boolean;
  /** Overrides of the server-global web-search config. Each is only the profile's
      own value when set; empty means "inherit from the server default". The
      token is stored (redacted on read) the way a profile's apiKey is. */
  searchApiBaseUrl?: string;
  searchApiToken?: string;
  searchModel?: string;
  fetchModel?: string;
}

/** A profile opting the agent into the harness's `knowledge` MCP server. Just
    the flag — there is no per-profile config to override, unlike webSearch, so
    the profile only says whether the tools are advertised at all. Off by
    default. */
export interface KnowledgeProfile {
  enabled: boolean;
}

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Not a foreign key: a profile naming an agent that has since been removed
      is a broken profile the user should see and fix, not a row that vanishes. */
  agentId: text("agent_id").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  defaultModel: text("default_model").notNull(),
  /** The model an agent's cheap side-jobs run on, when it has a separate one.
      Empty (or null, on rows from before the column existed) means "the session
      model" — see `withSmallModelKeys` in registry.ts for why naming it at all
      matters against a gateway. Not part of `models`: it is not a model the user
      can pick for a thread, and listing it there would offer it as one. */
  smallModel: text("small_model"),
  models: text("models", { mode: "json" }).$type<ModelDef[]>().notNull(),
  /** Per-profile web-search toggle. Null on rows from before the column existed
      (treated as off — profiles opt in). */
  webSearch: text("web_search", { mode: "json" }).$type<WebSearchProfile>(),
  /** Opt the agent into the harness's `knowledge` MCP server. Null on rows from
      before the column existed (treated as off — profiles opt in). */
  knowledge: text("knowledge", { mode: "json" }).$type<KnowledgeProfile>(),
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

/** A titled knowledge-base entry, keyed to a project. The agent's `knowledge`
    MCP server reads and writes these; `project_id` scopes every query so
    nothing a workspace learns leaks into another. Search is substring `LIKE`
    (the "grep" contract — deliberately no vector index), ordered by recency.
    Titled where a bare note would have been a separate `memories` table — the
    two were the same thing, so they are one concept now. */
export const knowledge = sqliteTable(
  "knowledge",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The entry's title — knowledge entries are titled where memories are not. */
    title: text("title").notNull(),
    content: text("content").notNull(),
    /** Optional tags, stored as a JSON string-array. */
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("knowledge_project").on(t.projectId)],
);

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
    /** True while `acpSessionId` is an id the agent handed out but no turn has
        committed to yet. Such an id is written down anyway — losing it is how a
        thread ends up with no pointer to anything at all — but it is the one id
        a later `session/new` is allowed to replace, and a load that refuses it
        is not a lost history, just a session the agent never flushed. */
    acpSessionProvisional: integer("acp_session_provisional", { mode: "boolean" })
      .notNull()
      .default(false),
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
 *
 * **It is a cache for reading, never a source for resuming.** The conversation
 * lives in the agent's own store and comes back through `session/load`; what is
 * here is only what the browser was told about it. So a revive clears this log
 * and refills it from the load replay (`SessionManager.respawnNow`), and nothing
 * ever reconstructs a thread's state *for the agent* out of these rows. The rule
 * used to be enforced by deleting the whole table at boot, which also meant a
 * retired thread could not be *read* without spawning a process to re-narrate
 * it. Keeping the rows separates the two: reading is free, resuming still goes
 * through the agent.
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
    /** The event exactly as the socket sends it (see src/protocol.ts).
        Stored as text and *read back as text* on the replay path: it is already
        the JSON the browser needs, so parsing it here only to stringify it again
        per peer is work with no reader. */
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    /** Epoch ms this event was journaled. The log outlives its process now, so
        something has to say how old an archive is — this is what the retention
        sweep reads (`SessionManager.pruneJournals`). Defaulted in SQL rather
        than left nullable so the column can be added to a table that already
        has rows in it. */
    at: integer("at").notNull().default(0),
  },
  (t) => [uniqueIndex("session_events_seq").on(t.sessionId, t.seq)],
);

/**
 * A compact usage ledger for the harness-provided web-search MCP server.
 *
 * The transcript already contains the tool input and output. This table is
 * intentionally metadata-only so aggregate usage can be inspected without
 * copying queries, fetched URLs, response bodies or credentials into a second
 * store. Names are snapshotted because usage should remain intelligible after
 * a profile, project or thread is removed.
 */
export const webSearchUsage = sqliteTable(
  "web_search_usage",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    tool: text("tool", { enum: ["search", "fetch"] }).notNull(),
    status: text("status").notNull(),
    threadTitle: text("thread_title").notNull(),
    profileId: text("profile_id").notNull(),
    profileName: text("profile_name").notNull(),
    projectId: text("project_id").notNull(),
    projectName: text("project_name").notNull(),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [
    uniqueIndex("web_search_usage_call").on(t.sessionId, t.toolCallId),
    index("web_search_usage_started").on(t.startedAt),
  ],
);

/** Durable restore points created before logical agent turns. Snapshot content
    lives in data/history; SQLite keeps ownership, branch and ACP pointers. */
export const historyCheckpoints = sqliteTable(
  "history_checkpoints",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id").notNull().unique(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    promptText: text("prompt_text").notNull(),
    parentAcpSessionId: text("parent_acp_session_id").notNull(),
    childAcpSessionId: text("child_acp_session_id").notNull(),
    preSnapshotId: text("pre_snapshot_id").notNull(),
    postManifest: text("post_manifest", { mode: "json" }).$type<unknown>(),
    parentCheckpointId: text("parent_checkpoint_id"),
    branchId: text("branch_id"),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (t) => [index("history_checkpoints_session").on(t.sessionId, t.createdAt)],
);

/** Retained branch heads. A revert never deletes the child ACP session or the
    workspace state it displaced; this row is the recovery handle for both. */
export const historyBranches = sqliteTable(
  "history_branches",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    sourceCheckpointId: text("source_checkpoint_id").notNull(),
    acpSessionId: text("acp_session_id").notNull(),
    workspaceSnapshotId: text("workspace_snapshot_id").notNull(),
    label: text("label").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    recoveredAt: integer("recovered_at"),
  },
  (t) => [index("history_branches_session").on(t.sessionId, t.createdAt)],
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

/**
 * A scheduled message: send `text` to `session_id`'s agent at `nextAt`, then
 * again every `every_ms` until cancelled. The server owns delivery — a browser
 * tab closing must not be what stops a scheduled turn — which is why it is a
 * row here rather than a timer in the client. `every_ms` is null for a one-shot:
 * it fires once and the row is gone, where a recurring row is kept and advanced.
 */
export const scheduledMessages = sqliteTable(
  "scheduled_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** Epoch ms of the next scheduled fire. */
    nextAt: integer("next_at").notNull(),
    /** Recurrence interval in ms; null = one-shot. */
    everyMs: integer("every_ms"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("scheduled_next").on(t.nextAt)],
);

/**
 * Saved preview URLs, per project.
 *
 * A dev server's address is a property of the project, not of a browser tab —
 * you want the same `localhost:5173` back on the phone that you saved on the
 * laptop, and a panel that forgets it on every reload is one you stop using.
 * So it lives here rather than in localStorage like the device-local stores.
 *
 * Only project-trust previews are stored. An external-trust page is not a
 * project resource and must not gain one by being bookmarked.
 */
export const projectPreviews = sqliteTable(
  "project_previews",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    url: text("url").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("preview_project").on(t.projectId)],
);

/**
 * A task on the tasks board.
 *
 * Standalone for now: a genuinely top-level resource, not scoped to a session,
 * project or agent. The board is user-managed; wiring tasks to agent turns (the
 * "no connection between the agents and the board, initially" promise) is a
 * later step, and the schema deliberately holds no foreign keys so nothing here
 * has to be rethought when that arrives.
 *
 * `status` and `board` are distinct: a status is what the task IS (todo /
 * in_progress / done / blocked), while the board is which column it sits in on
 * the kanban. For the default single-board app they collapse, but keeping them
 * apart means reorder/drag is a pure column+order operation that never has to
 * guess at a status, and a future multi-board read (filter by board, not by
 * migrating statuses) stays a simple column add.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    board: text("board").notNull().default("default"),
    title: text("title").notNull(),
    /** Markdown body; null = none. */
    description: text("description"),
    status: text("status", {
      enum: ["todo", "in_progress", "done", "blocked"],
    })
      .notNull()
      .default("todo"),
    priority: text("priority", { enum: ["low", "medium", "high", "urgent"] })
      .notNull()
      .default("medium"),
    /** Free text tag names, stored as a JSON string-array. */
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** Who it is assigned to; free text (no user system yet). */
    assignee: text("assignee"),
    /** Epoch ms due timestamp; null = no due date. */
    dueAt: integer("due_at"),
    /** Sticky note for within-column ordering on the kanban. */
    note: text("note"),
    /** Position within the column, for a stable manual order. */
    order: integer("order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("tasks_board_order").on(t.board, t.status, t.order)],
);
