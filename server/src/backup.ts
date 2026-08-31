import { getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import {
  agentOptions as agentOptionsTable,
  USAGE_KINDS,
  agents as agentsTable,
  commands as commandsTable,
  db,
  knowledge as knowledgeTable,
  mcpServers as mcpServersTable,
  profiles as profilesTable,
  projectPreviews as previewsTable,
  projects as projectsTable,
  pushTokens as pushTokensTable,
  scheduledMessages as scheduledTable,
  sessionEvents as eventsTable,
  sessionQueue as queueTable,
  sessions as sessionsTable,
  skills as skillsTable,
  boards as boardsTable,
  boardStatuses as boardStatusesTable,
  tasks as tasksTable,
  webSearchUsage as usageTable,
  workflowRuns as workflowRunsTable,
  type NameValue,
} from "./db/index.js";
import { PROFILE_LINKS, SESSION_LINKS, emptyLinks, readLinks, writeLinks, type LinkSet, type Tx } from "./db/links.js";
import { readWebSearch, saveWebSearch, type WebSearchConfig } from "./config.js";
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
    })
    .nullish(),
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
  modalities: z.array(str).optional(),
  devRef: str.optional(),
});

const ProfileRow = z.object({
  id: str.min(1),
  name: str,
  agents: z.record(str, z.object({ baseUrl: str.optional() })).default({}),
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
  models: z.array(ModelRow).default([]),
  mcpServerIds: z.array(str).default([]),
  skillIds: z.array(str).default([]),
  commandIds: z.array(str).default([]),
});

const McpServerRow = z.object({
  id: str.min(1),
  type: z.enum(["http", "stdio", "builtin"]),
  name: str,
  builtin: z.enum(["web-search", "knowledge", "workflow"]).nullish(),
  url: optStr,
  headers: nameValues.nullish(),
  command: optStr,
  args: z.array(str).nullish(),
  env: nameValues.nullish(),
});

const SkillRow = z.object({ id: str.min(1), name: str, path: str });

const CommandRow = z.object({
  id: str.min(1),
  name: str,
  description: str,
  argumentHint: optStr,
  content: str,
});

const ProjectRow = z.object({
  id: str.min(1),
  name: str,
  cwd: str,
  description: optStr,
  logoUrl: optStr,
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

const PreviewRow = z.object({
  id: str.min(1),
  projectId: str.min(1),
  label: str,
  url: str,
  createdAt: int,
});

const SessionRow = z.object({
  id: str.min(1),
  profileId: str,
  projectId: str,
  agentId: str,
  model: str.default(""),
  effort: str.default(""),
  title: str.default("New thread"),
  acpSessionId: optStr,
  acpSessionProvisional: z.boolean().default(false),
  createdAt: int,
  /* Absent in a bundle written before threads were ordered by activity; 0 is
     what `reload` backfills from the imported journal. */
  lastActivityAt: int.default(0),
  deletedAt: int.nullish(),
  parentSessionId: optStr,
  mcpServerIds: z.array(str).default([]),
  skillIds: z.array(str).default([]),
  commandIds: z.array(str).default([]),
});

const QueueRow = z.object({
  id: str.min(1),
  sessionId: str.min(1),
  position: int,
  text: str,
  createdAt: int,
});

const ScheduledRow = z.object({
  id: str.min(1),
  sessionId: str.min(1),
  text: str,
  nextAt: int,
  everyMs: int.nullish(),
  createdAt: int,
});

const WorkflowRunRow = z.object({
  id: str.min(1),
  parentSessionId: str.min(1),
  name: str,
  definition: z.record(z.string(), z.unknown()),
  inputs: z.record(z.string(), z.unknown()),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  error: optStr,
  steps: z.array(
    z.object({
      name: str,
      status: z.enum(["pending", "running", "completed", "failed", "cancelled", "skipped"]),
      sessionId: str.nullable(),
      attempt: int,
      output: z.unknown(),
      error: str.nullable(),
      startedAt: int.nullable(),
      endedAt: int.nullable(),
    }),
  ),
  createdAt: int,
  endedAt: int.nullish(),
});

const EventRow = z.object({
  sessionId: str.min(1),
  seq: int,
  kind: str,
  payload: json,
  at: int.default(0),
});

const BoardRow = z.object({
  id: str.min(1),
  name: str,
  color: optStr,
  order: int.default(0),
  createdAt: int,
  updatedAt: int,
});

const BoardStatusRow = z.object({
  id: str.min(1),
  boardId: str.min(1),
  name: str,
  color: optStr,
  order: int.default(0),
  createdAt: int,
  updatedAt: int,
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
    title: str,
    description: optStr,
    statusId: str.default("todo"),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    labels: z.array(str).default([]),
    assignee: optStr,
    dueAt: int.nullish(),
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
  skills: z.array(SkillRow).default([]),
  commands: z.array(CommandRow).default([]),
  projects: z.array(ProjectRow).default([]),
  knowledge: z.array(KnowledgeRow).default([]),
  previews: z.array(PreviewRow).default([]),
  sessions: z.array(SessionRow).default([]),
  queue: z.array(QueueRow).default([]),
  scheduled: z.array(ScheduledRow).default([]),
  workflowRuns: z.array(WorkflowRunRow).default([]),
  events: z.array(EventRow).default([]),
  boards: z.array(BoardRow).default([]),
  boardStatuses: z.array(BoardStatusRow).default([]),
  tasks: z.array(TaskRow).default([]),
  webSearchUsage: z.array(UsageRow).default([]),
  pushTokens: z.array(PushTokenRow).default([]),
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
export function exportBundle(opts: ExportOptions): Bundle {
  const profiles = db.select().from(profilesTable).all();
  const sessions = db.select().from(sessionsTable).all();
  const mcpServers = db.select().from(mcpServersTable).all();
  const webSearch = readWebSearch();

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    redacted: { secrets: !opts.includeSecrets, journals: !opts.includeJournals },
    agents: db.select().from(agentsTable).all(),
    profiles: withLinks(profiles, readLinks(PROFILE_LINKS, profiles.map((p) => p.id))).map((p) => {
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
    skills: db.select().from(skillsTable).all(),
    commands: db.select().from(commandsTable).all(),
    projects: db.select().from(projectsTable).all(),
    knowledge: db.select().from(knowledgeTable).all(),
    previews: db.select().from(previewsTable).all(),
    sessions: withLinks(sessions, readLinks(SESSION_LINKS, sessions.map((s) => s.id))),
    queue: db.select().from(queueTable).all(),
    scheduled: db.select().from(scheduledTable).all(),
    workflowRuns: db.select().from(workflowRunsTable).all(),
    events: opts.includeJournals
      ? db.select().from(eventsTable).orderBy(eventsTable.sessionId, eventsTable.seq).all()
      : [],
    boards: db.select().from(boardsTable).all(),
    boardStatuses: db.select().from(boardStatusesTable).all(),
    tasks: db.select().from(tasksTable).all(),
    webSearchUsage: db.select().from(usageTable).all(),
    pushTokens: db.select().from(pushTokensTable).all(),
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
  | "agents" | "profiles" | "mcpServers" | "skills" | "commands" | "projects" | "knowledge" | "previews"
  | "sessions" | "queue" | "scheduled" | "workflowRuns" | "events" | "boards" | "boardStatuses" | "tasks"
  | "webSearchUsage" | "pushTokens",
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
function insertChunked<T extends object>(tx: Tx, table: SQLiteTable, rows: T[]): void {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK) as Record<string, unknown>[];
    if (chunk.length === 0) continue;
    tx.insert(table).values(chunk).onConflictDoNothing().run();
  }
}

/**
 * Upsert by primary key WITHOUT cascading: `INSERT … ON CONFLICT DO UPDATE`
 * over every column the row carries (`INSERT OR REPLACE` is a delete-then-
 * insert, and the delete would fire ON DELETE CASCADE on the row's children —
 * a merged profile would lose its links, a merged project its knowledge).
 * Columns the bundle's rows do not carry are left as the install has them.
 */
function upsertChunked(tx: Tx, table: SQLiteTable, key: string, rows: Record<string, unknown>[]): void {
  const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
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
    tx.insert(table).values(normalized).onConflictDoUpdate({ target, set }).run();
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
 * Write a bundle into the database. Synchronous and in one transaction — the
 * caller has already retired whatever processes the rows it touches belong
 * to, and reloads the SessionManager afterwards.
 */
export function importBundle(bundle: Bundle, mode: ImportMode): ImportSummary {
  const summary: ImportSummary = {
    agents: 0, profiles: 0, mcpServers: 0, skills: 0, commands: 0, projects: 0, knowledge: 0, previews: 0,
    sessions: 0, queue: 0, scheduled: 0, workflowRuns: 0, events: 0, boards: 0, boardStatuses: 0, tasks: 0,
    webSearchUsage: 0, pushTokens: 0,
    orphaned: 0, missingSecrets: false,
  };

  // Read what the install holds BEFORE the transaction empties it — the
  // secrets a redacted bundle is allowed to keep.
  const existingProfiles = new Map(db.select().from(profilesTable).all().map((p) => [p.id, p]));
  const existingMcp = new Map(db.select().from(mcpServersTable).all().map((s) => [s.id, s]));
  const existingWebSearch = readWebSearch();

  db.transaction((tx) => {
    if (mode === "replace") {
      // Children first only for readability — every child table cascades from
      // its parent, and the ones that do not (usage, tokens, tasks) stand alone.
      for (const table of [
        sessionsTable, profilesTable, projectsTable, mcpServersTable, skillsTable, commandsTable,
        agentsTable, tasksTable, boardStatusesTable, boardsTable, usageTable, pushTokensTable,
        agentOptionsTable,
      ]) {
        tx.delete(table).run();
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
      return { ...columns, smallModel: columns.smallModel ?? "", logoUrl: columns.logoUrl ?? "", usage: columns.usage ?? null };
    });
    upsertChunked(tx, profilesTable, "id", profileRows);
    summary.profiles = bundle.profiles.length;

    upsertChunked(
      tx,
      mcpServersTable,
      "id",
      bundle.mcpServers.map((s) => {
        const was = existingMcp.get(s.id);
        return {
          ...s,
          builtin: s.builtin ?? null,
          url: s.url ?? null,
          command: s.command ?? null,
          args: s.args ?? null,
          headers: keepPairs(s.headers, was?.headers),
          env: keepPairs(s.env, was?.env),
        };
      }),
    );
    summary.mcpServers = bundle.mcpServers.length;

    upsertChunked(tx, skillsTable, "id", bundle.skills);
    summary.skills = bundle.skills.length;
    upsertChunked(tx, commandsTable, "id", bundle.commands.map((c) => ({ ...c, argumentHint: c.argumentHint ?? null })));
    summary.commands = bundle.commands.length;
    upsertChunked(
      tx,
      projectsTable,
      "id",
      bundle.projects.map((p) => ({ ...p, description: p.description ?? null, logoUrl: p.logoUrl ?? "" })),
    );
    summary.projects = bundle.projects.length;

    /* The link tables are replaced wholesale per owner: `writeLinks` drops the
       owner's rows and re-adds only ids the library actually holds, so a
       bundle naming a server this install never had links nothing. */
    for (const p of bundle.profiles) writeLinks(tx, PROFILE_LINKS, p.id, p);

    // Children of projects. A row whose project exists nowhere is dropped, not
    // fatal — the foreign key would refuse it and take the whole import down.
    const projectIds = new Set(tx.select({ id: projectsTable.id }).from(projectsTable).all().map((r) => r.id));
    const knowledge = bundle.knowledge.filter((k) => projectIds.has(k.projectId));
    summary.orphaned += bundle.knowledge.length - knowledge.length;
    upsertChunked(tx, knowledgeTable, "id", knowledge.map((k) => ({ ...k, tags: k.tags ?? null })));
    summary.knowledge = knowledge.length;
    const previews = bundle.previews.filter((p) => projectIds.has(p.projectId));
    summary.orphaned += bundle.previews.length - previews.length;
    upsertChunked(tx, previewsTable, "id", previews);
    summary.previews = previews.length;

    // Sessions and everything hanging off them.
    upsertChunked(
      tx,
      sessionsTable,
      "id",
      bundle.sessions.map((s) => {
        const { mcpServerIds: _m, skillIds: _s, commandIds: _c, ...columns } = s;
        return {
          ...columns,
          acpSessionId: columns.acpSessionId ?? null,
          deletedAt: columns.deletedAt ?? null,
          parentSessionId: columns.parentSessionId ?? null,
        };
      }),
    );
    summary.sessions = bundle.sessions.length;
    for (const s of bundle.sessions) writeLinks(tx, SESSION_LINKS, s.id, s);

    const sessionIds = new Set(tx.select({ id: sessionsTable.id }).from(sessionsTable).all().map((r) => r.id));
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
        tx.delete(queueTable).where(inArray(queueTable.sessionId, ids)).run();
        tx.delete(scheduledTable).where(inArray(scheduledTable.sessionId, ids)).run();
        tx.delete(workflowRunsTable).where(inArray(workflowRunsTable.parentSessionId, ids)).run();
        if (!bundle.redacted.journals) tx.delete(eventsTable).where(inArray(eventsTable.sessionId, ids)).run();
      }
    }
    const queue = keep(bundle.queue);
    insertChunked(tx, queueTable, queue);
    summary.queue = queue.length;
    const scheduled = keep(bundle.scheduled.map((s) => ({ ...s, everyMs: s.everyMs ?? null })));
    insertChunked(tx, scheduledTable, scheduled);
    summary.scheduled = scheduled.length;
    const runs = bundle.workflowRuns.filter((r) => sessionIds.has(r.parentSessionId));
    summary.orphaned += bundle.workflowRuns.length - runs.length;
    insertChunked(
      tx,
      workflowRunsTable,
      runs.map((r) => ({ ...r, error: r.error ?? null, endedAt: r.endedAt ?? null })),
    );
    summary.workflowRuns = runs.length;
    const events = keep(bundle.events);
    insertChunked(tx, eventsTable, events);
    summary.events = events.length;

    // The standalone tables. Boards and their columns go in before the tasks
    // that point at them, so `reconcileTaskStatuses` below has something to
    // reconcile against.
    upsertChunked(tx, boardsTable, "id", bundle.boards.map((b) => ({ ...b, color: b.color ?? null })));
    summary.boards = bundle.boards.length;
    upsertChunked(
      tx,
      boardStatusesTable,
      "id",
      bundle.boardStatuses.map((s) => ({ ...s, color: s.color ?? null })),
    );
    summary.boardStatuses = bundle.boardStatuses.length;
    upsertChunked(
      tx,
      tasksTable,
      "id",
      bundle.tasks.map((t) => ({
        ...t,
        description: t.description ?? null,
        assignee: t.assignee ?? null,
        dueAt: t.dueAt ?? null,
        note: t.note ?? null,
      })),
    );
    summary.tasks = bundle.tasks.length;
    upsertChunked(tx, usageTable, "id", bundle.webSearchUsage.map((u) => ({ ...u, completedAt: u.completedAt ?? null })));
    summary.webSearchUsage = bundle.webSearchUsage.length;
    insertChunked(tx, pushTokensTable, bundle.pushTokens);
    summary.pushTokens = bundle.pushTokens.length;
  });

  /* A bundle written before boards existed carries tasks and no boards, and a
     `replace` emptied the ones this install had — so re-seed, then repair any
     task left pointing at a column the bundle did not bring. Outside the
     transaction because both are idempotent and neither may take the import
     down with it: a task in the wrong column is recoverable, a rolled-back
     import is not. */
  ensureDefaultBoard();
  summary.orphaned += reconcileTaskStatuses();

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
