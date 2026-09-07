import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

import type * as acp from "../acp.js";
import type { AutonomyPolicy } from "../autonomy.js";

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
  /** Optional URL for a model-specific icon. When set, the composer trigger
      shows this icon instead of the profile's logo. User-provided (models.dev
      does not carry per-model artwork). */
  iconUrl?: string;
  /** User-defined group label for organising models in the picker.
      Models with the same group are shown under a shared heading; models
      without a group appear at the end with no heading. */
  group?: string;
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

/**
 * How to ask a runtime for the built-in model catalog a generated one is
 * modelled on (`model-catalog.ts`).
 *
 * Same split as `QuotaProbe`, and for the same reason: `kind` picks the
 * dialect, which is code, while `command`/`args` are data — and they are
 * deliberately not the agent's own `command`, because the ACP adapter
 * (`codex-acp`) is a session and the thing that knows the catalog is the plain
 * CLI beside it.
 */
export interface CatalogProbe {
  kind: "codex-cli";
  command: string;
  args: string[];
}

/**
 * Where a runtime reads harness-projected workspace files from, inside the
 * project's cwd (`materialize.ts`).
 *
 * The harness used to write `<cwd>/.claude/{skills,commands}` for every thread
 * whatever its runtime, which meant a skill linked to a Codex thread did
 * nothing at all and a Codex-only project still grew a `.claude/` directory.
 * The layout is the runtime's fact, so it is declared with the runtime; null
 * on the agent means nothing is projected, which is an answer the UI can show
 * rather than a silence.
 */
export interface WorkspaceLayout {
  /** The directory under the project's cwd, e.g. `".claude"`. */
  dir: string;
  /** Subdirectory of `dir` holding one folder per skill, symlinked into place.
      Null/absent = this runtime has no project-level skills directory. */
  skills?: string | null;
  /** Subdirectory of `dir` holding one markdown file per command. Null/absent
      = this runtime does not read commands out of the workspace. */
  commands?: string | null;
  /** The frontmatter key a command's argument hint is written under, for a
      runtime that reads one. Absent = the hint is not written at all. */
  argumentHintKey?: string | null;
  /** Where a model allowlist is merged — a JSON file relative to `dir` and the
      key inside it. Null/absent = this runtime builds its picker some other
      way, and nothing is written. */
  modelAllowlist?: { file: string; key: string } | null;
}

/**
 * The runtime's own tools that a harness MCP server stands in for, and how the
 * runtime is told to switch them off.
 *
 * Disallowing a built-in has to travel with an allow rule for the MCP
 * namespace (see CLAUDE.md) — and both halves are runtime-shaped, so they are
 * declared here instead of being spelled out for one agent inside the bridge.
 * An agent with no entry keeps its own tools, which is what every runtime but
 * Claude Code did whether it wanted to or not.
 */
export interface BuiltinToolOverrides {
  /** The one mechanism known to work: claude-agent-acp reads `disallowedTools`
      and `allowedTools` out of `_meta.claudeCode.options`. */
  via: "acp-meta";
  /** Harness capability → the runtime's own tool names for it. */
  tools: {
    /** Replaced by the built-in web-search MCP server. */
    webSearch?: string[];
    /** Replaced by the harness's workflow MCP server. */
    workflow?: string[];
  };
}

/**
 * Where this runtime keeps configuration on this machine that the library can
 * import from (`discover.ts`). Paths are relative to the user's home, and a
 * single `*` segment expands to every immediate subdirectory (Claude Code's
 * plugin marketplaces).
 */
export interface AgentDiscovery {
  /** MCP server config files, each with the dialect it is written in. */
  mcp?: { path: string; format: "claude-json" | "codex-toml" }[];
  /** Directories holding one folder per skill. */
  skills?: string[];
  /** Directories holding one markdown file per command. */
  commands?: string[];
}

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  command: text("command").notNull(),
  args: jsonb("args").$type<string[]>().notNull(),
  env: jsonb("env").$type<Record<string, string>>().notNull(),
  /** ACP config categories this agent can only take at spawn time, mapped to
      the session field that feeds its env template. Anything not listed here
      is applied live over `session/set_config_option` instead of respawning. */
  spawnCategories: jsonb("spawn_categories")
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
  quotaProbe: jsonb("quota_probe").$type<QuotaProbe>(),
  /** Which door this runtime opens for a thread's persona (`personas.ts`):
      `"acp-meta"` = the ACP `_meta` block on session/new and session/load,
      `"env"` = a key in its own config template, filled from `{personaPrompt}`
      or `{personaFile}`. Null = no known door, and a persona is not applied. */
  personaVia: text("persona_via").$type<"acp-meta" | "env">(),
  /** Where this runtime's subagent transcripts come from when its ACP bridge
      does not carry them. `"opencode-http"` = the sidecar in
      `opencode-subagents.ts`: the process is spawned with an HTTP port and the
      server subscribes to its event bus for the children ACP drops. Null =
      whatever arrives over ACP is all there is. */
  subagentFeed: text("subagent_feed").$type<"opencode-http">(),
  /** Which door this runtime opens for a rewind's conversation half
      (`registry.ts › AgentDef.rewindVia`): `"acp-fork-point"` = `session/fork`
      with the jetbrains.air fork point. Null = rewind is not offered. */
  rewindVia: text("rewind_via").$type<"acp-fork-point">(),
  /** Whether this runtime has a workflow engine of its own. `"native"` = the
      harness's workflow MCP server is not offered to its threads, because
      handing it the lesser engine costs the better one (`sessions.ts`). Null =
      it has none, and the harness's is linked when the profile links it. */
  workflowsVia: text("workflows_via").$type<"native">(),
  /** Where this runtime reads harness-projected skills, commands and the model
      allowlist from, inside the project's cwd. Null = nothing is projected. */
  workspaceLayout: jsonb("workspace_layout").$type<WorkspaceLayout>(),
  /** The runtime's own tools a harness MCP server replaces, and how to switch
      them off. Null = its built-ins stay on beside ours. */
  builtinTools: jsonb("builtin_tools").$type<BuiltinToolOverrides>(),
  /** How to ask this runtime's plain CLI for the built-in model catalog a
      generated one is modelled on. Null = no catalog is generated for it. */
  catalogProbe: jsonb("catalog_probe").$type<CatalogProbe>(),
  /** Where this runtime's own config lives on this machine, for the library's
      import. Null = there is nothing of its to read. */
  discovery: jsonb("discovery").$type<AgentDiscovery>(),
  /** The shell line that puts this agent's binary on the machine, shown beside
      a row measured as missing (`agent-status.ts`). Null = we do not know one,
      which is the honest answer for an agent someone added. */
  install: text("install"),
  /** The row's mark: a URL (a `data:` URI for the built-ins), or the literal
      `"app"` for the harness's own runtime, whose mark is the app's own and is
      drawn in `currentColor` rather than pinned as flat art. Null = a neutral
      glyph. */
  icon: text("icon"),
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
  | "zai"
  /** MiniMax Coding Plan (`/v1/token_plan/remains`). */
  | "minimax"
  /** Moonshot Kimi For Coding (`/coding/v1/usages`). */
  | "kimi"
  /** Synthetic's flat-rate plan (`/v2/quotas`). */
  | "synthetic"
  /** DeepSeek's account balance (`/user/balance`) — no windows, credits. */
  | "deepseek"
  /** OpenRouter's key limit and credits (`/api/v1/key`, `/api/v1/credits`). */
  | "openrouter";

/** Every `kind` a profile may name, for the form's picker and for validating a
    saved profile. Adding a provider is this array, the union above, and a branch
    in `readProfileUsage` (usage-api.ts). */
export const USAGE_KINDS = [
  "none",
  "zai",
  "minimax",
  "kimi",
  "synthetic",
  "deepseek",
  "openrouter",
] as const satisfies readonly ProfileUsageKind[];

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

export const profiles = pgTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Which agents this profile can spawn, and what differs per agent (see
      ProfileAgentLink). Not foreign keys: a profile naming an agent that has
      since been removed is a broken profile the user should see and fix, not
      a row that vanishes. Replaces the old single `agent_id` column — one
      provider (credentials + catalog) serves several runtimes, and binding it
      to one forced the same key and model list to be entered once per agent. */
  agents: jsonb("agents")
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
  models: jsonb("models").$type<ModelDef[]>().notNull(),
  /** How to read this provider's subscription usage (see ProfileUsage). Null on
      rows from before the column existed, and on every profile whose provider
      meters per token — which is most of them, and is why "no usage API" is the
      default rather than something to configure. */
  usage: jsonb("usage").$type<ProfileUsage>(),
  /** Opt out of Codex's "Model metadata for `…` not found. Defaulting to
      fallback metadata" notice when this profile's models run on it (see
      model-catalog.ts). Exactly one thing it means: the profile has already
      given the model its numbers, and the nag is dropped at the bridge before
      it can be journaled. False on rows from before the column existed. */
  suppressModelMetadataWarning: boolean("suppress_model_metadata_warning")
    .notNull()
    .default(false),
  /* The web-search and knowledge opt-ins used to be columns here. They are
     library rows now (`mcp_servers.type = "builtin"`), linked like any other
     server — see BUILTIN_MCP in library.ts. */
});

export const projects = pgTable("projects", {
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

export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["http", "stdio", "builtin"] }).notNull(),
  name: text("name").notNull(),
  // builtin
  builtin: text("builtin", { enum: ["web-search", "knowledge", "workflow"] }).$type<BuiltinMcp>(),
  // http
  url: text("url"),
  headers: jsonb("headers").$type<NameValue[]>(),
  // stdio
  command: text("command"),
  args: jsonb("args").$type<string[]>(),
  env: jsonb("env").$type<NameValue[]>(),
  /** How the row authenticates. "none" is a plain URL, possibly with static
      headers the user typed (a PAT). "oauth" means the tokens are in
      `mcp_oauth` and the agent is handed the shim's URL, never this one.
      A stored answer rather than a typed one — `probeMcpAuth` sets it —
      because a spawn must not make a network call to find out what to hand
      the agent. Only ever meaningful on an `http` row. */
  auth: text("auth", { enum: ["none", "oauth"] }).notNull().default("none"),
});

/** RFC 8414 / OIDC authorization server metadata, as discovered. Stored whole
    rather than picked apart: the token and revocation endpoints, the client
    auth methods and the PKCE support are all read back out of it by the SDK's
    own helpers, so it is the SDK's type — a hand-written subset would be one
    more thing to widen every time a helper reads a field we did not copy. */
export type AuthServerMetadata = AuthorizationServerMetadata;

/**
 * One OAuth connection per `http` MCP server that demands one.
 *
 * A table of its own rather than more columns on `mcp_servers`, for three
 * reasons: the secrets are then trivially separable in `backup.ts`
 * (`secrets=0` blanks one table's three columns rather than reaching into a
 * row of mixed provenance); connecting and disconnecting is an insert and a
 * delete rather than an edit of the library row, so it never collides with
 * somebody renaming the server; and the cascade means deleting the server
 * takes the tokens with it, the same guarantee `profile_*`/`session_*` give.
 */
export const mcpOauth = pgTable("mcp_oauth", {
  mcpServerId: text("mcp_server_id")
    .primaryKey()
    .references(() => mcpServers.id, { onDelete: "cascade" }),
  /** RFC 8707 canonical resource identifier, from PRM — what the token is *for*.
      The real server's URL, never the shim's: a token minted for the proxy
      would be rejected by the upstream that has to accept it. */
  resource: text("resource").notNull(),
  /** The authorization server chosen from PRM's list, and its cached metadata. */
  issuer: text("issuer").notNull(),
  metadata: jsonb("metadata").$type<AuthServerMetadata>().notNull(),
  /** From dynamic registration (RFC 7591). There is no out-of-band client id
      for a personal tool. `clientSecret` is null for a public client. */
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret"),
  /** Registered exactly, and re-registered when the reachable base changes —
      an AS refusing a redirect it never saw is a dead end nobody can diagnose. */
  redirectUri: text("redirect_uri").notNull(),
  scope: text("scope"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  /** Unix ms. Null = no expiry was reported; treat as valid until a 401 says
      otherwise. */
  expiresAt: bigint("expires_at", { mode: "number" }),
  /** Why the last attempt failed, so the row can say so instead of going quiet. */
  lastError: text("last_error"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Directory on the server holding SKILL.md. */
  path: text("path").notNull(),
});

export const commands = pgTable("commands", {
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
export const personas = pgTable("personas", {
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

/**
 * A model prompt: instruction text assigned to a model by id or pattern, so a
 * thread running Gemini is told it is Gemini and Qwen is told what Qwen needs.
 *
 * The auto-detect half lives in the runtime (`agent/src/model-prompts.ts`): a
 * built-in calibration per model *family* that applies when no row matches.
 * These rows are the assignment half — "this text, for every model whose id
 * matches" — and win over the built-ins. `match` is a glob over the model id
 * (`gemini-2.5-pro` exact, `qwen*` family), not a foreign key into a profile's
 * catalog: the same model id runs under many profiles, and the prompt belongs
 * to the model, not to the listing.
 *
 * Delivered to the runtime as one JSON file materialized beside the database
 * (`model-prompts.ts`), which the runtime re-reads every turn — the lever a
 * live model change pulls without a respawn, unlike a persona.
 *
 * Not linked to profiles or threads: a row that matches, matches everywhere.
 */
export const modelPrompts = pgTable("model_prompts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Glob over the model id, matched case-insensitively. No `*` = exact id. */
  match: text("match").notNull(),
  /** The instruction block, appended as a layer of the agent's system prompt. */
  prompt: text("prompt").notNull(),
  /** Off is not deleted: the row stays managed but stops matching. */
  enabled: boolean("enabled").notNull().default(true),
  /** Declared order, used only to break a tie between equally specific matches. */
  sortOrder: integer("sort_order").notNull().default(0),
  /** 0 for the user's own; the seed release for a built-in. Same pair-of-versions
      bookkeeping `personas` and `agents` use, and for the same reason: without it
      a row the user deleted comes back the next time the seed list grows. */
  seededVersion: integer("seeded_version").notNull().default(0),
});

/** Server-wide single-value settings that are data rather than bootstrap
    config: user-authored, so they travel in a backup (unlike `data/config.json`,
    which exists only to boot from). One row per key. `appSettings` holds
    bootstrap-only config (see config.ts) and nothing else now — the old
    `rules` blob moved to the `rules` table below. */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** An individual standing instruction rule. Global rules (null projectId)
    apply to every thread; project-scoped rules (a projectId) apply to
    threads spawned in that project. Both layers are composed by
    `spawnRules` in rules.ts — global first, then project. Each rule
    has a title and content so they can be managed individually rather
    than as one blob of text. */
export const rules = pgTable("rules", {
  id: text("id").primaryKey(),
  /** Null = a global rule; a project id = a project-scoped rule. */
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  /** Declared order, used when composing the spawn block. */
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("rules_project").on(t.projectId)]);

/** A user-made theme, exactly as the studio edits it: the per-mode colour
    halves `light`/`dark` and the mode-independent `base` (radius, the three
    font roles, depth, tracking, blur, width — preset and font ids, never
    resolved stacks). The payload is opaque here: nothing server-side needs to
    know what a token means, only that a theme has a name and three halves.
    Rows are the source of truth for the client's custom-theme store, so a
    theme follows the account and not the browser — the gallery hydrates from
    here and the studio writes through on every change, with localStorage only
    a first-paint cache. */
export const themes = pgTable("themes", {
  /** The client's own id — the studio mints one when a theme is created and
      every gallery/editor URL names it. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  light: jsonb("light").$type<Record<string, string>>().notNull(),
  dark: jsonb("dark").$type<Record<string, string>>().notNull(),
  base: jsonb("base").$type<Record<string, string>>().notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

/** A titled knowledge-base entry, keyed to a project. The agent's `knowledge`
    MCP server reads and writes these; `project_id` scopes every query so
    nothing a workspace learns leaks into another. Search is substring `LIKE`
    (the "grep" contract — deliberately no vector index), ordered by recency.
    Titled where a bare note would have been a separate `memories` table — the
    two were the same thing, so they are one concept now. */
export const knowledge = pgTable(
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
    tags: jsonb("tags").$type<string[]>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("knowledge_project").on(t.projectId)],
);

/* The library links — MCP servers, skills, slash commands — on a profile:
   what the *provider setup* brings to every thread started on it (a gateway
   with its own MCP servers, the skills that go with a house style). A thread
   adds its own (the `session_*` tables below); the agent gets the union — see
   `SessionManager.effectiveLinks`. Projects used to carry these too and no
   longer do: a project is a directory. */
export const profileMcpServers = pgTable(
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

export const profileSkills = pgTable(
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

export const profileCommands = pgTable(
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

/* A project's helper commands — the small shell actions a person runs against
   this workspace from its page's header ("Restart server", "Run migrations").
   Not links into the library and never seen by an agent: they are the user's
   own buttons, run in the project's cwd by `project-helpers.ts` and surfaced
   by `ProjectHeader`'s dropdown. */
export const projectHelpers = pgTable(
  "project_helpers",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    command: text("command").notNull(),
    /** Project-relative directory to run in; null = the project's own cwd. */
    cwd: text("cwd"),
    /** Extra environment variables, stored as a JSON object; null = none. */
    env: text("env"),
    description: text("description"),
    /** Ask before running — for the destructive ones. */
    confirm: boolean("confirm").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("project_helpers_project").on(t.projectId)],
);

export const sessions = pgTable(
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
    /** The permission mode picked for this thread, or null for the agent's
        default. A spawn input like model and effort — and unlike them it is
        applied over `session/set_mode` right after the session exists, so a
        revive without a live process to copy from (idle-retired, pre-restart)
        puts it back from the row instead of coming back on default. Written on
        every accepted `set_mode`, not just the draft pick. */
    modeId: text("mode_id"),
    /** The persona this thread runs under, or null for none. Not a foreign key
        either, and for the same reason `parent_session_id` below is not: a row
        vanishing out from under a live thread is the manager's business, not
        SQL's. A deleted persona simply reads as "none" on the next spawn, which
        is exactly what it is. */
    personaId: text("persona_id"),
    /** True when the agent should close each answer with follow-up prompt
        suggestions in a `suggest-prompts` fenced block (`personas.ts`). On
        unless turned off. A spawn input like the persona: every runtime reads
        its instructions only when a session is created or loaded, so toggling
        it costs a respawn — see `applyConfigLive`. */
    suggestFollowups: boolean("suggest_followups")
      .notNull()
      .default(true),
    title: text("title").notNull(),
    /** The agent's own session id — what `session/load` is called with. */
    acpSessionId: text("acp_session_id"),
    /** True while `acpSessionId` is an id the agent handed out but no turn has
        committed to yet. Such an id is written down anyway — losing it is how a
        thread ends up with no pointer to anything at all — but it is the one id
        a later `session/new` is allowed to replace, and a load that refuses it
        is not a lost history, just a session the agent never flushed. */
    acpSessionProvisional: boolean("acp_session_provisional")
      .notNull()
      .default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /** Epoch ms of the last turn on this thread — what the sidebar orders by.
        Creation is not activity: a thread started weeks ago and picked up this
        morning belongs at the top, and ordering by `created_at` buried it under
        threads nothing had been said in since. Bumped once per turn (the
        journaled `turn_started`/`turn_ended`, never per streamed event), and 0
        on a row written before the column existed — `reload` backfills those
        from the journal's own `max(at)`, falling back to `created_at`. */
    lastActivityAt: bigint("last_activity_at", { mode: "number" }).notNull().default(0),
    /** The failure the newest turn ended with, or null when it ended cleanly —
        the message alone, capped, because what a list can say about a thread is
        one line. Written on the same journaled `turn_ended` that bumps
        `last_activity_at` and cleared by the next `turn_started`, so it is
        always about the *last* turn and never about a turn two ago. A
        cancelled turn is not a failure (it carries no error), and neither is a
        thread nobody has run yet. Persisted for the reason the clock beside it
        is: the sidebar draws rows for threads this client has never connected,
        and a failure only the open transcript knew about was invisible in every
        list. */
    lastTurnError: text("last_turn_error"),
    /** What the agent last reported was in its context window (ACP's
        `usage_update`), or null for a runtime that never reports one.

        Persisted for the reason `last_turn_error` above it is, and then one
        more. It is **current state, not history**: a client that folded it out
        of the replay lost it the moment the window slid past the turn that
        carried the reading, and paging older history back in (`load_earlier`)
        re-folded an *older* reading over the current one — the ring walked
        backwards for scrolling up. So the last reading is the row's, handed to
        every attaching peer on `caught_up` after the replay, and the copies in
        the journal are drawn only while they are the newest thing said.

        Written by the same turn-boundary `persist` that writes the two fields
        above, not per reading: a runtime reports twice per model request, and
        the row is one turn behind at worst — the live session answers from
        memory until then. */
    context: jsonb("context").$type<acp.UsageUpdate>(),
    /** Epoch ms this thread was deleted; null = live. Deleted threads keep
        their row (and their acpSessionId) so a delete stays undoable. */
    deletedAt: bigint("deleted_at", { mode: "number" }),
    /** The thread this one is a workflow step of (`workflows.ts`), else null.
        Indexed, and NOT a foreign key like the three above — but for a different
        reason: an SQL cascade would delete the children's rows underneath the
        manager's in-memory map (their journals, FTS rows and processes are the
        manager's to take down through `purge`), and a backup merge inserts
        sessions in bundle order, where a child may precede its parent inside the
        one transaction. `SessionManager.purge`/`softDelete`/`restore` cascade
        to children by hand. */
    parentSessionId: text("parent_session_id"),
    /* Where this thread was forked from (`SessionManager.fork`): the parent
       thread and the turn the branch carries through, else null both. Not
       foreign keys and not indexed — provenance is drawn, never queried; a
       parent that is gone reads as a chip that names a thread no longer held,
       which is what it is. Deliberately not `parent_session_id`, which means
       "workflow step of" and hides a thread from the sidebar. */
    forkedFromSessionId: text("forked_from_session_id"),
    forkedFromTurnId: text("forked_from_turn_id"),
  },
  (t) => [
    index("sessions_live").on(t.deletedAt, t.createdAt),
    index("sessions_parent").on(t.parentSessionId),
    /* Every project-scoped read starts here — the stats page asks for "the
       threads of this project" twice per call, and each of the journal, queue,
       schedule and workflow readings is keyed by the ids it returns. Without
       this the answer is a scan of the whole table before any of them begins. */
    index("sessions_project").on(t.projectId),
    /* The import dialog's "do we already hold this conversation?" is a lookup
       by the *agent's* id, not ours (`markExisting`), and it asks for a whole
       page of them at once. Not unique: two threads may legitimately point at
       one conversation (an import, then a rewind that forked it), so this
       orders the lookup without asserting anything the data does not. */
    index("sessions_acp").on(t.acpSessionId),
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
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    parentSessionId: text("parent_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["running", "paused", "completed", "failed", "cancelled"] })
      .$type<WorkflowRunStatus>()
      .notNull(),
    error: text("error"),
    steps: jsonb("steps").$type<WorkflowStepRecord[]>().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
  },
  (t) => [index("workflow_runs_parent").on(t.parentSessionId, t.createdAt)],
);

/** `paused` is a live state like `running`: the run is held (no step starts,
    pausable steps hold at their step boundary) and comes back with `resume`.
    A restart ends it exactly as it ends a running one. */
export type WorkflowRunStatus = "running" | "paused" | "completed" | "failed" | "cancelled";
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
 * Routines — a saved thread-start that fires on its own.
 *
 * `AutonomyPolicy` is imported as a type from `../autonomy.js` rather than
 * restated here (this file otherwise imports nothing but drizzle): the policy is
 * the wire shape *and* the engine's shape, and a second copy in the schema would
 * be a second thing to keep in step. `QuotaSnapshot` living in `protocol.ts` and
 * being read by `db/schema.ts`'s neighbours is the same bargain.
 */

/** What a routine's fire actually runs. A prompt, or a whole declarative
    workflow (`workflow-schema.ts`, verbatim) — the second costs almost nothing
    and is most of the point: the engine that runs phased pipelines against a
    real thread already exists, and a routine that could only ask one question
    nightly would be the weaker half of a machine already built. */
export type RoutineBody =
  | { kind: "prompt"; text: string }
  | { kind: "workflow"; definition: Record<string, unknown> };

/** What happens to a run's answer. Every one is built out of something that
    already exists, and every one is optional and plural. A failed action is
    recorded on the run and never fails the run: the work already happened. */
export type RoutineAction =
  | { kind: "push" }
  | { kind: "knowledge"; title?: string }
  | { kind: "task"; boardId?: string; statusId?: string; title?: string }
  | { kind: "routine"; routineId: string };

/** One entry of `routine_runs.actions` — what an `onFinish` action did, its
    failure included. `ref` names whatever it created (a knowledge entry's id, a
    card's id, a chained run's id) so the UI can link to it. */
export interface RoutineActionRecord {
  kind: string;
  ok: boolean;
  error?: string;
  ref?: string;
}

/** `skip` (the default) is what stops a nightly review that is still running
    from becoming two agents in one cwd; `queue` waits for the live run. */
export type RoutineOverlap = "skip" | "queue";

/**
 * A saved thread-start that fires on its own.
 *
 * Everything a `POST /api/sessions` body carries, this row stores — profile,
 * agent, project, model, effort, persona, config choices, links — because a
 * fire is literally `await manager.create(...)` with those values and then one
 * prompt. That is the constraint that keeps this small: **a routine must not be
 * able to start a thread the composer could not start.** A field a routine
 * needs and a draft does not means the draft is missing it.
 *
 * The project lives here and not on a trigger: a git trigger names a project by
 * construction, and letting a trigger override it would double the shape of the
 * fire path for a fan-out nothing asks for yet — which `routine_runs.fire_id`
 * is here to make a later feature rather than a later migration.
 *
 * None of profile/agent/project/persona is a foreign key, for the reason
 * `sessions` gives at its own three: a routine has to outlive a profile being
 * renamed away under it, and "this routine's project no longer exists" is a
 * sentence the UI can say where a vanished row is not.
 */
export const routines = pgTable(
  "routines",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    /** False = every trigger is inert. The row is kept and listed — a disabled
        routine is a state, not a deletion, and its history stays readable. */
    enabled: boolean("enabled").notNull().default(true),
    /** The workspace every run of this routine opens in. Not a foreign key: a
        deleted project must leave a routine the UI can say that about. */
    projectId: text("project_id").notNull(),
    profileId: text("profile_id").notNull(),
    agentId: text("agent_id").notNull(),
    /** "" = defer to the profile/agent, exactly as an unset draft does. */
    model: text("model").notNull().default(""),
    effort: text("effort").notNull().default(""),
    /** Null for none, like `sessions.persona_id`, and not a foreign key. */
    personaId: text("persona_id"),
    /** The draft's own picks against the agent's advertised selectors, replayed
        after `session/new` exactly as `POST /api/sessions` replays them. */
    configChoices: jsonb("config_choices")
      .$type<Record<string, string | boolean>>()
      .notNull()
      .default({}),
    /** Prompt or workflow — see RoutineBody. */
    body: jsonb("body").$type<RoutineBody>().notNull(),
    /** An optional JSON schema for the run's answer: the same field a workflow
        step takes and compiled the same way, which buys the run one repair turn
        and then a structured `routine_runs.verdict`. Null means the status stays
        honest and bare — "the turn ended" and nothing more. */
    output: jsonb("output").$type<Record<string, unknown>>(),
    onFinish: jsonb("on_finish").$type<RoutineAction[]>().notNull().default([]),
    overlap: text("overlap", { enum: ["skip", "queue"] })
      .$type<RoutineOverlap>()
      .notNull()
      .default("skip"),
    /** How this routine's runs answer the agent (see autonomy.ts). Stored whole
        rather than spread into columns: it is one policy, always read together,
        and it is the shape the form edits. */
    autonomy: jsonb("autonomy").$type<AutonomyPolicy>().notNull(),
    /** One run has completed. A routine cannot be widened to a blanket `allow`
        until it has — the difference between an informed grant and a dismissed
        dialog, and it costs exactly this boolean. */
    dryRunCompleted: boolean("dry_run_completed").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("routines_project").on(t.projectId)],
);

export type RoutineTriggerKind = "schedule" | "api" | "git";

/**
 * One way a routine fires. Several per routine, combinable, each enabled on its
 * own. The three kinds share a row because they share everything after the
 * fire: the run, the payload wrapper and the UI are identical whichever front
 * door was used, which is also why a GitHub webhook receiver is a later phase
 * and not a later table.
 */
export const routineTriggers = pgTable(
  "routine_triggers",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["schedule", "api", "git"] }).$type<RoutineTriggerKind>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // ── schedule ──
    /** 5-field cron. Null for a one-off (`at_ms`) and for the other kinds.
        UI presets write cron expressions; there is no second representation. */
    cron: text("cron"),
    /** IANA zone the cron is read in. Null = the server's own. */
    tz: text("tz"),
    /** Epoch ms of a one-off fire; null for a recurring one. */
    atMs: bigint("at_ms", { mode: "number" }),
    /** Checked at fire time, never at edit time. Today only
        `{gitChangedSince: "lastRun"}` — one HEAD read against what the last run
        recorded, which is the difference between a nightly review that reports
        on yesterday and one that says "nothing happened" thirty times. */
    condition: jsonb("condition").$type<{ gitChangedSince?: "lastRun" }>(),
    /** Epoch ms of the next fire, stagger included, recomputed after each one.
        Null when this trigger has no clock. Indexed: it is what the sweep asks. */
    nextFireAt: bigint("next_fire_at", { mode: "number" }),
    // ── api ──
    /** sha-256 of the long-lived per-trigger token, never the token. This is
        the only stored credential in the harness that STARTS A PROCESS on the
        machine — a profile's key has to be replayed verbatim to a provider and
        the key-in-path routes are per-boot and unstored — so it is held hashed
        and compared in constant time. Shown once, at mint. */
    secretHash: text("secret_hash"),
    /** When the token was minted, so the UI can say how old the credential it
        cannot show is. Null when there is none. */
    secretCreatedAt: bigint("secret_created_at", { mode: "number" }),
    // ── git ──
    /** Branch whose HEAD moving fires this, or null for "any". */
    branch: text("branch"),
    /** Path globs; a change matching any of them fires. Empty = any path. */
    paths: jsonb("paths").$type<string[]>().notNull().default([]),
    /** Debounce for the watcher, ms. */
    debounceMs: integer("debounce_ms").notNull().default(30_000),
    /** What the last evaluation recorded — the git oid a `gitChangedSince` or a
        `git` trigger compares against. Null until the first fire. */
    lastSeen: text("last_seen"),
    lastFiredAt: bigint("last_fired_at", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("routine_triggers_routine").on(t.routineId),
    index("routine_triggers_next").on(t.nextFireAt),
  ],
);

/** `blocked` is the run that fell through to `askFallback` — the state a person
    can act on, and deliberately distinct from the run that was refused
    something and carried on to say so, which is an ordinary completion.
    `skipped` is what a fire condition or the quota floor writes: not an error,
    and it does not disturb `next_fire_at`. */
export type RoutineRunStatus = "running" | "completed" | "failed" | "blocked" | "skipped";

/**
 * One run of a routine, and one real thread.
 *
 * The thread is an ordinary session with its own transcript, searchable,
 * openable and revivable — NOT a workflow step: `parent_session_id` stays null
 * (a routine has no parent thread) and this row is what names it. Like a step
 * it is retired the moment its turn settles (`onSessionDurable`), so "continue
 * this run by hand" is the ordinary revive path.
 *
 * `session_id` is **not** a foreign key, for the reason
 * `sessions.parent_session_id` is not: an SQL cascade would delete the thread's
 * row underneath the manager's in-memory map, whose journals, FTS rows and
 * process are the manager's to take down. It is also nullable — a `skipped` run
 * never made one, and neither has a `running` one that has not spawned yet.
 *
 * `fire_id` is minted per fire and shared by every run that fire produced.
 * Today that is always one, and the column looks redundant; it is here from day
 * one because the moment a routine names more than one project a fire produces
 * N runs, and adding the grouping afterwards is a data rewrite of the one table
 * this feature accumulates rows in fastest.
 */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    /** Which trigger fired it, when one did. Not a foreign key and nullable: a
        deleted trigger must not take the run history it produced with it. */
    triggerId: text("trigger_id"),
    fireId: text("fire_id").notNull(),
    sessionId: text("session_id"),
    /** Which door fired it, and the caller's own words if it brought any. The
        text is NEVER parsed and never interpolated: it reaches the agent inside
        the untrusted wrapper (`FIRE_PAYLOAD_OPEN`/`_CLOSE` in routines.ts). */
    source: text("source", { enum: ["schedule", "api", "git", "manual", "routine"] }).notNull(),
    payload: text("payload"),
    /** True for a "Run now, forced to ask" — what clears `dry_run_completed`'s
        gate, and what makes a run's own autonomy differ from the routine's. */
    dryRun: boolean("dry_run").notNull().default(false),
    status: text("status", { enum: ["running", "completed", "failed", "blocked", "skipped"] })
      .$type<RoutineRunStatus>()
      .notNull(),
    /** Why a `skipped` run was skipped, why a `blocked` one is blocked, or why a
        failed one failed. One column and not three: they are the same sentence
        to the same reader, and two would only raise the question of which to
        show. */
    error: text("error"),
    /** The run's final prose, accumulated from `agent_message_chunk`s the way
        workflows.ts does it and capped at LIMITS.outputBytes. */
    output: text("output"),
    /** The parsed, validated answer when the routine declared an `output`
        schema — the only thing on the row that is about the *work* rather than
        about the process, which is why it and not `status` is the list column. */
    verdict: jsonb("verdict").$type<unknown>(),
    /** What `onFinish` did, one entry per action, failures included. An action's
        failure is recorded and never fails the run. */
    actions: jsonb("actions")
      .$type<RoutineActionRecord[]>()
      .notNull()
      .default([]),
    /** The git oid this run saw, for the next `gitChangedSince` comparison. */
    headOid: text("head_oid"),
    /** Summed from the run's settled turns, for `maxRunTokens` and the digest. */
    tokens: integer("tokens"),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
  },
  (t) => [
    index("routine_runs_routine").on(t.routineId, t.startedAt),
    index("routine_runs_fire").on(t.fireId),
  ],
);

/** A routine's library links — the third owner `db/links.ts` predicted, and a
    descriptor there rather than a third copy of the queries. Same shape as
    `session_mcp_servers` down to the cascades. */
export const routineMcpServers = pgTable(
  "routine_mcp_servers",
  {
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    mcpServerId: text("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.routineId, t.mcpServerId] })],
);

export const routineSkills = pgTable(
  "routine_skills",
  {
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.routineId, t.skillId] })],
);

export const routineCommands = pgTable(
  "routine_commands",
  {
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    commandId: text("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.routineId, t.commandId] })],
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
/* And on a thread: what this one conversation was started with, on top of
   its profile's. Picked on the draft, kept for the thread's
   life so a revive spawns the same tools, and cascaded away with the row. */
export const sessionMcpServers = pgTable(
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

export const sessionSkills = pgTable(
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

export const sessionCommands = pgTable(
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

export const sessionEvents = pgTable(
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
    payload: jsonb("payload").$type<unknown>().notNull(),
    /** Epoch ms this event was journaled. The log outlives its process now, so
        something has to say how old an archive is — this is what the retention
        sweep reads (`SessionManager.pruneJournals`). Defaulted in SQL rather
        than left nullable so the column can be added to a table that already
        has rows in it. */
    at: bigint("at", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    uniqueIndex("session_events_seq").on(t.sessionId, t.seq),
    /**
     * The turn boundaries, on their own.
     *
     * Every structural read of this table asks the same question — where do
     * this session's turns begin — and none of them cares about anything else
     * in it: `turnCount`, `turnStartAt`, `countTurnsBefore`, `turnStartsBefore`
     * and the byte pass in `windowStart`. On the (session_id, seq) index that
     * is a scan of every row of the session to find the sixty that are turns,
     * and a single attach asks it four times (three inside `windowStart`, once
     * more for `earlier`), as does every `load_earlier` page. A long thread is
     * hundreds of thousands of rows, and the rows are the large ones — a scan
     * reads the terminal output and the diffs it is skipping past.
     *
     * Partial, because `kind = 'turn_started'` is the only predicate any of
     * them uses: the index holds one entry per turn rather than one per event,
     * so it stays a page or two however long the thread gets, and the lookups
     * become index-only. SQLite uses a partial index only where the query's
     * WHERE provably implies the index's, which is why every one of those
     * callers spells the equality out rather than filtering in JS.
     */
    index("session_events_turns")
      .on(t.sessionId, t.seq)
      .where(sql`kind = 'turn_started'`),
    /**
     * `at`, beside the session it belongs to.
     *
     * "When was this log last written to" is asked by three separate readers —
     * the boot backfill in `reload`, the retention sweep's `prune`, and the
     * project page's `lastActivityAt` — and `at` was in no index at all, so
     * every one of them was `max(at)`: a walk of the (session_id, seq) index
     * that had to fetch each row from the table to read the one integer it
     * wanted. On this install that is 1.08M row lookups across 550MB of
     * payloads to answer a question about 466 numbers — 480ms warm, and a
     * project page pays it on every open and every Refresh.
     *
     * With `at` in the index the same questions are index-only and never touch
     * a payload: the per-project read drops to ~2ms and the grouped scans read
     * a 54MB index instead of the whole table. It does not disturb the replay
     * plan, which still takes (session_id, seq) — the two are checked together
     * because a second index on a hot table is only free if the planner keeps
     * choosing right, and `PRAGMA optimize` in `db/index.ts` is what keeps it
     * choosing on stats rather than on guesses.
     */
    index("session_events_activity").on(t.sessionId, t.at),
  ],
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
export const webSearchUsage = pgTable(
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
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("web_search_usage_call").on(t.sessionId, t.toolCallId),
    index("web_search_usage_started").on(t.startedAt),
  ],
);

/* The `history_checkpoints` / `history_branches` tables lived here until the
   checkpoint controller was deleted; migration 0027 drops them. */

/**
 * Every prompt the user has actually sent, newest read first — the composer's
 * own history (`composer-history.ts`).
 *
 * Global on purpose, and that is the whole point of the table. Recall used to
 * be the transcript of the thread you were standing in, which meant the
 * sentence you wrote an hour ago was unreachable from the thread you are in
 * now — the hand that types is the same in every thread, and so is the phrase
 * it keeps re-typing. One list per server, like `notifications`: there is one
 * bearer token and one human behind it, so a second device recalling what the
 * first one sent is the feature, not a leak.
 *
 * `session_id`/`project_id` are plain ids for provenance — what the history
 * panel says a line came from — and deliberately not foreign keys: deleting a
 * thread must not delete the words that were typed into it, which are the
 * user's and outlive it. `text` is what was *typed*, before paste tokens are
 * expanded (composer.tsx expands at the last moment), so recalling a line puts
 * the same short token back in the box rather than the document behind it.
 */
export const composerHistory = pgTable(
  "composer_history",
  {
    id: text("id").primaryKey(),
    /** The prompt as it was typed. Never empty — an attachment-only send has
        nothing to recall and is not recorded. */
    text: text("text").notNull(),
    /** Where it was sent from, for the panel's subtitle. Null once nothing
        knows (a send from a surface with no thread). */
    sessionId: text("session_id"),
    /** Snapshotted like `notifications.threadTitle`, so a line stays
        intelligible after its thread is deleted. */
    threadTitle: text("thread_title"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("composer_history_created").on(t.createdAt),
    /** The newest row carrying a given text — what the insert reads to collapse
        a repeat instead of writing it twice. */
    index("composer_history_text").on(t.text),
  ],
);

export const pushTokens = pgTable("push_tokens", {
  token: text("token").primaryKey(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

/**
 * The harness's own saved notification (`notifications.ts`), the durable inbox
 * the client's notification pill reads. The four things the server already
 * surfaces to a device as FCM push — a turn finished, a turn failed, the agent
 * wants permission, the agent asked a question — are recorded here too, so a
 * client sees them even when FCM is not configured and after the push was
 * dismissed. Read/unread is device-independent (it is "has anyone looked at
 * this"), and `read` is set on the user's behalf by `markRead`.
 *
 * Fields are snapshotted (`title`, `body`, `threadTitle`) the way
 * `web_search_usage` names are, so a notification stays intelligible after a
 * thread is deleted. `session_id` is a plain id for navigation, not a foreign
 * key: nothing here should take a thread down with it.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    /** One of the kinds `notifications.ts` knows how to label and tint. Spelled
        as an enum here rather than bare text so the one place that has to agree
        with it — the backup bundle's row schema — is checked by the compiler
        instead of at import time, where a bad kind is a rolled-back restore. */
    kind: text("kind", { enum: ["permission", "question", "turn_finished", "turn_failed"] }).notNull(),
    /** The thread the notice is about — what a click navigates to. Null for a
        notice with no thread (none today, kept for the future). */
    sessionId: text("session_id"),
    threadTitle: text("thread_title"),
    /** The notice's own line — the error message, the tool wanting permission. */
    body: text("body"),
    /** 1 once a client has marked it read; unread is what the pill counts. */
    read: boolean("read").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("notifications_created").on(t.createdAt),
    index("notifications_unread").on(t.read, t.createdAt),
  ],
);

/**
 * What a profile's agent answered when we asked it what it can be configured
 * with (see probe.ts). Cached because the only way to ask is to spawn the agent
 * and throw it away, and the answer changes only when the agent or the cwd does.
 */
export const agentOptions = pgTable("agent_options", {
  /** `profileId:agentId:cwd` — cwd is in the key because it changes the answer. */
  key: text("key").primaryKey(),
  options: jsonb("options").$type<unknown>().notNull(),
  probedAt: bigint("probed_at", { mode: "number" }).notNull(),
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
export const agentQuota = pgTable("agent_quota", {
  /** `profileId:agentId`. */
  key: text("key").primaryKey(),
  snapshot: jsonb("snapshot").$type<unknown>().notNull(),
  fetchedAt: bigint("fetched_at", { mode: "number" }).notNull(),
});

/**
 * A scheduled message: send `text` to `session_id`'s agent at `nextAt`, then
 * again every `every_ms` until cancelled. The server owns delivery — a browser
 * tab closing must not be what stops a scheduled turn — which is why it is a
 * row here rather than a timer in the client. `every_ms` is null for a one-shot:
 * it fires once and the row is gone, where a recurring row is kept and advanced.
 */
export const scheduledMessages = pgTable(
  "scheduled_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** Epoch ms of the next scheduled fire. */
    nextAt: bigint("next_at", { mode: "number" }).notNull(),
    /** Recurrence interval in ms; null = one-shot. */
    everyMs: integer("every_ms"),
    /** 1 = the sweep delivers it; 0 = paused (kept, skipped). Integer rather
        than boolean mode so the API shape is explicit about what is stored. */
    enabled: integer("enabled").notNull().default(1),
    /** Epoch ms of the last sweep that could not deliver (missing/trashed
        thread); null once a delivery succeeds or the row is edited. */
    skippedAt: bigint("skipped_at", { mode: "number" }),
    /** Why the last skip happened, for GET /api/scheduled. */
    lastError: text("last_error"),
    /** Consecutive skips. Past MAX_SCHEDULE_SKIPS the sweep stops selecting
        the row instead of re-matching it every 15s forever; any PATCH resets. */
    skipCount: integer("skip_count").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
export const sessionQueue = pgTable(
  "session_queue",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    /** The attachments this queued message carries, as a JSON array of
        `attachments.id`. A queued message with an image has to survive a tab
        closing and a server restart like every other queued message, and the
        bytes are already on disk under a row — the queue only needs the
        pointer. Null for every row written before attachments existed, which
        is what makes this a pure add. */
    attachmentIds: jsonb("attachment_ids").$type<string[]>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("session_queue_order").on(t.sessionId, t.position)],
);

/**
 * What a turn did to the project's working tree — as git saw it, not as the
 * agent reported it.
 *
 * Two tree objects are written into the repository's object store around each
 * turn (`git.snapshotTree`: the whole worktree, untracked files included, via
 * a scratch index that never touches the real one). `start_tree` is taken on
 * `turn_started`, `end_tree` on `turn_ended`, and `files` is the diff between
 * them summarised once so the transcript can draw "3 files changed" without
 * running git per row. A `sed` in a shell, a script the agent ran and an edit
 * tool all land here the same way, which is the point: the transcript's tool
 * calls only know about the edits a tool declared. The review panel reads the
 * hunks live from the two trees (or from `start_tree` to the worktree while
 * the turn is still running). Dangling trees are gc'd by git eventually, and
 * a turn whose trees are gone reads as "unavailable", never as a crash.
 */
export const sessionTurnChanges = pgTable(
  "session_turn_changes",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    startTree: text("start_tree"),
    endTree: text("end_tree"),
    files: jsonb("files").$type<ChangedFile[]>().notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.turnId] })],
);

/** One entry of `session_turn_changes.files` (protocol.ts re-exports it). */
export interface ChangedFile {
  /** Repo-relative, POSIX. For a rename, the new name. */
  path: string;
  from?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * An uploaded file, waiting to be — or already — referenced by a prompt.
 *
 * Bytes live once on disk at `data/attachments/<id>`; this row is everything
 * else anybody needs (`AttachmentRef` in protocol.ts is a strict subset of it).
 * Nothing that travels — the journal, the queue row, the client store — carries
 * the bytes: a 6MB base64 image journaled into `session_events` is a frame held
 * whole as a string on both ends of every replay, forever, of a thread whose
 * transcript is otherwise a few hundred bytes per event.
 *
 * `session_id` is **not** a foreign key, for the reason `sessions.parent_session_id`
 * is not: a row is created before any session exists (threads start as drafts
 * and `POST /api/sessions` is deliberately not called until the first message,
 * so an upload route scoped to a session id would 404 on exactly the composer
 * that needs it most), and an SQL cascade would take the file's row out from
 * under the manager that still owns the bytes on disk. `softDelete`/`purge`
 * delete the rows and the files by hand.
 *
 * So an attachment is owned by nobody at upload time and **claimed** by the
 * prompt that references it; unclaimed rows are swept after a day, because an
 * upload whose prompt was never sent is a draft the user abandoned and keeping
 * it forever is a disk leak with no reader.
 *
 * `sha256` has a reader: `POST /api/attachments` is idempotent on content, so a
 * retry after a failed upload is free and the same screenshot dropped into five
 * threads costs one file. Rows stay one per claim — a claim is a thread's, a
 * file is content's — so the sweep deletes bytes only when no row still
 * references that hash.
 */
export const attachments = pgTable(
  "attachments",
  {
    /** Client-minted UUID, like a session id. */
    id: text("id").primaryKey(),
    /** NULL until claimed by a prompt. Not a foreign key — see above. */
    sessionId: text("session_id"),
    /** The user's filename, for display only — never used as a path. */
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    claimedAt: bigint("claimed_at", { mode: "number" }),
  },
  (t) => [index("attachments_session").on(t.sessionId), index("attachments_sha").on(t.sha256)],
);

/**
 * One-row bookkeeping for the boot-time backfill of the search index
 * (`search.ts`), keyed so a future index rebuild can add its own marker. The
 * FTS5 table it tracks is not here — drizzle cannot model a virtual table —
 * and is created by `db/index.ts` at boot instead.
 */
export const searchMeta = pgTable("search_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/* ── Tasks ──
 * A Jira/ClickUp-shaped task workspace: a board is a project of work with its
 * own key, columns, sprints, saved views and custom fields; a task is one
 * numbered item on it with a type, an optional parent (epic or task), a
 * checklist, comments, an activity log and links to other tasks.
 *
 * No foreign keys anywhere in this group, on purpose: an SQL cascade would
 * take a board's tasks with it silently, and deleting a column has to be a
 * *decision* (where do its tasks go?) rather than a delete. `boards.ts` and
 * `tasks-board.ts` cascade by hand, in one transaction, so every one of those
 * decisions is written down. Every column added since the first cut has a
 * default, so the change is a pure additive push with no data rewrite.
 */

/** A custom field a board declares; a task stores its value in `tasks.custom`
    keyed by the field's id. `options` is only read for `select`. */
export interface CustomFieldDef {
  id: string;
  name: string;
  type: "text" | "number" | "select" | "date" | "checkbox" | "url";
  options?: string[];
}

/** One checklist item on a task. */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/**
 * A board — one project of work, owning its columns, sprints, lists and views.
 *
 * `key` is the prefix of every task key on it (`DAE-42`); `nextNumber` is the
 * counter that mints the number, bumped inside the create transaction so two
 * creates can never share one. `projectId` is a pointer at `projects.id` and
 * nothing more — a project's deletion leaves the board standing, unlinked.
 */
export const boards = pgTable(
  "boards",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Uppercase 2–6 letter prefix of task keys. */
    key: text("key").notNull().default("TASK"),
    description: text("description"),
    /** → `projects.id`, or null for a board that belongs to no project. */
    projectId: text("project_id"),
    /** Palette token (`boards.ts: BOARD_COLORS`); null = neutral. */
    color: text("color"),
    /** Position in the board switcher. */
    order: integer("order").notNull().default(0),
    /** Per-board task counter — the next task gets this number. */
    nextNumber: integer("next_number").notNull().default(1),
    /** Field definitions a task on this board may carry values for. */
    customFields: jsonb("custom_fields")
      .$type<CustomFieldDef[]>()
      .notNull()
      .default([]),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
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
 * `category` is what the harness knows about a column beyond its name: a task
 * entering a `done` column is completed (its `completedAt` is stamped), and a
 * sprint's burndown counts by it. `wipLimit` is advisory — the board shows a
 * column over it, nothing refuses the move.
 *
 * The default board's four statuses are seeded with their *legacy slugs* as ids
 * (`todo`, `in_progress`, `blocked`, `done`) — which is the whole migration:
 * every task written before boards existed already holds one of those strings
 * in `status`, so the column changes meaning without a single row being
 * rewritten. Ids minted after that are UUIDs.
 */
export const boardStatuses = pgTable(
  "board_statuses",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull(),
    name: text("name").notNull(),
    /** Palette token (`boards.ts: STATUS_COLORS`); null = neutral. */
    color: text("color"),
    category: text("category", { enum: ["todo", "in_progress", "done"] })
      .notNull()
      .default("todo"),
    /** Work-in-progress limit; null = none. */
    wipLimit: integer("wip_limit"),
    /** Left-to-right position on the board. */
    order: integer("order").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("board_statuses_board_order").on(t.boardId, t.order)],
);

/**
 * A sprint: a named, dated window of a board's work. `state` moves
 * planned → active → closed; a board has at most one active sprint, and closing
 * one moves its unfinished tasks to wherever the closer said (backlog or the
 * next sprint) — `boards.ts: completeSprint`.
 */
export const sprints = pgTable(
  "sprints",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull(),
    name: text("name").notNull(),
    goal: text("goal"),
    startAt: bigint("start_at", { mode: "number" }),
    endAt: bigint("end_at", { mode: "number" }),
    state: text("state", { enum: ["planned", "active", "closed"] })
      .notNull()
      .default("planned"),
    order: integer("order").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("sprints_board_order").on(t.boardId, t.order)],
);

/** What a saved view remembers: which layout, and the filter/group/sort the
    page was showing when it was saved. Free-form so a new filter is not a
    schema push; the client validates what it reads. */
export interface BoardViewConfig {
  filters?: Record<string, unknown>;
  groupBy?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /** Table view: which columns, in order. */
  columns?: string[];
}

/** A saved view on a board — a layout plus the filters it was saved with. */
export const boardViews = pgTable(
  "board_views",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["board", "list", "table", "calendar", "timeline"] })
      .notNull()
      .default("board"),
    config: jsonb("config").$type<BoardViewConfig>().notNull().default({}),
    order: integer("order").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("board_views_board_order").on(t.boardId, t.order)],
);

/**
 * A list within a board — the ClickUp-style grouping between a board and its
 * tasks. A board owns many lists; a task optionally belongs to one. Lists
 * provide the collapsible sections that list view draws and that the board
 * rail shows as a tree under each board. Null listId = "unlisted" (backlog).
 */
export const boardLists = pgTable(
  "board_lists",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    order: integer("order").notNull().default(0),
    /** An optional folder/group heading above this list. */
    group: text("group"),
    collapsed: boolean("collapsed").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("board_lists_board_order").on(t.boardId, t.order)],
);

/**
 * A task on a board.
 *
 * Standalone: a genuinely top-level resource, not scoped to a session or
 * agent. `boardId` and `statusId` are the two halves of a task's position:
 * which board it is on, and which of *that board's* columns it sits in. Both
 * keep their original column names (`board`, `status`) — the values already
 * stored there are exactly the ids the seed mints.
 *
 * `number` with the board's `key` is the task's human key. `parentId` makes
 * the tree: an epic's children, or a task's subtasks — one column, read either
 * way by the parent's `type`. `completedAt` is stamped when the task enters a
 * `done`-category column and cleared when it leaves one.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    /** → `boards.id`. Column name predates the table. */
    boardId: text("board").notNull().default("default"),
    /** → `board_lists.id`; null = unlisted (backlog). */
    listId: text("list_id"),
    /** Per-board sequence; null on rows written before keys existed (backfilled at
        boot). Nullable on purpose, like `archived`: drizzle-kit reads a NOT NULL
        column whose default is `0`/`false` as having no default and plans a
        `delete from tasks` before adding it to a populated table — a nullable
        column is a plain ALTER with no data-loss path. */
    number: integer("number"),
    type: text("type", { enum: ["task", "bug", "story", "epic"] })
      .notNull()
      .default("task"),
    title: text("title").notNull(),
    /** Markdown body; null = none. */
    description: text("description"),
    /** → `board_statuses.id`, always one belonging to `boardId`. */
    statusId: text("status").notNull().default("todo"),
    priority: text("priority", { enum: ["lowest", "low", "medium", "high", "urgent"] })
      .notNull()
      .default("medium"),
    /** Free text tag names, stored as a JSON string-array. */
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    /** Legacy single assignee; kept for backward compatibility. */
    assignee: text("assignee"),
    /** ClickUp-style multi-assignee list; `assignee` is the first entry. */
    assignees: jsonb("assignees").$type<string[]>().notNull().default([]),
    /** → `tasks.id` of the epic or parent task; null = top level. */
    parentId: text("parent_id"),
    /** → `sprints.id`; null = backlog. */
    sprintId: text("sprint_id"),
    /** Story points / effort estimate; null = unestimated. */
    estimate: integer("estimate"),
    /** Time estimate in minutes; null = none. */
    timeEstimate: integer("time_estimate"),
    /** Time tracked in minutes; null = none. Updated by the timer widget. */
    timeTracked: integer("time_tracked"),
    /** Epoch ms planned start; null = none. Timeline draws start→due. */
    startAt: bigint("start_at", { mode: "number" }),
    /** Epoch ms due timestamp; null = no due date. */
    dueAt: bigint("due_at", { mode: "number" }),
    /** Epoch ms the task entered a done column; null = open. */
    completedAt: bigint("completed_at", { mode: "number" }),
    /** Archived tasks are hidden from every view unless asked for. Null reads
        as false — see `number` for why it is nullable. */
    archived: boolean("archived"),
    checklist: jsonb("checklist").$type<ChecklistItem[]>().notNull().default([]),
    /** Custom field values keyed by `CustomFieldDef.id`. */
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    /** Sticky note for within-column ordering on the kanban. */
    note: text("note"),
    /** Position within the column, for a stable manual order. */
    order: integer("order").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("tasks_board_order").on(t.boardId, t.statusId, t.order),
    index("tasks_board_number").on(t.boardId, t.number),
    index("tasks_parent").on(t.parentId),
    index("tasks_list").on(t.listId),
  ],
);

/** A comment on a task. `author` is free text, like `assignee`. */
export const taskComments = pgTable(
  "task_comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    body: text("body").notNull(),
    author: text("author"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("task_comments_task").on(t.taskId, t.createdAt)],
);

/**
 * One field change on a task. Written by `updateTask` for every field that
 * actually changed, plus `created`, `commented`, `linked` and `archived`
 * markers, so the detail panel can show a history without diffing rows.
 */
export const taskActivity = pgTable(
  "task_activity",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    at: bigint("at", { mode: "number" }).notNull(),
    field: text("field").notNull(),
    from: jsonb("from").$type<unknown>(),
    to: jsonb("to").$type<unknown>(),
  },
  (t) => [index("task_activity_task").on(t.taskId, t.at)],
);

/** A directed relation between two tasks: `from` blocks / relates to /
    duplicates `to`. `relates` is read symmetrically. */
export const taskLinks = pgTable(
  "task_links",
  {
    id: text("id").primaryKey(),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    kind: text("kind", { enum: ["blocks", "relates", "duplicates"] })
      .notNull()
      .default("relates"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("task_links_from").on(t.fromId), index("task_links_to").on(t.toId)],
);
