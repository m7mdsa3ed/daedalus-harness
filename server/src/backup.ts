import { and, eq, getTableColumns, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { commandFromPrompt } from "./legacy-prompts.js";
import { routineFromScheduled } from "./scheduled-migration.js";
import {
  agentOptions as agentOptionsTable,
  USAGE_KINDS,
  agents as agentsTable,
  appSettings as appSettingsTable,
  commands as commandsTable,
  db,
  knowledge as knowledgeTable,
  mcpOauth as mcpOauthTable,
  mcpServers as mcpServersTable,
  modelPrompts as modelPromptsTable,
  personas as personasTable,
  notifications as notificationsTable,
  composerHistory as composerHistoryTable,
  profiles as profilesTable,
  projectHelpers as projectHelpersTable,
  projectSpaces as projectSpacesTable,
  projects as projectsTable,
  pushTokens as pushTokensTable,
  routineRuns as routineRunsTable,
  routineTriggers as routineTriggersTable,
  routines as routinesTable,
  sessionEvents as eventsTable,
  sessionQueue as queueTable,
  sessions as sessionsTable,
  skills as skillsTable,
  spaces as spacesTable,
  boards as boardsTable,
  boardViews as boardViewsTable,
  boardLists as boardListsTable,
  type BoardViewConfig,
  sprints as sprintsTable,
  taskActivity as taskActivityTable,
  taskComments as taskCommentsTable,
  taskLinks as taskLinksTable,
  boardStatuses as boardStatusesTable,
  tasks as tasksTable,
  webSearchUsage as usageTable,
  wfEvents as wfEventsTable,
  wfRuns as wfRunsTable,
  wfSaved as wfSavedTable,
  rules as rulesTable,
  modelRoles as modelRolesTable,
  voiceProviders as voiceTable,
  themes as themesTable,
  type NameValue,
  type RoutineBody,
} from "./db/index.js";
import type { AutonomyPolicy } from "./autonomy.js";
import { SESSION_LINKS, emptyLinks, readLinks, writeLinks, type LinkSet, type Tx } from "./db/links.js";
/* A project's start defaults are folded into the row on the wire and written
   back through the same mapping the route uses, so the bundle and the API
   cannot disagree about which column a field lives in. */
import { projectDefaultsColumns, projectDefaultsOf, withoutDefaults } from "./projects.js";
import { suggestKindsOf } from "./personas.js";
/* The routine link descriptor lives with the engine rather than in db/links.ts
   — see the note there. It is imported for its links exactly as
   SESSION_LINKS is used above. */
import { ROUTINE_LINKS } from "./routines.js";
import { readWebSearch, saveWebSearch, type WebSearchConfig } from "./config.js";
import { writeModelPromptsLibrary } from "./model-prompts.js";
import { ensureDefaultBoard, reconcileTaskStatuses } from "./boards.js";

/*
 * Export / import of everything the harness stores.
 *
 * One JSON document — the `Bundle` below — carries every table in
 * `db/schema.ts` that is the user's data, plus the one config.json block that
 * is (the web-search backend). What it deliberately leaves out:
 *
 *   - `config.json`'s token, host and port — bootstrap for THIS server; a
 *     restore onto another machine must not adopt the first one's bind address,
 *     and the token is what the person restoring already holds.
 *   - `agent_options` — a probe cache keyed by cwd, regenerated on demand.
 *
 * Secrets are opt-out, not opt-in, because a backup that loses its credentials
 * is half a backup: `includeSecrets: false` blanks a profile's `apiKey`, every
 * MCP header/env value and the web-search token. On import, a blank where the
 * install already holds a value keeps the value, so a redacted bundle merged
 * over the install it came from is a no-op for the secrets.
 *
 * Thread transcripts (`session_events`) are the bulk of any install, so they
 * are a second opt-out (`includeJournals`). Without them a thread still comes
 * back — the conversation lives in the agent's own store and `session/load`
 * is what revives it — it just cannot be *read* without reviving.
 *
 * Import runs in ONE transaction: a half-imported install would be worse than
 * either outcome. `merge` upserts by id and leaves everything else alone;
 * `replace` empties every table first. The caller (index.ts) is responsible
 * for the live processes — a session row rewritten under a running agent is a
 * race — which is why `SessionManager.retireAll` / `reload` exist.
 */

export const BUNDLE_FORMAT = "daedalus-backup";
export const BUNDLE_VERSION = 1;

const nameValues = z.array(z.object({ name: z.string(), value: z.string() }));
const str = z.string();
const optStr = z.string().nullish();
const int = z.number().int();
const json = z.unknown();

/* Row schemas. Each mirrors a table's insert shape with the nullable/defaulted
   columns optional, so a bundle from a slightly older release still parses;
   unknown keys are stripped (zod's default) so a slightly NEWER one does too. */
const AgentRow = z.object({
  id: str.min(1),
  name: str,
  command: str,
  args: z.array(str).default([]),
  env: z.record(str, str).default({}),
  spawnCategories: z.record(str, z.enum(["model", "effort"])).nullish(),
  /* Carried, because a restored row keeps its `seededVersion` and so is never
     backfilled again: an agent that came back without this would quietly go
     back to restarting for every model change. */
  liveConfig: z.enum(["acp", "gateway"]).nullish(),
  /* Carried for the same reason, and it is the user's besides: the command is
     editable, so a restored row that dropped it would silently stop reporting
     plan usage with no backfill left to put it back. The *reading* is not
     carried — `agent_quota` is a cache, and a percentage restored onto another
     machine describes an account that machine may not even be logged into. */
  quotaProbe: z
    .object({
      kind: z.enum(["claude-cli", "codex-app-server"]),
      command: str,
      args: z.array(str).default([]),
      login: z.object({ dirEnv: str, dir: str, file: str, expiresAt: str }).nullish(),
    })
    .nullish(),
  /* Carried for the third time and the same reason: a restored row keeps its
     `seededVersion`, so nothing would ever backfill the door a persona reaches
     this agent through, and every thread's persona would silently do nothing. */
  personaVia: z.enum(["acp-meta", "air-meta", "env", "acp-system-prompt"]).nullish(),
  sharedProcess: z.enum(["acp-meta"]).nullish(),
  /* Carried for the same reason as the three above: a restored row keeps its
     `seededVersion`, so nothing would backfill the built-in server its runtime
     cannot do without, and every thread of it would silently lose the ability
     to delegate. */
  requiredMcp: z.array(str).nullish(),
  seededVersion: int.default(0),
});

const ModelRow = z.object({
  id: str.min(1),
  label: str,
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  reasoningEfforts: z.array(str).default([]),
  description: str.optional(),
  pricing: z.object({ input: z.number(), output: z.number() }).optional(),
  // A schedule the user wrote, so a bundle carries it — see `peak.ts`.
  peak: z
    .object({
      windows: str,
      when: z.enum(["peak", "off-peak"]).optional(),
      multiplier: z.number().optional(),
    })
    .optional(),
  modalities: z.array(str).optional(),
  devRef: str.optional(),
  // The model's own mark and its picker group: both user-written, like the
  // price above, so a bundle carries them.
  iconUrl: str.optional(),
  group: str.optional(),
});

const ProfileRow = z.object({
  id: str.min(1),
  name: str,
  agents: z.record(str, z.object({ baseUrl: str.optional(), protocol: z.enum(["openai", "anthropic"]).optional() })).default({}),
  baseUrl: str.default(""),
  /** Absent = redacted on export; "" is also read as "nothing to say". */
  apiKey: str.optional(),
  defaultModel: str.default(""),
  smallModel: optStr,
  logoUrl: optStr,
  /** Which provider API reads this profile's plan (usage-api.ts). Carried
      because it is configuration the user wrote, not a reading — the readings
      in `agent_quota` are left out for the reason the probe cache is. Its
      `apiKey` is blanked by `secrets=0` like every other credential. */
  usage: z
    .object({ kind: z.enum(USAGE_KINDS), baseUrl: optStr, apiKey: optStr })
    .nullish(),
  upstreamTimeoutSeconds: z.number().int().nullish(),
  /** Extra headers the gateway shim sends upstream for this profile
      (profiles.headers). Configuration the user wrote, so it travels — and
      declared here or Zod strips it and the profile restores without the
      header its provider insists on. */
  headers: z.array(z.object({ name: str, value: str })).nullish(),
  models: z.array(ModelRow).default([]),
  /** Absent in a bundle written before the flag existed, which reads as
      shown — the safe default for a profile a bundle would otherwise
      silently keep out of every picker. */
  hidden: z.boolean().optional(),
  /** Optional like `hidden` so an old bundle's `disabled: true` restores as
      exactly that — disabled — rather than being dropped by a rename. */
  disabled: z.boolean().optional(),
  voiceProvider: optStr,
  // Older bundles may still carry profile links; accepted and ignored.
  mcpServerIds: z.array(str).default([]).optional(),
  skillIds: z.array(str).default([]).optional(),
  commandIds: z.array(str).default([]).optional(),
});

const McpServerRow = z.object({
  id: str.min(1),
  type: z.enum(["http", "stdio", "builtin"]),
  name: str,
  logoUrl: optStr,
  /* `workflow` is accepted and then dropped on import: the row was retired when
     its three tools moved under the `agents` server, so a bundle written before
     that carries a library entry this install can no longer have. Reading it is
     the difference between an old backup restoring and an old backup failing. */
  builtin: z.enum(["web-search", "knowledge", "workflow", "agents", "harness"]).nullish(),
  /** Absent in a bundle written before OAuth existed, which read as "none". */
  auth: z.enum(["none", "oauth"]).default("none"),
  url: optStr,
  headers: nameValues.nullish(),
  command: optStr,
  args: z.array(str).nullish(),
  env: nameValues.nullish(),
});

/** The OAuth connection behind an `http` MCP server. Its three secrets follow
    the same bargain a profile's key does under `secrets=0`: blanked to "", and
    a blank on import keeps whatever the install already holds — so a redacted
    bundle merged over its own install changes nothing. The registration
    (client id, redirect URI, discovered metadata) is not a secret and always
    travels; a restored row on another machine keeps it, and the first 401
    through the shim is what discovers the redirect URI no longer matches,
    which is the same recovery path a revoked token takes. */
const McpOauthRow = z.object({
  mcpServerId: str.min(1),
  resource: str,
  issuer: str,
  metadata: z.record(z.string(), z.unknown()),
  clientId: str,
  clientSecret: optStr,
  redirectUri: str,
  scope: optStr,
  accessToken: optStr,
  refreshToken: optStr,
  expiresAt: int.nullish(),
  lastError: optStr,
  updatedAt: int,
});

const SkillRow = z.object({ id: str.min(1), name: str, path: str });

const CommandRow = z.object({
  id: str.min(1),
  name: str,
  description: str,
  argumentHint: optStr,
  content: str,
});

/* Legacy: bundles written while saved prompts existed. Still accepted on import,
   and mapped to slash commands; never exported. */
const PromptRow = z.object({
  id: str.min(1),
  name: str,
  description: str.default(""),
  prompt: str,
  seededVersion: int.default(0),
  sortOrder: int.default(0),
});

/* Personas: exported and imported whole. A bundle from before personas came
   back carries the same rows under the same key. */
const PersonaRow = z.object({
  id: str.min(1),
  name: str,
  description: str.default(""),
  prompt: str,
  thinking: int.nullish(),
  effort: optStr,
  seededVersion: int.default(0),
  sortOrder: int.default(0),
});

/* Model prompts travel whole: a restored row
   without its prompt would be an assignment that does nothing, and the seed
   would never repair it — a built-in the importer brought back is stamped as
   already carried, so `seedModelPrompts` will not rewrite it. `seededVersion`
   defaults to 0 so a bundle written before the built-ins existed still imports,
   as a set of rows the seed then treats as the user's own. */
const ModelPromptRow = z.object({
  id: str.min(1),
  name: str,
  match: str,
  prompt: str,
  enabled: z.boolean().default(true),
  sortOrder: int.default(0),
  seededVersion: int.default(0),
});

/** A project's start defaults — the fields a bundle from before them has
    none of, which is why every one is optional and every one defaults to the
    empty pick. Folding them into the row (rather than exporting the columns
    raw) is the choice this shape exists for: a bundle is the *reader's* shape,
    the same one `GET /api/projects` answers, so an importer never has to know
    which of two names a field arrived under. */
const ProjectDefaultsRow = z.object({
  profileId: str.default(""),
  agentId: str.default(""),
  model: str.default(""),
  effort: str.default(""),
  modeId: str.default(""),
  configChoices: z.record(str, z.union([str, z.boolean()])).default({}),
  mcpServerIds: z.array(str).default([]),
  skillIds: z.array(str).default([]),
  commandIds: z.array(str).default([]),
  /* The set that replaced the old boolean. Absent in a bundle from before it,
     which `suggestKindsOf` reads as what the legacy flag said. */
  suggestKinds: z.array(str).optional(),
  suggestFollowups: z.boolean().optional(),
  /* LEGACY: a bundle from before the set. Read only when `uiGroups` is absent. */
  uiBlocks: z.boolean().optional(),
  /* Absent or null in a bundle from before the groups existed: the legacy
     switch decides (off = none, otherwise every group). */
  uiGroups: z.array(str).nullish(),
  /** Absent in a bundle from before personas came back: none. */
  personaId: str.default(""),
  /** Absent in a bundle from before it: on, the column's own default. */
  classifyPersona: z.boolean().default(true),
  /** A provider this install lacks is harmless: voiceSetup falls through. */
  voiceProvider: str.default(""),
  /** Absent in a bundle from before it: ask each time, as every thread did. */
  askProfiles: z.record(z.string(), z.object({ profileId: z.string(), model: z.string().optional() })).default({}),
});

/** A space — a named scope above projects (spaces.ts). Carried so a bundle's
    projects keep a scope to land in; without it the boot backfill would file
    every restored project under the install's own first space. */
const SpaceRow = z.object({
  id: str.min(1),
  name: str,
  sortOrder: int.default(0),
  createdAt: int,
});

const ProjectRow = z.object({
  id: str.min(1),
  name: str,
  cwd: str,
  /** The spaces this project is filed under. Absent on bundles from before a
      project could be in several, which fall back to the single `spaceId`
      below, then to the install's first space. */
  spaceIds: z.array(str).optional(),
  /** The single space of a bundle from before spaces were many-to-many. Absent
      on older ones still. */
  spaceId: optStr,
  description: optStr,
  logoUrl: optStr,
  /** Absent on bundles from before the column; 0 then, which leaves the
      imported rows tied and ordered by name. */
  sortOrder: z.number().int().nullish(),
  /** Absent on bundles from before the columns; the whole empty pick then,
      which is exactly the state a project nobody has worked in is in.
      `prefault` rather than `default` on purpose: the fields inside carry
      their own defaults, and an absent key here has to be run through them —
      `default({})` would install a `{}` that never reaches them and fail the
      insert on a NOT NULL column. */
  defaults: ProjectDefaultsRow.prefault({}),
});

/** A standing instruction rule — individual title and content. */
const RulesRow = z.object({
  id: str.min(1),
  projectId: str.nullish(),
  title: str,
  content: str,
  sortOrder: int.default(0),
  createdAt: int,
  updatedAt: int,
});

/** A model role — the free-form, ordered vocabulary a profile's models tag
    themselves with, as individual global rows (no project). */
const ModelRolesRow = z.object({
  id: str.min(1),
  label: str,
  description: str.default(""),
  sortOrder: int.default(0),
  createdAt: int,
  updatedAt: int,
});

/** A voice backend. `apiKey` is absent under `secrets=0`, and a blank one
    keeps the install's own — the profile-key rule. */
const VoiceRow = z.object({
  provider: z.enum(["openai", "google"]),
  apiKey: str.optional(),
  model: str,
  voice: str,
  isDefault: z.boolean(),
  mcpServerIds: z.array(str).default([]),
  instructions: str.default(""),
  updatedAt: int,
});

/** A user-made theme — the three halves the studio edits, as JSON records. */

const ThemeRow = z.object({
  id: str.min(1),
  name: str,
  light: z.record(str, str),
  dark: z.record(str, str),
  base: z.record(str, str),
  createdAt: int,
  updatedAt: int,
});

/** A project's helper command — a whole row, never a link: the command is the
    payload, so the bundle carries it rather than pointing at a library row.
    `env` rides as the row's JSON text, so export/import is lossless. */
const HelperRow = z.object({
  id: str.min(1),
  projectId: str.min(1),
  name: str,
  command: str,
  cwd: optStr,
  env: optStr,
  description: optStr,
  confirm: z.boolean().nullish(),
  createdAt: int,
});

const KnowledgeRow = z.object({
  id: str.min(1),
  projectId: str.min(1),
  title: str,
  content: str,
  tags: z.array(str).nullish(),
  createdAt: int,
  updatedAt: int,
});

const SessionRow = z.object({
  id: str.min(1),
  profileId: str,
  projectId: str,
  agentId: str,
  model: str.default(""),
  effort: str.default(""),
  /* Absent in a bundle written before modes were persisted, which reads as
     the agent's default — which is exactly what the thread ran on. */
  modeId: optStr,
  /* Absent in a bundle written before suggestion toggles existed, which
     reads as on — suggestions default on, like every new thread. A bundle from
     before the set is `suggestFollowups` alone; one after it has both. */
  suggestFollowups: z.boolean().default(true),
  suggestKinds: z.array(str).nullish(),
  /* LEGACY: the drawn-UI switch before it was a set. A bundle that carries only
     this imports as `uiGroups` (off = none); absent reads as on. */
  uiBlocks: z.boolean().optional(),
  /* The group set, empty = off. Absent or null: the legacy switch decides. */
  uiGroups: z.array(str).nullish(),
  /* Absent in a bundle from before personas came back: none. */
  personaId: optStr,
  /* The system prompt's frozen persona and an unsaid change (`Session.systemPersonaId`).
     Absent in an older bundle: the system prompt follows `personaId`. */
  systemPersonaId: optStr,
  personaPending: z.boolean().default(false),
  /* The thread's role → model assignment (`docs/model-roles.md`). Absent in a
     bundle written before the column existed, which reads as no helpers. */
  helperModels: z.array(z.object({ role: str, model: str })).default([]),
  title: str.default("New thread"),
  /* The thread's git worktree, project-relative. Absent in older bundles,
     which is a thread in the project's own cwd — what they all were. */
  worktree: optStr,
  acpSessionId: optStr,
  acpSessionProvisional: z.boolean().default(false),
  createdAt: int,
  /* Absent in a bundle written before threads were ordered by activity; 0 is
     what `reload` backfills from the imported journal. */
  lastActivityAt: int.default(0),
  /* How the thread's last turn went. Absent in a bundle written before it was
     recorded, which reads as "no failure" — the same thing every row said
     before the column existed. */
  lastTurnError: optStr,
  /* Measured output-speed extrema. Older bundles have no recorded rates. */
  tps: z.object({ min: z.number(), max: z.number(), outputTokens: z.number(), durationMs: z.number(), toolDurationMs: z.number().optional(), generatedTokens: z.number().optional(), decodeMs: z.number().optional(), waits: z.object({ totalMs: z.number(), heldMs: z.number().optional(), compactMs: z.number().optional(), retryMs: z.number().optional() }).optional() }).nullish(),
  deletedAt: int.nullish(),
  /* Absent in a bundle written before pins moved to the server, which reads as
     unpinned — which is what every thread in it was. */
  pinnedAt: int.nullish(),
  /* Absent in a bundle from before hiding existed, which reads as shown. */
  hiddenAt: int.nullish(),
  /* Absent in a bundle from before the setting: ask each time, as every thread did. */
  askProfiles: z.record(z.string(), z.object({ profileId: z.string(), model: z.string().optional() })).nullish(),
  parentSessionId: optStr,
  childKind: optStr,
  childRunId: optStr,
  childRunName: optStr,
  /* Absent in a bundle written before forks existed, which reads as a thread
     that was never branched — which is what every thread in it was. */
  forkedFromSessionId: optStr,
  forkedFromTurnId: optStr,
  asideQuote: optStr,
  taskId: optStr,
  mcpServerIds: z.array(str).default([]),
  skillIds: z.array(str).default([]),
  commandIds: z.array(str).default([]),
});

const QueueRow = z.object({
  id: str.min(1),
  sessionId: str.min(1),
  position: int,
  text: str,
  /* The ids travel; the bytes do not. `attachments` rows are excluded from a
     bundle for the same reason `history_*` is — they are meaningless without
     the files beside them — so a restored queue row keeps saying what it was
     going to send and its chips resolve to the "missing" state. */
  attachmentIds: z.array(str).nullish(),
  createdAt: int,
});

const ScheduledRow = z.object({
  id: str.min(1),
  sessionId: str.min(1),
  text: str,
  nextAt: int,
  everyMs: int.nullish(),
  enabled: int.nullish(),
  lastError: optStr,
  skipCount: int.nullish(),
  createdAt: int,
});

/* Workflow engine v2 (workflows/): a run's header, its append-only event
   journal (the steps are a fold over it, so a run without its events is an
   empty shell) and the saved-workflow library. `spec`, `result` and `payload`
   are opaque here for the same reason a routine's `body` is — the engine owns
   those shapes. A header whose events are not in the bundle still restores:
   the fold of nothing is a run with no steps. */
const WfRunRow = z.object({
  id: str.min(1),
  parentSessionId: str.min(1),
  projectId: optStr,
  name: str,
  spec: z.record(z.string(), z.unknown()),
  status: z.enum(["running", "paused", "completed", "failed", "cancelled", "budget_exceeded"]),
  error: optStr,
  result: json,
  notify: z.boolean().default(false),
  createdAt: int,
  endedAt: int.nullish(),
});

const WfEventRow = z.object({
  runId: str.min(1),
  seq: int,
  at: int,
  key: optStr,
  kind: str,
  payload: z.record(z.string(), z.unknown()),
});

/* The library. A root (project_id is not a foreign key), upserted by id; the
   `(name, scope, project_id)` unique index is cleared by the import first. */
const WfSavedRow = z.object({
  id: str.min(1),
  name: str,
  scope: z.enum(["project", "personal"]),
  projectId: optStr,
  description: str.default(""),
  whenToUse: optStr,
  source: str,
  version: str,
  inputs: z.record(z.string(), z.unknown()).nullish(),
  createdAt: int,
  updatedAt: int,
});

/* Routines and their two children (routines.ts). A routine is a root: nothing
   in the bundle points at it, and its project/profile/agent ids are
   deliberately not foreign keys, so a routine whose project the bundle does not
   carry still restores — "this routine's project no longer exists" is a
   sentence the UI can say, where a dropped row is not. */
const RoutineRow = z.object({
  id: str.min(1),
  name: str,
  description: optStr,
  enabled: z.boolean().default(true),
  projectId: str,
  profileId: str,
  agentId: str,
  model: str.default(""),
  effort: str.default(""),
  configChoices: z.record(str, z.union([str, z.boolean()])).default({}),
  /* Opaque but required. Their INTERNALS are deliberately not validated here:
     `body` holds a whole workflow definition (workflows/graph.ts owns that
     shape) and `autonomy` a policy (autonomy.ts owns that one), and restating
     either would be a second copy to keep in step. `z.custom` rather than
     `z.unknown()` because both columns are NOT NULL and an `unknown` key is
     OPTIONAL in zod — a bundle missing one would parse here and then fail the
     insert, taking the whole transaction down instead of answering 400 at the
     boundary. */
  body: z.custom<RoutineBody>((v) => v !== null && typeof v === "object"),
  output: z.record(str, z.unknown()).nullish(),
  onFinish: z.array(json).default([]),
  overlap: z.enum(["skip", "queue"]).default("skip"),
  autonomy: z.custom<AutonomyPolicy>((v) => v !== null && typeof v === "object"),
  /* Carried, and it is the one field here where carrying it is a security
     decision rather than a convenience: it records that a run has completed
     under this routine, which is what unlocks a blanket `allow`. A restore that
     dropped it would re-lock a grant the user already made informedly; a
     restore that invented it would unlock one they never did. So it travels
     exactly as it was. */
  dryRunCompleted: z.boolean().default(false),
  /* Absent in a bundle written before scheduled messages became routines. */
  runsIn: z.enum(["thread", "session"]).default("thread"),
  sessionId: optStr,
  continueThread: z.boolean().default(false),
  catchup: z.enum(["once", "none"]).default("once"),
  worktree: z.boolean().default(false),
  createdAt: int,
  updatedAt: int,
  mcpServerIds: z.array(str).default([]),
  skillIds: z.array(str).default([]),
  commandIds: z.array(str).default([]),
});

const RoutineTriggerRow = z.object({
  id: str.min(1),
  routineId: str.min(1),
  kind: z.enum(["schedule", "api", "git", "manual"]),
  enabled: z.boolean().default(true),
  cron: optStr,
  tz: optStr,
  atMs: int.nullish(),
  intervalMs: int.nullish(),
  condition: z.object({ gitChangedSince: z.literal("lastRun").optional() }).nullish(),
  /* The clock is carried rather than recomputed: a one-off's slot is a fact
     about when the user asked for it, and a recurring one is re-armed by the
     sweep within SWEEP_MS anyway. A restored slot already in the past fires
     once and rolls forward, which is the same collapse a server that was off
     overnight already does. */
  nextFireAt: int.nullish(),
  /** Absent = redacted on export; "" is also read as "nothing to say". The
      stored value is a sha-256, not the token — but it is the only credential
      here that starts a process on this machine, so it follows the same
      opt-out every other secret does. */
  secretHash: str.optional(),
  secretCreatedAt: int.nullish(),
  branch: optStr,
  paths: z.array(str).default([]),
  debounceMs: int.default(30_000),
  lastSeen: optStr,
  lastFiredAt: int.nullish(),
  lastError: optStr,
  createdAt: int,
});

const RoutineRunRow = z.object({
  id: str.min(1),
  routineId: str.min(1),
  triggerId: optStr,
  fireId: str,
  /** The run's thread. Not filtered against the sessions table on import: it is
      not a foreign key precisely so that deleting a thread does not delete the
      history of the run that made it. */
  sessionId: optStr,
  source: z.enum(["schedule", "api", "git", "manual", "routine"]),
  payload: optStr,
  dryRun: z.boolean().default(false),
  status: z.enum(["running", "completed", "failed", "blocked", "skipped"]),
  error: optStr,
  skipReason: optStr,
  inboxState: z.enum(["unread", "read", "archived"]).nullish(),
  output: optStr,
  verdict: json,
  actions: z.array(json).default([]),
  headOid: optStr,
  tokens: int.nullish(),
  startedAt: int,
  endedAt: int.nullish(),
});

const EventRow = z.object({
  sessionId: str.min(1),
  seq: int,
  kind: str,
  payload: json,
  at: int.default(0),
});

const CustomFieldRow = z.object({
  id: str.min(1),
  name: str,
  type: z.enum(["text", "number", "select", "date", "checkbox", "url"]),
  options: z.array(str).optional(),
});

const BoardRow = z.object({
  id: str.min(1),
  name: str,
  key: str.default("TASK"),
  description: optStr,
  projectId: optStr,
  color: optStr,
  order: int.default(0),
  nextNumber: int.default(1),
  customFields: z.array(CustomFieldRow).default([]),
  createdAt: int,
  updatedAt: int,
});

const BoardStatusRow = z.object({
  id: str.min(1),
  boardId: str.min(1),
  name: str,
  color: optStr,
  category: z.enum(["todo", "in_progress", "done"]).default("todo"),
  wipLimit: int.nullish(),
  order: int.default(0),
  createdAt: int,
  updatedAt: int,
});

const SprintRow = z.object({
  id: str.min(1),
  boardId: str.min(1),
  name: str,
  goal: optStr,
  startAt: int.nullish(),
  endAt: int.nullish(),
  state: z.enum(["planned", "active", "closed"]).default("planned"),
  order: int.default(0),
  createdAt: int,
  updatedAt: int,
});

const BoardViewRow = z.object({
  id: str.min(1),
  boardId: str.min(1),
  name: str,
  kind: z.enum(["board", "list", "table", "calendar", "timeline"]).default("board"),
  config: z.record(z.string(), z.unknown()).default({}),
  order: int.default(0),
  createdAt: int,
  updatedAt: int,
});

const BoardListRow = z.object({
  id: str.min(1),
  boardId: str.min(1),
  name: str,
  color: optStr,
  order: int.default(0),
  group: optStr,
  collapsed: z.boolean().default(false),
  createdAt: int,
  updatedAt: int,
});

const TaskCommentRow = z.object({
  id: str.min(1),
  taskId: str.min(1),
  body: str,
  author: optStr,
  createdAt: int,
  updatedAt: int,
});

const TaskActivityRow = z.object({
  id: str.min(1),
  taskId: str.min(1),
  at: int,
  field: str,
  from: z.unknown().nullish(),
  to: z.unknown().nullish(),
  /* Absent in a bundle written before agents could write to a task. */
  actor: optStr,
});

const TaskLinkRow = z.object({
  id: str.min(1),
  fromId: str.min(1),
  toId: str.min(1),
  kind: z.enum(["blocks", "relates", "duplicates"]).default("relates"),
  createdAt: int,
});

/* A task's board and column are ids now, where a bundle written before boards
   existed carries `board` (always "default") and `status` (one of four slugs).
   Those are exactly the ids `ensureDefaultBoard` seeds, so the old keys are
   renamed rather than translated — an old bundle imports into the default
   board unchanged. */
const TaskRow = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object") return value;
    const row = value as Record<string, unknown>;
    if ("boardId" in row && "statusId" in row) return row;
    const { board, status, ...rest } = row;
    return {
      ...rest,
      boardId: row.boardId ?? board ?? "default",
      statusId: row.statusId ?? status ?? "todo",
    };
  },
  z.object({
    id: str.min(1),
    boardId: str.default("default"),
    number: int.nullable().default(null),
    type: z.enum(["task", "bug", "story", "epic"]).default("task"),
    title: str,
    description: optStr,
    statusId: str.default("todo"),
    priority: z.enum(["lowest", "low", "medium", "high", "urgent"]).default("medium"),
    labels: z.array(str).default([]),
    assignee: optStr,
    assignees: z.array(str).default([]),
    listId: optStr,
    parentId: optStr,
    sprintId: optStr,
    estimate: int.nullish(),
    timeEstimate: int.nullish(),
    timeTracked: int.nullish(),
    startAt: int.nullish(),
    dueAt: int.nullish(),
    completedAt: int.nullish(),
    archived: z.boolean().nullable().default(false),
    checklist: z
      .array(z.object({ id: str.min(1), text: str, done: z.boolean().default(false) }))
      .default([]),
    custom: z.record(z.string(), z.unknown()).default({}),
    note: optStr,
    order: int.default(0),
    createdAt: int,
    updatedAt: int,
  }),
);

const UsageRow = z.object({
  id: str.min(1),
  sessionId: str,
  toolCallId: str,
  tool: z.enum(["search", "fetch"]),
  status: str,
  threadTitle: str,
  profileId: str,
  profileName: str,
  projectId: str,
  projectName: str,
  startedAt: int,
  completedAt: int.nullish(),
});

const PushTokenRow = z.object({ token: str.min(1), createdAt: int });

const NotificationRow = z.object({
  id: str.min(1),
  kind: z.enum(["permission", "question", "turn_finished", "turn_failed"]),
  sessionId: optStr,
  threadTitle: optStr,
  body: optStr,
  read: z.boolean().default(false),
  createdAt: int,
});

/* The prompts the user has typed — theirs, and the one table here that is
   worth carrying to a new install even though nothing points at it. */
const ComposerHistoryRow = z.object({
  id: str.min(1),
  text: str,
  sessionId: optStr,
  threadTitle: optStr,
  createdAt: int,
});

const WebSearchBlock = z.object({
  searchApiBaseUrl: str,
  /** Absent = redacted on export. */
  searchApiToken: str.optional(),
  searchModel: str,
  fetchModel: str,
});

export const BundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  exportedAt: int.optional(),
  /** What the export left out, so the importer can say so. */
  redacted: z.object({ secrets: z.boolean().default(false), journals: z.boolean().default(false) }).default({ secrets: false, journals: false }),
  agents: z.array(AgentRow).default([]),
  profiles: z.array(ProfileRow).default([]),
  mcpServers: z.array(McpServerRow).default([]),
  mcpOauth: z.array(McpOauthRow).default([]),
  skills: z.array(SkillRow).default([]),
  commands: z.array(CommandRow).default([]),
  /** Legacy key (bundles written while saved prompts existed). */
  prompts: z.array(PromptRow).optional(),
  personas: z.array(PersonaRow).default([]),
  modelPrompts: z.array(ModelPromptRow).default([]),
  spaces: z.array(SpaceRow).default([]),
  projects: z.array(ProjectRow).default([]),
  projectHelpers: z.array(HelperRow).default([]),
  knowledge: z.array(KnowledgeRow).default([]),
  sessions: z.array(SessionRow).default([]),
  queue: z.array(QueueRow).default([]),
  scheduled: z.array(ScheduledRow).default([]),
  wfRuns: z.array(WfRunRow).default([]),
  wfEvents: z.array(WfEventRow).default([]),
  wfSaved: z.array(WfSavedRow).default([]),
  routines: z.array(RoutineRow).default([]),
  routineTriggers: z.array(RoutineTriggerRow).default([]),
  routineRuns: z.array(RoutineRunRow).default([]),
  events: z.array(EventRow).default([]),
  boards: z.array(BoardRow).default([]),
  boardStatuses: z.array(BoardStatusRow).default([]),
  sprints: z.array(SprintRow).default([]),
  boardViews: z.array(BoardViewRow).default([]),
  boardLists: z.array(BoardListRow).default([]),
  tasks: z.array(TaskRow).default([]),
  taskComments: z.array(TaskCommentRow).default([]),
  taskActivity: z.array(TaskActivityRow).default([]),
  taskLinks: z.array(TaskLinkRow).default([]),
  webSearchUsage: z.array(UsageRow).default([]),
  pushTokens: z.array(PushTokenRow).default([]),
  notifications: z.array(NotificationRow).default([]),
  composerHistory: z.array(ComposerHistoryRow).default([]),
  /** Standalone rules — individual items rather than a single blob. */
  rules: z.array(RulesRow).default([]),
  /** The model-role vocabulary — individual global rows. */
  modelRoles: z.array(ModelRolesRow).default([]),
  /** User-made themes from the studio, whole rows. */
  themes: z.array(ThemeRow).default([]),
  /** Realtime voice backends (Settings › Voice). */
  voiceProviders: z.array(VoiceRow).default([]),
  /** `app_settings` as a record. */
  settings: z.record(str, str).default({}),
  config: z.object({ webSearch: WebSearchBlock.optional() }).default({}),
});

export type Bundle = z.infer<typeof BundleSchema>;

export interface ExportOptions {
  includeSecrets: boolean;
  includeJournals: boolean;
}

const blankValues = (pairs: NameValue[] | null | undefined): NameValue[] | null | undefined =>
  pairs ? pairs.map(({ name }) => ({ name, value: "" })) : pairs;

const withLinks = <T extends { id: string }>(rows: T[], links: Map<string, LinkSet>): (T & LinkSet)[] =>
  rows.map((row) => ({ ...row, ...(links.get(row.id) ?? emptyLinks()) }));

/** Everything, as one document. Cheap for everything but the events, which
    are the whole transcript history — the one reason there is an opt-out. */
export async function exportBundle(opts: ExportOptions): Promise<Bundle> {
  const profiles = await db.select().from(profilesTable);
  const sessions = await db.select().from(sessionsTable);
  const mcpServers = await db.select().from(mcpServersTable);
  const mcpOauthRows = await db.select().from(mcpOauthTable);
  const routines = await db.select().from(routinesTable);
  const triggers = await db.select().from(routineTriggersTable);
  const webSearch = readWebSearch();
  const spaceIdsOf = new Map<string, string[]>();
  for (const { projectId, spaceId } of await db.select().from(projectSpacesTable)) {
    spaceIdsOf.set(projectId, [...(spaceIdsOf.get(projectId) ?? []), spaceId]);
  }

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    redacted: { secrets: !opts.includeSecrets, journals: !opts.includeJournals },
    agents: await db.select().from(agentsTable),
    profiles: profiles.map((p) => {
      const { apiKey, usage, ...rest } = p;
      /* The usage provider's own token is the second credential on a profile
         and is redacted with the first — `kind` and the host stay, since they
         are configuration and say nothing secret. */
      const safeUsage = usage && !opts.includeSecrets ? { ...usage, apiKey: "" } : usage;
      return opts.includeSecrets ? { ...rest, usage: safeUsage, apiKey } : { ...rest, usage: safeUsage };
    }),
    mcpServers: opts.includeSecrets
      ? mcpServers
      : mcpServers.map((s) => ({ ...s, headers: blankValues(s.headers), env: blankValues(s.env) })),
    /* The tokens are the second kind of credential in the library and are
       blanked with the first. What is left — the registration and the
       discovered metadata — is configuration, and a connection stripped of its
       tokens still restores as a row that only needs reconnecting. */
    mcpOauth: opts.includeSecrets
      ? mcpOauthRows
      : mcpOauthRows.map((r) => ({ ...r, accessToken: "", refreshToken: "", clientSecret: "" })),
    skills: await db.select().from(skillsTable),
    commands: await db.select().from(commandsTable),
    personas: await db.select().from(personasTable),
    modelPrompts: await db.select().from(modelPromptsTable),
    spaces: await db.select().from(spacesTable),
    projects: (await db.select().from(projectsTable)).map((row) => ({
      ...withoutDefaults(row),
      spaceIds: spaceIdsOf.get(row.id) ?? [],
      defaults: projectDefaultsOf(row),
    })),
    projectHelpers: await db.select().from(projectHelpersTable),
    knowledge: await db.select().from(knowledgeTable),
    sessions: withLinks(sessions, await readLinks(SESSION_LINKS, sessions.map((s) => s.id))),
    queue: await db.select().from(queueTable),
    /* Scheduled messages travel as routines now; the key stays so an old
       reader still parses a new bundle, and is still READ on import. */
    scheduled: [] as z.infer<typeof ScheduledRow>[],
    wfRuns: await db.select().from(wfRunsTable),
    wfEvents: await db.select().from(wfEventsTable).orderBy(wfEventsTable.runId, wfEventsTable.seq),
    wfSaved: await db.select().from(wfSavedTable),
    routines: withLinks(routines, await readLinks(ROUTINE_LINKS, routines.map((r) => r.id))),
    /* A trigger's token hash is a credential like a profile's key: the key is
       ABSENT under `secrets=0`, not blanked to "", because absent is what the
       import reads as "keep whatever this install already holds". */
    routineTriggers: opts.includeSecrets
      ? triggers
      : triggers.map(({ secretHash: _s, ...rest }) => rest),
    routineRuns: await db.select().from(routineRunsTable),
    events: opts.includeJournals
      ? await db.select().from(eventsTable).orderBy(eventsTable.sessionId, eventsTable.seq)
      : [],
    boards: await db.select().from(boardsTable),
    boardStatuses: await db.select().from(boardStatusesTable),
    sprints: await db.select().from(sprintsTable),
    boardViews: await (await db
      .select()
      .from(boardViewsTable))

      .map((v) => ({ ...v, config: v.config as Record<string, unknown> })),
    boardLists: await db.select().from(boardListsTable),
    tasks: await db.select().from(tasksTable),
    taskComments: await db.select().from(taskCommentsTable),
    taskActivity: await db.select().from(taskActivityTable),
    taskLinks: await db.select().from(taskLinksTable),
    webSearchUsage: await db.select().from(usageTable),
    pushTokens: await db.select().from(pushTokensTable),
    notifications: await db.select().from(notificationsTable),
    composerHistory: await db.select().from(composerHistoryTable),
    rules: await db.select().from(rulesTable),
    modelRoles: await db.select().from(modelRolesTable),
    themes: await db.select().from(themesTable),
    voiceProviders: (await db.select().from(voiceTable)).map(({ apiKey, ...row }) =>
      opts.includeSecrets ? { ...row, apiKey } : row,
    ),
    settings: Object.fromEntries(await (await db.select().from(appSettingsTable)).map((r) => [r.key, r.value])),
    config: webSearch
      ? {
          webSearch: opts.includeSecrets
            ? webSearch
            : { searchApiBaseUrl: webSearch.searchApiBaseUrl, searchModel: webSearch.searchModel, fetchModel: webSearch.fetchModel },
        }
      : {},
  };
}

export type ImportMode = "merge" | "replace";

export type ImportSummary = Record<
  | "agents" | "profiles" | "mcpServers" | "mcpOauth" | "skills" | "commands" | "personas" | "modelPrompts" | "spaces" | "projects" | "projectHelpers" | "knowledge" | "settings"
  | "rules" | "modelRoles" | "themes" | "voiceProviders" | "sessions" | "queue" | "scheduled" | "wfRuns" | "wfEvents" | "wfSaved" | "events" | "boards" | "boardStatuses" | "sprints" | "boardViews" | "boardLists" | "tasks" | "taskComments" | "taskActivity" | "taskLinks"
  | "routines" | "routineTriggers" | "routineRuns"
  | "webSearchUsage" | "pushTokens" | "notifications" | "composerHistory",
  number
> & {
  /** Rows dropped because the row they belong to is in neither the bundle
      nor the install (a knowledge entry for a project that no longer exists). */
  orphaned: number;
  /** The bundle came without secrets and this install had none to keep. */
  missingSecrets: boolean;
};

/** SQLite caps bound parameters per statement; 200 rows of the widest table
    here stays well under it. */
const CHUNK = 200;

/** Plain inserts for the tables that are replaced per owner (a thread's queue,
    schedules and log) or are append-only sets (push tokens): a collision means
    the row is already there, and is skipped. */
async function insertChunked<T extends object>(tx: Tx, table: PgTable, rows: T[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK) as Record<string, unknown>[];
    if (chunk.length === 0) continue;
    await tx.insert(table).values(chunk).onConflictDoNothing();
  }
}

/**
 * Upsert by primary key WITHOUT cascading: `INSERT … ON CONFLICT DO UPDATE`
 * over every column the row carries (`INSERT OR REPLACE` is a delete-then-
 * insert, and the delete would fire ON DELETE CASCADE on the row's children —
 * a merged profile would lose its links, a merged project its knowledge).
 * Columns the bundle's rows do not carry are left as the install has them.
 */
async function upsertChunked(tx: Tx, table: PgTable, key: string, rows: Record<string, unknown>[]): Promise<void> {
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const target = columns[key];
  if (!target) throw new Error(`no column ${key}`);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    // Every row went through the same zod schema, so the union of the chunk's
    // keys is the column set; a row missing one writes its default/null.
    const present = [...new Set(chunk.flatMap((row) => Object.keys(row)))].filter((k) => k in columns);
    const set: Record<string, SQL> = {};
    for (const column of present) {
      if (column === key) continue;
      set[column] = sql.raw(`excluded."${columns[column]!.name}"`);
    }
    const normalized = chunk.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of present) out[column] = row[column] ?? null;
      return out;
    });
    await tx.insert(table).values(normalized).onConflictDoUpdate({ target, set });
  }
}

/** Merge a redacted row's secrets from the row the install already holds. */
function keepSecrets(
  incoming: z.infer<typeof ProfileRow>,
  existing: typeof profilesTable.$inferSelect | undefined,
): { row: z.infer<typeof ProfileRow> & { apiKey: string }; missing: boolean } {
  const apiKey = incoming.apiKey || existing?.apiKey || "";
  /* Same rule one level down: a redacted bundle merged over its own install
     keeps the usage token it was exported without. */
  const usage = incoming.usage
    ? { ...incoming.usage, apiKey: incoming.usage.apiKey || (existing?.usage?.apiKey ?? "") }
    : incoming.usage;
  return { row: { ...incoming, apiKey, usage }, missing: !apiKey && incoming.apiKey === undefined };
}

function keepPairs(incoming: NameValue[] | null | undefined, existing: NameValue[] | null | undefined): NameValue[] | null {
  if (!incoming) return null;
  const known = new Map((existing ?? []).map((p) => [p.name, p.value]));
  return incoming.map((p) => ({ name: p.name, value: p.value || known.get(p.name) || "" }));
}

/**
 * An old bundle's `scheduled` rows become `session`-mode routines + a schedule
 * trigger appended to the bundle's own routine lists, so the rest of the import
 * treats them like any other routine. The owner (profile/agent/project) comes
 * from the bundled thread; a row whose thread the bundle does not carry is an
 * orphan, as it always was.
 */
function foldLegacyScheduled(bundle: Bundle, summary: ImportSummary): void {
  if (bundle.scheduled.length === 0) return;
  const owners = new Map(bundle.sessions.map((s) => [s.id, s]));
  const have = new Set(bundle.routines.map((r) => r.id));
  for (const row of bundle.scheduled) {
    const owner = owners.get(row.sessionId);
    if (!owner) {
      summary.orphaned += 1;
      continue;
    }
    if (have.has(row.id)) continue;
    const { routine, trigger } = routineFromScheduled({ ...row, enabled: row.enabled ?? 1, skipCount: row.skipCount ?? 0 }, owner);
    bundle.routines.push({
      ...(routine as object),
      mcpServerIds: [],
      skillIds: [],
      commandIds: [],
    } as unknown as Bundle["routines"][number]);
    bundle.routineTriggers.push(trigger as unknown as Bundle["routineTriggers"][number]);
    summary.scheduled += 1;
  }
  bundle.scheduled = [];
}

/**
 * Write a bundle into the database. Synchronous and in one transaction — the
 * caller has already retired whatever processes the rows it touches belong
 * to, and reloads the SessionManager afterwards.
 */
export async function importBundle(bundle: Bundle, mode: ImportMode): Promise<ImportSummary> {
  const summary: ImportSummary = {
    agents: 0, profiles: 0, mcpServers: 0, mcpOauth: 0, skills: 0, commands: 0, personas: 0, modelPrompts: 0, spaces: 0, projects: 0, projectHelpers: 0, knowledge: 0, settings: 0,
    rules: 0, modelRoles: 0, themes: 0, voiceProviders: 0, sessions: 0, queue: 0, scheduled: 0, wfRuns: 0, wfEvents: 0, wfSaved: 0, events: 0, boards: 0, boardStatuses: 0, sprints: 0, boardViews: 0, boardLists: 0, tasks: 0, taskComments: 0, taskActivity: 0, taskLinks: 0,
    routines: 0, routineTriggers: 0, routineRuns: 0,
    webSearchUsage: 0, pushTokens: 0, notifications: 0, composerHistory: 0,
    orphaned: 0, missingSecrets: false,
  };

  foldLegacyScheduled(bundle, summary);

  // Read what the install holds BEFORE the transaction empties it — the
  // secrets a redacted bundle is allowed to keep.
  const existingProfiles = new Map(await (await db.select().from(profilesTable)).map((p) => [p.id, p]));
  const existingMcp = new Map(await (await db.select().from(mcpServersTable)).map((s) => [s.id, s]));
  const existingOauth = new Map(await (await db.select().from(mcpOauthTable)).map((r) => [r.mcpServerId, r]));
  const existingTriggers = new Map(await (await db.select().from(routineTriggersTable)).map((t) => [t.id, t]));
  const existingWebSearch = readWebSearch();
  const existingVoice = new Map((await db.select().from(voiceTable)).map((v) => [v.provider, v]));

  await db.transaction(async (tx) => {
    if (mode === "replace") {
      // Children first only for readability — every child table cascades from
      // its parent, and the ones that do not (usage, tokens, tasks) stand alone.
      for (const table of [
        // `mcp_oauth` cascades off `mcp_servers`, and is named here anyway so
        // the list reads as the whole of what `replace` empties.
        sessionsTable, profilesTable, spacesTable, projectsTable, mcpOauthTable, mcpServersTable, skillsTable, commandsTable,
        personasTable, modelPromptsTable,
        // A root of its own: its triggers, runs and links all cascade from it.
        routinesTable,
        // The saved-workflow library is a root; runs and their events cascade off sessions.
        wfSavedTable,
        agentsTable, taskLinksTable, taskActivityTable, taskCommentsTable, tasksTable, boardViewsTable, boardListsTable, sprintsTable, boardStatusesTable, boardsTable, usageTable, pushTokensTable,
        notificationsTable,
        composerHistoryTable,
        agentOptionsTable,
        voiceTable,
      ]) {
        await tx.delete(table);
      }
    }

    /* Parents, in dependency order. Every table below is an upsert by id in
       both modes (after `replace` emptied them, an upsert is a plain insert),
       so a merge keeps whatever the bundle does not name. */
    upsertChunked(tx, agentsTable, "id", bundle.agents.map((a) => ({ ...a, spawnCategories: a.spawnCategories ?? null, liveConfig: a.liveConfig ?? null })));
    summary.agents = bundle.agents.length;

    const profileRows = bundle.profiles.map((p) => {
      const { row, missing } = keepSecrets(p, existingProfiles.get(p.id));
      if (missing) summary.missingSecrets = true;
      const { mcpServerIds: _m, skillIds: _s, commandIds: _c, ...columns } = row;
      return {
        ...columns,
        hidden: columns.hidden ?? false,
        disabled: columns.disabled ?? false,
        smallModel: columns.smallModel ?? "",
        logoUrl: columns.logoUrl ?? "",
        voiceProvider: columns.voiceProvider ?? null,
        usage: columns.usage ?? null,
      };
    });
    upsertChunked(tx, profilesTable, "id", profileRows);
    summary.profiles = bundle.profiles.length;

    upsertChunked(
      tx,
      mcpServersTable,
      "id",
      bundle.mcpServers.flatMap((s) => {
        if (s.builtin === "workflow") return [];
        const was = existingMcp.get(s.id);
        return [{
          ...s,
          builtin: s.builtin ?? null,
          url: s.url ?? null,
          command: s.command ?? null,
          args: s.args ?? null,
          headers: keepPairs(s.headers, was?.headers),
          env: keepPairs(s.env, was?.env),
        }];
      }),
    );
    summary.mcpServers = bundle.mcpServers.length;

    /* The connections, after the rows they cascade off. One whose server is in
       neither the bundle nor the install is orphaned rather than fatal, exactly
       like a knowledge entry for a project that no longer exists — and the
       cascade would refuse the insert anyway. */
    const mcpIds = new Set([...existingMcp.keys(), ...bundle.mcpServers.map((s) => s.id)]);
    const oauth = bundle.mcpOauth.filter((r) => mcpIds.has(r.mcpServerId));
    summary.orphaned += bundle.mcpOauth.length - oauth.length;
    upsertChunked(
      tx,
      mcpOauthTable,
      "mcpServerId",
      oauth.map((r) => {
        const was = existingOauth.get(r.mcpServerId);
        return {
          ...r,
          metadata: r.metadata as (typeof mcpOauthTable.$inferInsert)["metadata"],
          /* A blank secret keeps the install's own — the profile-key rule. */
          clientSecret: r.clientSecret || was?.clientSecret || null,
          accessToken: r.accessToken || was?.accessToken || null,
          refreshToken: r.refreshToken || was?.refreshToken || null,
          scope: r.scope ?? null,
          expiresAt: r.expiresAt ?? null,
          lastError: r.lastError ?? null,
        };
      }),
    );
    summary.mcpOauth = oauth.length;

    upsertChunked(tx, skillsTable, "id", bundle.skills);
    summary.skills = bundle.skills.length;
    /* A legacy saved prompt arrives as a command; a name another command holds
       (here or in the bundle) is suffixed, not refused. */
    const legacy = bundle.prompts ?? [];
    const ids = new Set([...bundle.commands, ...legacy].map((c) => c.id));
    const usedNames = new Set(
      [
        ...(await tx.select({ id: commandsTable.id, name: commandsTable.name }).from(commandsTable)).filter((r) => !ids.has(r.id)),
        ...bundle.commands,
      ].map((r) => r.name.toLowerCase()),
    );
    const commandRows = [
      ...bundle.commands.map((c) => ({ ...c, argumentHint: c.argumentHint ?? null })),
      ...legacy.map((p) => commandFromPrompt(p, usedNames)),
    ];
    await upsertChunked(tx, commandsTable, "id", commandRows);
    summary.commands = commandRows.length;
    await upsertChunked(tx, personasTable, "id", bundle.personas.map((p) => ({ ...p, thinking: p.thinking ?? null, effort: p.effort ?? null })));
    summary.personas = bundle.personas.length;
    upsertChunked(tx, modelPromptsTable, "id", bundle.modelPrompts.map((r) => ({ ...r })));
    summary.modelPrompts = bundle.modelPrompts.length;
    /* Spaces before projects: a project names one, and the running install may
       already hold rows under a space id the bundle also uses. */
    await upsertChunked(tx, spacesTable, "id", bundle.spaces.map((s) => ({ ...s })));
    summary.spaces = bundle.spaces.length;
    await upsertChunked(
      tx,
      projectsTable,
      "id",
      bundle.projects.map((p) => {
        const { defaults, spaceIds: _ids, spaceId: _legacy, ...row } = p;
        return {
          ...row,
          description: p.description ?? null,
          logoUrl: p.logoUrl ?? "",
          sortOrder: p.sortOrder ?? 0,
          /* The two writers of these columns are this and `setProjectDefaults`,
             and both go through `projectDefaultsColumns` — a bundle that
             rewrote them by hand would be a second spelling of the mapping. */
          ...projectDefaultsColumns({
            ...defaults,
            // A bundle from before the set carried the old boolean here.
            suggestKinds: defaults.suggestKinds ?? suggestKindsOf(null, defaults.suggestFollowups),
            // Absent keeps the column null (every group) unless the legacy switch said off.
            uiGroups: defaults.uiGroups ?? (defaults.uiBlocks === false ? [] : undefined),
          }),
        };
      }),
    );
    summary.projects = bundle.projects.length;
    /* A project's spaces are the bundle's word for them: the new list, else the
       single space of an older bundle, else (nothing named, or only spaces this
       install lacks) the install's first. Replaced per project, so a merge
       leaves a project the bundle does not name exactly as it was. */
    const knownSpaces = (
      await tx.select({ id: spacesTable.id }).from(spacesTable).orderBy(spacesTable.sortOrder, spacesTable.name)
    ).map((r) => r.id);
    const memberships = bundle.projects.flatMap((p) => {
      const named = (p.spaceIds ?? (p.spaceId ? [p.spaceId] : [])).filter((id) => knownSpaces.includes(id));
      return (named.length > 0 ? named : knownSpaces.slice(0, 1)).map((spaceId) => ({ projectId: p.id, spaceId }));
    });
    if (bundle.projects.length > 0) {
      await tx.delete(projectSpacesTable).where(inArray(projectSpacesTable.projectId, bundle.projects.map((p) => p.id)));
      for (let i = 0; i < memberships.length; i += CHUNK) {
        await tx.insert(projectSpacesTable).values(memberships.slice(i, i + CHUNK)).onConflictDoNothing();
      }
    }

    /* Settings upsert per key, never a delete: a key the bundle names is that
       key's value, and one it does not name stays the install's. A bundle
       written before `app_settings` existed — defaulting to `{}` — must not
       wipe rules written since. */
    upsertChunked(
      tx,
      appSettingsTable,
      "key",
      Object.entries(bundle.settings).map(([key, value]) => ({ key, value })),
    );
    summary.settings = Object.keys(bundle.settings).length;

    /* Rules — individual items, imported wholesale. */
    upsertChunked(tx, rulesTable, "id", bundle.rules.map((r) => ({ ...r })));
    summary.rules = bundle.rules.length;

    /* The model-role vocabulary — individual global rows, imported wholesale. */
    upsertChunked(tx, modelRolesTable, "id", bundle.modelRoles.map((r) => ({ ...r })));
    summary.modelRoles = bundle.modelRoles.length;

    const voiceRows = bundle.voiceProviders.map((v) => {
      const apiKey = v.apiKey || existingVoice.get(v.provider)?.apiKey || "";
      if (!apiKey) summary.missingSecrets = true;
      return { ...v, apiKey };
    });
    await upsertChunked(tx, voiceTable, "provider", voiceRows);
    summary.voiceProviders = voiceRows.length;

    /* The link tables are replaced wholesale per owner: `writeLinks` drops the
       owner's rows and re-adds only ids the library actually holds, so a
       bundle naming a server this install never had links nothing. Profiles
       carry no links; older bundles may still name them and those are dropped. */

    // Children of projects. A row whose project exists nowhere is dropped, not
    // fatal — the foreign key would refuse it and take the whole import down.
    const projectIds = new Set(await (await tx.select({ id: projectsTable.id }).from(projectsTable)).map((r) => r.id));
    const knowledge = bundle.knowledge.filter((k) => projectIds.has(k.projectId));
    summary.orphaned += bundle.knowledge.length - knowledge.length;
    upsertChunked(tx, knowledgeTable, "id", knowledge.map((k) => ({ ...k, tags: k.tags ?? null })));
    summary.knowledge = knowledge.length;
    /* The helpers ride with their project: a bundle naming a project this
       install dropped is orphaned, exactly like a knowledge entry would be.
       Older bundles predate the option columns, so each is defaulted here. */
    const helpers = bundle.projectHelpers.filter((h) => projectIds.has(h.projectId));
    summary.orphaned += bundle.projectHelpers.length - helpers.length;
    upsertChunked(
      tx,
      projectHelpersTable,
      "id",
      helpers.map((h) => ({
        ...h,
        cwd: h.cwd ?? null,
        env: h.env ?? null,
        description: h.description ?? null,
        confirm: h.confirm === true,
        createdAt: h.createdAt ?? 0,
      })),
    );
    summary.projectHelpers = helpers.length;

    // Sessions and everything hanging off them.
    upsertChunked(
      tx,
      sessionsTable,
      "id",
      bundle.sessions.map((s) => {
        const { mcpServerIds: _m, skillIds: _s, commandIds: _c, ...columns } = s;
        return {
          ...columns,
          modeId: columns.modeId ?? null,
          uiGroups: columns.uiGroups ?? (columns.uiBlocks === false ? [] : null),
          personaId: columns.personaId ?? null,
          systemPersonaId: columns.systemPersonaId ?? null,
          acpSessionId: columns.acpSessionId ?? null,
          deletedAt: columns.deletedAt ?? null,
          pinnedAt: columns.pinnedAt ?? null,
          hiddenAt: columns.hiddenAt ?? null,
          askProfiles: columns.askProfiles ?? null,
          parentSessionId: columns.parentSessionId ?? null,
          childKind: columns.childKind ?? null,
          childRunId: columns.childRunId ?? null,
          childRunName: columns.childRunName ?? null,
          forkedFromSessionId: columns.forkedFromSessionId ?? null,
          forkedFromTurnId: columns.forkedFromTurnId ?? null,
          asideQuote: columns.asideQuote ?? null,
          taskId: columns.taskId ?? null,
        };
      }),
    );
    summary.sessions = bundle.sessions.length;
    for (const s of bundle.sessions) await writeLinks(tx, SESSION_LINKS, s.id, s);

    const sessionIds = new Set(await (await tx.select({ id: sessionsTable.id }).from(sessionsTable)).map((r) => r.id));
    const bundled = new Set(bundle.sessions.map((s) => s.id));
    const keep = <T extends { sessionId: string }>(rows: T[]): T[] => {
      const kept = rows.filter((r) => sessionIds.has(r.sessionId));
      summary.orphaned += rows.length - kept.length;
      return kept;
    };

    /* A thread's queue, schedules and log are replaced as a unit for every
       thread the bundle carries, even one whose rows the bundle left out:
       a merged log is two accounts stitched together, which the rest of the
       server goes to lengths to make impossible (see sessions.ts). */
    const owned = [...bundled];
    if (owned.length > 0) {
      for (let i = 0; i < owned.length; i += CHUNK) {
        const ids = owned.slice(i, i + CHUNK);
        await tx.delete(queueTable).where(inArray(queueTable.sessionId, ids));
        // Cascades to the run's events.
        await tx.delete(wfRunsTable).where(inArray(wfRunsTable.parentSessionId, ids));
        if (!bundle.redacted.journals) await tx.delete(eventsTable).where(inArray(eventsTable.sessionId, ids));
      }
    }
    const queue = keep(bundle.queue);
    insertChunked(tx, queueTable, queue);
    summary.queue = queue.length;
    const runs = bundle.wfRuns.filter((r) => sessionIds.has(r.parentSessionId));
    summary.orphaned += bundle.wfRuns.length - runs.length;
    insertChunked(
      tx,
      wfRunsTable,
      runs.map((r) => ({ ...r, projectId: r.projectId ?? null, error: r.error ?? null, result: r.result ?? null, endedAt: r.endedAt ?? null })),
    );
    summary.wfRuns = runs.length;
    /* Events after the headers they cascade off, in chunks like the thread
       journal below; one whose run did not make it in is orphaned. */
    const runIds = new Set(runs.map((r) => r.id));
    const wfEvents = bundle.wfEvents.filter((e) => runIds.has(e.runId));
    summary.orphaned += bundle.wfEvents.length - wfEvents.length;
    insertChunked(
      tx,
      wfEventsTable,
      wfEvents.map((e) => ({ ...e, key: e.key ?? null })),
    );
    summary.wfEvents = wfEvents.length;
    /* The library: a root, upserted by id. Another row already holding the
       same (name, scope, project) under a different id would trip the unique
       index, so it is cleared first — the bundle's copy wins, as every other
       merged row does. */
    for (const w of bundle.wfSaved) {
      await tx
        .delete(wfSavedTable)
        .where(
          and(
            eq(wfSavedTable.name, w.name),
            eq(wfSavedTable.scope, w.scope),
            w.projectId ? eq(wfSavedTable.projectId, w.projectId) : isNull(wfSavedTable.projectId),
            ne(wfSavedTable.id, w.id),
          ),
        );
    }
    upsertChunked(
      tx,
      wfSavedTable,
      "id",
      bundle.wfSaved.map((w) => ({ ...w, projectId: w.projectId ?? null, whenToUse: w.whenToUse ?? null, inputs: w.inputs ?? null })),
    );
    summary.wfSaved = bundle.wfSaved.length;
    const events = keep(bundle.events);
    insertChunked(tx, eventsTable, events);
    summary.events = events.length;

    /* Routines, and the two tables that hang off them. A root: nothing points
       at a routine, so this sits outside the session block entirely — a routine
       survives its project, its profile and the thread of every run it made,
       which is the whole reason none of those ids is a foreign key. */
    upsertChunked(
      tx,
      routinesTable,
      "id",
      bundle.routines.map((r) => {
        const { mcpServerIds: _m, skillIds: _s, commandIds: _c, ...columns } = r;
        return {
          ...columns,
          description: columns.description ?? null,
          sessionId: columns.sessionId ?? null,
          output: columns.output ?? null,
        };
      }),
    );
    summary.routines = bundle.routines.length;
    for (const r of bundle.routines) await writeLinks(tx, ROUTINE_LINKS, r.id, r);

    const routineIds = new Set(await (await tx.select({ id: routinesTable.id }).from(routinesTable)).map((r) => r.id));
    const ownRoutines = [...new Set(bundle.routines.map((r) => r.id))];
    /* Both children are replaced as a unit for every routine the bundle names,
       the same rule a thread's queue and log follow and for a sharper reason
       than tidiness: a trigger the user deleted would otherwise come back on a
       merge, and a run history stitched from two installs has a *newest* run
       that came from the other machine — which is exactly the row
       `lastRunHeadOid` reads to decide whether anything has changed since. */
    for (let i = 0; i < ownRoutines.length; i += CHUNK) {
      const ids = ownRoutines.slice(i, i + CHUNK);
      await tx.delete(routineTriggersTable).where(inArray(routineTriggersTable.routineId, ids));
      await tx.delete(routineRunsTable).where(inArray(routineRunsTable.routineId, ids));
    }
    const ownedRoutine = <T extends { routineId: string }>(rows: T[]): T[] => {
      const kept = rows.filter((r) => routineIds.has(r.routineId));
      summary.orphaned += rows.length - kept.length;
      return kept;
    };
    const triggers = ownedRoutine(bundle.routineTriggers).map((t) => {
      // A blank (or absent) hash where the install already holds one keeps the
      // install's — the same bargain a redacted profile key makes, so a
      // redacted bundle merged over its own install leaves every token working.
      /* No `missingSecrets` here, unlike a profile's key: `secrets=0` strips
         the hash from EVERY trigger, and a trigger that never had a token looks
         identical afterwards to one whose token was redacted — so the flag
         could only ever be raised on every install that has a schedule. */
      const was = existingTriggers.get(t.id);
      return {
        ...t,
        cron: t.cron ?? null,
        tz: t.tz ?? null,
        atMs: t.atMs ?? null,
        intervalMs: t.intervalMs ?? null,
        condition: t.condition ?? null,
        nextFireAt: t.nextFireAt ?? null,
        secretHash: t.secretHash || (was?.secretHash ?? null),
        secretCreatedAt: t.secretCreatedAt ?? was?.secretCreatedAt ?? null,
        branch: t.branch ?? null,
        lastSeen: t.lastSeen ?? null,
        lastFiredAt: t.lastFiredAt ?? null,
        lastError: t.lastError ?? null,
      };
    });
    insertChunked(tx, routineTriggersTable, triggers);
    summary.routineTriggers = triggers.length;
    const routineRuns = ownedRoutine(bundle.routineRuns).map((r) => ({
      ...r,
      triggerId: r.triggerId ?? null,
      sessionId: r.sessionId ?? null,
      payload: r.payload ?? null,
      error: r.error ?? null,
      skipReason: r.skipReason ?? null,
      inboxState: r.inboxState ?? null,
      output: r.output ?? null,
      /* `verdict` is genuinely nullable JSON and `undefined` is not a value the
         driver can bind — a run with no output schema carries none. */
      verdict: r.verdict ?? null,
      headOid: r.headOid ?? null,
      tokens: r.tokens ?? null,
      endedAt: r.endedAt ?? null,
    }));
    insertChunked(tx, routineRunsTable, routineRuns);
    summary.routineRuns = routineRuns.length;

    // The standalone tables. Boards and their columns go in before the tasks
    // that point at them, so `reconcileTaskStatuses` below has something to
    // reconcile against.
    upsertChunked(
      tx,
      boardsTable,
      "id",
      bundle.boards.map((b) => ({
        ...b,
        color: b.color ?? null,
        description: b.description ?? null,
        projectId: b.projectId ?? null,
      })),
    );
    summary.boards = bundle.boards.length;
    upsertChunked(
      tx,
      boardStatusesTable,
      "id",
      bundle.boardStatuses.map((s) => ({ ...s, color: s.color ?? null, wipLimit: s.wipLimit ?? null })),
    );
    summary.boardStatuses = bundle.boardStatuses.length;
    upsertChunked(
      tx,
      sprintsTable,
      "id",
      bundle.sprints.map((s) => ({ ...s, goal: s.goal ?? null, startAt: s.startAt ?? null, endAt: s.endAt ?? null })),
    );
    summary.sprints = bundle.sprints.length;
    upsertChunked(
      tx,
      boardViewsTable,
      "id",
      bundle.boardViews.map((v) => ({ ...v, config: v.config as BoardViewConfig })),
    );
    summary.boardViews = bundle.boardViews.length;
    upsertChunked(
      tx,
      boardListsTable,
      "id",
      bundle.boardLists.map((l) => ({ ...l, group: l.group ?? null })),
    );
    summary.boardLists = bundle.boardLists.length;
    upsertChunked(
      tx,
      tasksTable,
      "id",
      bundle.tasks.map((t) => ({
        ...t,
        description: t.description ?? null,
        assignee: t.assignee ?? null,
        assignees: t.assignees ?? [],
        listId: t.listId ?? null,
        parentId: t.parentId ?? null,
        sprintId: t.sprintId ?? null,
        estimate: t.estimate ?? null,
        timeEstimate: t.timeEstimate ?? null,
        timeTracked: t.timeTracked ?? null,
        startAt: t.startAt ?? null,
        dueAt: t.dueAt ?? null,
        completedAt: t.completedAt ?? null,
        note: t.note ?? null,
      })),
    );
    summary.tasks = bundle.tasks.length;
    upsertChunked(tx, taskCommentsTable, "id", bundle.taskComments.map((c) => ({ ...c, author: c.author ?? null })));
    summary.taskComments = bundle.taskComments.length;
    upsertChunked(tx, taskActivityTable, "id", bundle.taskActivity.map((a) => ({ ...a, from: a.from ?? null, to: a.to ?? null, actor: a.actor ?? null })));
    summary.taskActivity = bundle.taskActivity.length;
    upsertChunked(tx, taskLinksTable, "id", bundle.taskLinks);
    summary.taskLinks = bundle.taskLinks.length;
    upsertChunked(tx, usageTable, "id", bundle.webSearchUsage.map((u) => ({ ...u, completedAt: u.completedAt ?? null })));
    summary.webSearchUsage = bundle.webSearchUsage.length;
    insertChunked(tx, pushTokensTable, bundle.pushTokens);
    summary.pushTokens = bundle.pushTokens.length;
    upsertChunked(tx, notificationsTable, "id", bundle.notifications);
    summary.notifications = bundle.notifications.length;
    upsertChunked(tx, composerHistoryTable, "id", bundle.composerHistory);
    summary.composerHistory = bundle.composerHistory.length;
  });

  /* A bundle written before boards existed carries tasks and no boards, and a
     `replace` emptied the ones this install had — so re-seed, then repair any
     task left pointing at a column the bundle did not bring. Outside the
     transaction because both are idempotent and neither may take the import
     down with it: a task in the wrong column is recoverable, a rolled-back
     import is not. */
  await ensureDefaultBoard();
  summary.orphaned += await reconcileTaskStatuses();
  /* The runtime's mapping file is derived from the rows, and the rows just
     changed — rewrite it outside the transaction, exactly like the board
     re-seed above: idempotent, and never worth rolling an import back over. */
  await writeModelPromptsLibrary();

  // config.json is outside the transaction — it is a file — and is written
  // last so a failed transaction leaves it untouched.
  const ws = bundle.config.webSearch;
  if (ws) {
    const token = ws.searchApiToken || existingWebSearch?.searchApiToken || "";
    if (!token && ws.searchApiToken === undefined) summary.missingSecrets = true;
    const block: WebSearchConfig = {
      searchApiBaseUrl: ws.searchApiBaseUrl,
      searchApiToken: token,
      searchModel: ws.searchModel,
      fetchModel: ws.fetchModel,
    };
    saveWebSearch(block);
  }

  return summary;
}
