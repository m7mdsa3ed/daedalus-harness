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

/**
 * How to ask a runtime what is left of the subscription it is spending.
 *
 * `kind` picks one of the adapters in quota.ts — the wire protocol is code,
 * because a CLI that prints prose and a JSON-RPC server are not the same
 * conversation — while `command`/`args` are data the user can edit, exactly like
 * the agent's own `command`/`args`. An agent with no subscription notion (an
 * OpenAI-key runtime, OpenCode) simply has no probe, which the UI reports as
 * "no quota to show" rather than as an empty dial.
 */
export interface QuotaProbe {
  kind: "claude-cli" | "codex-app-server";
  command: string;
  args: string[];
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
  /** How a model/effort/profile change reaches this agent *without* restarting
      it, when it can at all. `"acp"` = its own selector will take the profile's
      ids, because the harness writes them where the agent looks for its model
      allowlist; `"gateway"` = it will not, so the shim rewrites the model on
      the wire instead. Null = neither, and the change costs a respawn. */
  liveConfig: text("live_config").$type<"acp" | "gateway">(),
  /** How to ask this runtime what is left of its subscription quota, or null
      when it has no such notion (see QuotaProbe in registry.ts). Declared with
      the agent for the same reason `spawnCategories` is: the *how to talk* is
      one of quota.ts's adapters, but the command to run is the user's. */
  quotaProbe: text("quota_probe", { mode: "json" }).$type<QuotaProbe>(),
  /** Which door this runtime opens for a thread's persona (`personas.ts`):
      `"acp-meta"` = the ACP `_meta` block on session/new and session/load,
      `"env"` = a key in its own config template, filled from `{personaPrompt}`
      or `{personaFile}`. Null = no known door, and a persona is not applied. */
  personaVia: text("persona_via").$type<"acp-meta" | "env">(),
  /** Which release of DEFAULT_AGENTS seeded this row. A later release can add
      an agent to an install that already has rows without touching user edits —
      the old seed-if-the-file-is-empty rule could never do that. */
  seededVersion: integer("seeded_version").notNull(),
});

/**
 * A profile's per-agent settings. The key set is the contract — which agents
 * this profile can spawn — and the value carries the little that genuinely
 * differs per agent on one provider: the base URL, because a gateway that
 * serves several runtimes often serves them at different paths or API shapes
 * (an Anthropic-messages path for Claude Code, an OpenAI-responses path for
 * Codex). Everything else on the profile — credentials, catalog, default
 * model — is provider data and is shared.
 */
export interface ProfileAgentLink {
  /** Overrides the profile's shared baseUrl for this agent only. Empty/absent
      means "use the shared one". */
  baseUrl?: string;
}

/**
 * Which provider answers "how much of the plan is left" for this profile.
 *
 * The agent-side `QuotaProbe` asks a *runtime's* CLI about the machine's own
 * login, which is the right question for `claude`/`codex login` and the wrong
 * one for everything else: a profile pointed at a provider's coding plan is a
 * subscription the runtime knows nothing about, metered by that provider's own
 * account API. `claude -p /usage` on a z.ai profile reports the Anthropic
 * account it is not spending.
 *
 * So the provider is a property of the *profile*, not the agent, and it is
 * declared the same way a probe is — a `kind` that picks an adapter plus the
 * little that configures it — rather than matched on a base URL. `kind` is the
 * whole contract: an adapter owns its endpoint, its auth shape and its response.
 */
export type ProfileUsageKind =
  /** No plan to report. The agent's own probe answers, if it has one. */
  | "none"
  /** Z.AI / Zhipu GLM Coding Plan (`/api/monitor/usage/quota/limit`). */
  | "zai";

/** Every `kind` a profile may name, for the form's picker and for validating a
    saved profile. Adding a provider is this array, the union above, and a branch
    in `readProfileUsage` (usage-api.ts). */
export const USAGE_KINDS = ["none", "zai"] as const satisfies readonly ProfileUsageKind[];

export interface ProfileUsage {
  kind: ProfileUsageKind;
  /** Override the adapter's default host, or name the full endpoint outright.
      Empty means the adapter decides (which for z.ai includes picking the CN
      platform when the profile's own base URL is a bigmodel.cn one). */
  baseUrl?: string;
  /** Credential for the usage API when it is not the profile's own key.
      Empty means "use `profiles.api_key`", which is the ordinary case: a
      coding-plan key is what both the inference and the monitor route take. */
  apiKey?: string;
}

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Which agents this profile can spawn, and what differs per agent (see
      ProfileAgentLink). Not foreign keys: a profile naming an agent that has
      since been removed is a broken profile the user should see and fix, not
      a row that vanishes. Replaces the old single `agent_id` column — one
      provider (credentials + catalog) serves several runtimes, and binding it
      to one forced the same key and model list to be entered once per agent. */
  agents: text("agents", { mode: "json" })
    .$type<Record<string, ProfileAgentLink>>()
    .notNull()
    .default({}),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  defaultModel: text("default_model").notNull(),
  /** The model an agent's cheap side-jobs run on, when it has a separate one.
      Empty (or null, on rows from before the column existed) means "the session
      model" — see `withSmallModelKeys` in registry.ts for why naming it at all
      matters against a gateway. Not part of `models`: it is not a model the user
      can pick for a thread, and listing it there would offer it as one. */
  smallModel: text("small_model"),
  /** Logo shown next to the profile in pickers (a URL, e.g. a models.dev
      provider mark). Null on rows from before the column existed — treated as
      "no logo", which falls back to the agent's own mark in the client. */
  logoUrl: text("logo_url"),
  models: text("models", { mode: "json" }).$type<ModelDef[]>().notNull(),
  /** How to read this provider's subscription usage (see ProfileUsage). Null on
      rows from before the column existed, and on every profile whose provider
      meters per token — which is most of them, and is why "no usage API" is the
      default rather than something to configure. */
  usage: text("usage", { mode: "json" }).$type<ProfileUsage>(),
  /* The web-search and knowledge opt-ins used to be columns here. They are
     library rows now (`mcp_servers.type = "builtin"`), linked like any other
     server — see BUILTIN_MCP in library.ts. */
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  cwd: text("cwd").notNull(),
  /** Optional free-text notes; null on rows from before the column existed. */
  description: text("description"),
  /** Optional logo URL, shown wherever the project is named — the sidebar
      folder, pickers, the projects list. Null/empty means "no logo", which
      falls back to the project's initial in the client. */
  logoUrl: text("logo_url"),
});

/** The harness's own MCP servers, as library rows. `builtin` names which; the
    row stores no command, env or credentials — those are synthesized at spawn
    (`sessions.ts`: config.json's search backend, the project's id) so a config
    edit is live and a token is never cached in a row. */
export type BuiltinMcp = "web-search" | "knowledge" | "workflow";

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["http", "stdio", "builtin"] }).notNull(),
  name: text("name").notNull(),
  // builtin
  builtin: text("builtin", { enum: ["web-search", "knowledge", "workflow"] }).$type<BuiltinMcp>(),
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

/**
 * How a thread wants to be worked on — the instruction half of a thread's
 * configuration, where the profile is the credentials half and the model is the
 * engine.
 *
 * A persona is NOT prose the harness pastes in front of the user's message. It
 * is fed to each runtime through the door that runtime already opens for it
 * (`personas.ts`, `AgentDef.personaVia`), so the agent's own system prompt is
 * appended to rather than replaced and nothing about the transcript changes:
 * what the user typed is still exactly what is journaled.
 *
 * Seeded like `agents` and for the same reasons — `seededVersion` records the
 * release a row was offered in, so a persona added later reaches installs that
 * already exist and one the user deleted on purpose stays deleted.
 */
export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** The instruction block. Appended to the agent's own system prompt. */
  prompt: text("prompt").notNull(),
  /**
   * The thinking budget, where the runtime has one as its own axis:
   * null/absent = leave it alone, `0` = off, a positive integer = that many
   * tokens. This is deliberately not the same knob as `effort`: claude-code
   * exposes both and they mean different things (see `personas.ts`), and an
   * agent that has only one gets only the one it has.
   */
  thinking: integer("thinking"),
  /** A value out of the agent's own effort selector, applied at spawn like any
      other effort. Null = whatever the thread already had. */
  effort: text("effort"),
  /** A row this release seeded (see `seedPersonas`); 0 = the user's own. */
  seededVersion: integer("seeded_version").notNull().default(0),
  /** Declared order in every menu. A list you have to read alphabetically is a
      list whose author's ordering has been thrown away. */
  sortOrder: integer("sort_order").notNull().default(0),
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

/* The library links — MCP servers, skills, slash commands — on a profile:
   what the *provider setup* brings to every thread started on it (a gateway
   with its own MCP servers, the skills that go with a house style). A thread
   adds its own (the `session_*` tables below); the agent gets the union — see
   `SessionManager.effectiveLinks`. Projects used to carry these too and no
   longer do: a project is a directory. */
export const profileMcpServers = sqliteTable(
  "profile_mcp_servers",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    mcpServerId: text("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.mcpServerId] })],
);

export const profileSkills = sqliteTable(
  "profile_skills",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.skillId] })],
);

export const profileCommands = sqliteTable(
  "profile_commands",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    commandId: text("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.commandId] })],
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
    /** The persona this thread runs under, or null for none. Not a foreign key
        either, and for the same reason `parent_session_id` below is not: a row
        vanishing out from under a live thread is the manager's business, not
        SQL's. A deleted persona simply reads as "none" on the next spawn, which
        is exactly what it is. */
    personaId: text("persona_id"),
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
    /** Epoch ms of the last turn on this thread — what the sidebar orders by.
        Creation is not activity: a thread started weeks ago and picked up this
        morning belongs at the top, and ordering by `created_at` buried it under
        threads nothing had been said in since. Bumped once per turn (the
        journaled `turn_started`/`turn_ended`, never per streamed event), and 0
        on a row written before the column existed — `reload` backfills those
        from the journal's own `max(at)`, falling back to `created_at`. */
    lastActivityAt: integer("last_activity_at").notNull().default(0),
    /** Epoch ms this thread was deleted; null = live. Deleted threads keep
        their row (and their acpSessionId) so a delete stays undoable. */
    deletedAt: integer("deleted_at"),
    /** The thread this one is a workflow step of (`workflows.ts`), else null.
        Indexed, and NOT a foreign key like the three above — but for a different
        reason: an SQL cascade would delete the children's rows underneath the
        manager's in-memory map (their journals, FTS rows and processes are the
        manager's to take down through `purge`), and a backup merge inserts
        sessions in bundle order, where a child may precede its parent inside the
        one transaction. `SessionManager.purge`/`softDelete`/`restore` cascade
        to children by hand. */
    parentSessionId: text("parent_session_id"),
  },
  (t) => [
    index("sessions_live").on(t.deletedAt, t.createdAt),
    index("sessions_parent").on(t.parentSessionId),
  ],
);

/**
 * One run of a harness workflow (`workflows.ts`): the definition the agent
 * handed `run_workflow`, its inputs, and where every step got to. Steps live in
 * one JSON column rather than a table of their own: the only queries are "runs
 * of this thread" and "what was running when the server last stopped", and a
 * step's identity is its name inside the definition. Cascades with the parent
 * row (the run is meaningless without the thread that asked for it), which only
 * a purge deletes — and `purge` retires the children first, so nothing live
 * points at a deleted run. Step threads themselves are ordinary `sessions`
 * rows carrying `parent_session_id`.
 */
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    parentSessionId: text("parent_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    definition: text("definition", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    inputs: text("inputs", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["running", "completed", "failed", "cancelled"] })
      .$type<WorkflowRunStatus>()
      .notNull(),
    error: text("error"),
    steps: text("steps", { mode: "json" }).$type<WorkflowStepRecord[]>().notNull(),
    createdAt: integer("created_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [index("workflow_runs_parent").on(t.parentSessionId, t.createdAt)],
);

export type WorkflowRunStatus = "running" | "completed" | "failed" | "cancelled";
export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

/** One step's progress inside `workflow_runs.steps`. */
export interface WorkflowStepRecord {
  name: string;
  /** The phase the step was written under, when the definition had any. */
  phase?: string | null;
  status: WorkflowStepStatus;
  /** The step's thread, once spawned. */
  sessionId: string | null;
  /** Prompts sent so far: 1 after the step's prompt, 2 after the JSON repair turn. */
  attempt: number;
  /** The child's final prose (text steps) or its parsed, validated JSON. */
  output: unknown;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

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
/* And on a thread: what this one conversation was started with, on top of
   its profile's. Picked on the draft, kept for the thread's
   life so a revive spawns the same tools, and cascaded away with the row. */
export const sessionMcpServers = sqliteTable(
  "session_mcp_servers",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    mcpServerId: text("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.mcpServerId] })],
);

export const sessionSkills = sqliteTable(
  "session_skills",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.skillId] })],
);

export const sessionCommands = sqliteTable(
  "session_commands",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    commandId: text("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.commandId] })],
);

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

/* The `history_checkpoints` / `history_branches` tables lived here until the
   checkpoint controller was deleted; migration 0027 drops them. */

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
 * The last subscription-quota answer for a (profile, agent) pair — see quota.ts.
 *
 * Cached for the same reason `agent_options` is: asking means spawning a process
 * and throwing it away, and several tabs plus the composer popover all want the
 * same number. Unlike that one it *expires* (QUOTA_TTL_MS) rather than being
 * keyed by everything that could change it — a quota moves on its own, with no
 * local event to invalidate it. No cwd in the key: quota is account-level and
 * the same in every directory.
 *
 * Derived state, so it is deliberately not in a backup (backup.ts says the same
 * of the probe cache): a bundle restored onto another machine would be carrying
 * a stale reading of an account it may not even be logged into.
 */
export const agentQuota = sqliteTable("agent_quota", {
  /** `profileId:agentId`. */
  key: text("key").primaryKey(),
  snapshot: text("snapshot", { mode: "json" }).$type<unknown>().notNull(),
  fetchedAt: integer("fetched_at").notNull(),
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
    /** 1 = the sweep delivers it; 0 = paused (kept, skipped). Integer rather
        than boolean mode so the API shape is explicit about what is stored. */
    enabled: integer("enabled").notNull().default(1),
    /** Epoch ms of the last sweep that could not deliver (missing/trashed
        thread); null once a delivery succeeds or the row is edited. */
    skippedAt: integer("skipped_at"),
    /** Why the last skip happened, for GET /api/scheduled. */
    lastError: text("last_error"),
    /** Consecutive skips. Past MAX_SCHEDULE_SKIPS the sweep stops selecting
        the row instead of re-matching it every 15s forever; any PATCH resets. */
    skipCount: integer("skip_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("scheduled_next").on(t.nextAt)],
);

/**
 * A thread's queued prompts: what the user typed while a turn was running,
 * sent — combined into ONE prompt — when that turn ends cleanly. Server-owned
 * for the same reason scheduled_messages is: a tab closing must not lose a
 * message, and the turn end that drains it happens whether or not a browser is
 * attached. A table rather than a JSON column on `sessions`, because
 * `persist()` rewrites that whole row on every title sniff and model change and
 * would race the queue, and edit/remove/"send this one" are row operations.
 * Ordered by `position` (monotonic per session, like session_events.seq).
 */
export const sessionQueue = sqliteTable(
  "session_queue",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("session_queue_order").on(t.sessionId, t.position)],
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
 * One-row bookkeeping for the boot-time backfill of the search index
 * (`search.ts`), keyed so a future index rebuild can add its own marker. The
 * FTS5 table it tracks is not here — drizzle cannot model a virtual table —
 * and is created by `db/index.ts` at boot instead.
 */
export const searchMeta = sqliteTable("search_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * A board on the tasks board — one kanban, owning its own columns.
 *
 * Like `tasks` below, this holds no foreign keys: an SQL cascade would take a
 * board's tasks with it silently, and deleting a column has to be a *decision*
 * (where do its tasks go?) rather than a delete. `boards.ts` cascades by hand,
 * in one transaction, so every one of those decisions is written down.
 */
export const boards = sqliteTable(
  "boards",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Palette token (`boards.ts: BOARD_COLORS`); null = neutral. */
    color: text("color"),
    /** Position in the board switcher. */
    order: integer("order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("boards_order").on(t.order)],
);

/**
 * One column on one board: a *row*, not a union member.
 *
 * This is what makes a status addable. It used to be a four-value enum repeated
 * in six places (this column, the zod schemas, the backup row, the client's
 * copy, and twice more inside the kanban's drag handlers), so "add a status"
 * meant editing every one of them and a schema push besides. A status is now a
 * row with a name the user picks, and `tasks.status_id` points at it.
 *
 * The default board's four statuses are seeded with their *legacy slugs* as ids
 * (`todo`, `in_progress`, `blocked`, `done`) — which is the whole migration:
 * every task written before boards existed already holds one of those strings
 * in `status`, so the column changes meaning without a single row being
 * rewritten. Ids minted after that are UUIDs.
 */
export const boardStatuses = sqliteTable(
  "board_statuses",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull(),
    /** What the column header reads. */
    name: text("name").notNull(),
    /** Palette token (`boards.ts: STATUS_COLORS`); null = neutral. */
    color: text("color"),
    /** Left-to-right position on the board. */
    order: integer("order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("board_statuses_board_order").on(t.boardId, t.order)],
);

/**
 * A task on the tasks board.
 *
 * Standalone: a genuinely top-level resource, not scoped to a session, project
 * or agent. The board is user-managed; wiring tasks to agent turns (the "no
 * connection between the agents and the board, initially" promise) is a later
 * step, and the schema deliberately holds no foreign keys so nothing here has
 * to be rethought when that arrives.
 *
 * `boardId` and `statusId` are the two halves of a task's position: which
 * kanban it is on, and which of *that board's* columns it sits in. Both are
 * ids into the two tables above, and both keep their original column names
 * (`board`, `status`) — the values already stored there are exactly the ids the
 * seed mints, so widening the app from one board with four fixed statuses to
 * many boards with any statuses is a pure additive push with no data rewrite.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    /** → `boards.id`. Column name predates the table. */
    boardId: text("board").notNull().default("default"),
    title: text("title").notNull(),
    /** Markdown body; null = none. */
    description: text("description"),
    /** → `board_statuses.id`, always one belonging to `boardId`. */
    statusId: text("status").notNull().default("todo"),
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
  (t) => [index("tasks_board_order").on(t.boardId, t.statusId, t.order)],
);
