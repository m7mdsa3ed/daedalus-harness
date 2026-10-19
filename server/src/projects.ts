import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { asc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { db, projectSpaces, projects as projectsTable, spaces as spacesTable } from "./db/index.js";
import { helpersByProject, listHelpers, type HelperCommand } from "./project-helpers.js";
import { DEFAULT_SUGGEST_KINDS, normalizeSuggestKinds, normalizeUiGroups, suggestKindsOf, UI_GROUP_IDS, uiGroupsOf } from "./personas.js";
import { defaultSpaceId } from "./spaces.js";

// A project is the WORKSPACE a session runs in — a directory and a name. What
// a thread brings into it (MCP servers, skills, commands) is the profile's
// and the thread's own (db/links.ts), not the project's: the same directory
// is worked on with different tools by different people. Its two extras are
// the helper commands a person runs against the workspace by hand
// (`project-helpers.ts`) and the settings a thread started here opens on
// (`ProjectDefaults` below).
export const ProjectInputSchema = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1),
  /** The spaces this project is filed under (at least one). Optional: a create
      that names none lands in the default space (`defaultSpaceId`), and an
      update that omits it leaves the project's spaces alone rather than
      clearing them. */
  spaceIds: z.array(z.string().min(1)).min(1).optional(),
  /** Legacy single-space spelling, kept so older callers (the harness tool, an
      old client) keep working; `spaceIds` wins when both are sent. */
  spaceId: z.string().optional(),
  description: z.string().nullable().default(null),
  /** Optional — a URL. Empty means "no logo of its own"; the client draws
      the project's initial instead. */
  logoUrl: z.string().optional().default(""),
  /** The project's dev server, as the Browser panel should open it. Empty
      means none. What it is reachable *at* is the person's own call —
      `localhost` for the machine the server runs on, a LAN or tunnel address
      for a phone. */
  previewUrl: z.string().optional().default(""),
});

/** The *input* shape, so `logoUrl` is optional to callers — routes parse it
    through the schema (which defaults it) and internal callers may omit it. */
export type ProjectInput = z.input<typeof ProjectInputSchema>;
/** `helpers` is optional in the type only so internal stubs need not carry
    it — every row the API answers has the array attached. Project rules
    are stored in the `rules` table (rules.ts), not as a column here. */
export type Project = ProjectInput & {
  id: string;
  helpers?: HelperCommand[];
  /** How a thread started in this project opens. Optional in the type for the
      same reason `helpers` is — internal stubs (a quota probe's cwd, the
      status handshake's) carry a directory and nothing else — while every row
      the API answers has it: `rowToProject` folds the columns into it, so the
      client never has to tell an absent field from an empty one. */
  defaults?: ProjectDefaults;
};

/**
 * What a thread started in this project opens on.
 *
 * The client's shape, not the row's: the columns are nullable and this is
 * every-field-present, because every one of these is a value a draft holds
 * anyway and a menu reads as a string. `""` is the empty pick everywhere it
 * appears — no model (the agent's own), no effort, no mode.
 *
 * `profileId`/`agentId` are the pair `resolveProfileAgent` resolves at spawn,
 * and are deliberately *not* resolved here: which profiles exist is the
 * client's catalog, and a project naming a profile that has since gone simply
 * loses that half (`thread-defaults.ts`).
 */
export interface ProjectDefaults {
  profileId: string;
  agentId: string;
  model: string;
  effort: string;
  modeId: string;
  configChoices: Record<string, string | boolean>;
  mcpServerIds: string[];
  skillIds: string[];
  commandIds: string[];
  suggestKinds: string[];
  /** The component groups drawn answers teach (`UI_GROUP_IDS`); empty = drawn
      answers off, otherwise "layout" is always in. */
  uiGroups: string[];
  /** "" = no say: the thread's profile, then the global default, picks. */
  voiceProvider: string;
  /** Profile per agent id a new thread's `ask_agent` starts with. */
  askProfiles: Record<string, { profileId: string; model?: string }>;
}

/** An empty set of defaults — a project nobody has worked in yet. Every field
    is the value a draft with nothing remembered carries. */
export const emptyDefaults = (): ProjectDefaults => ({
  profileId: "",
  agentId: "",
  model: "",
  effort: "",
  modeId: "",
  configChoices: {},
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
  suggestKinds: [...DEFAULT_SUGGEST_KINDS],
  uiGroups: [...UI_GROUP_IDS],
  voiceProvider: "",
  askProfiles: {},
});

/**
 * The patch `PATCH /api/projects/:id/defaults` takes: only the fields a pick
 * moved. Absent means unchanged, which is what lets the client publish one
 * setting at a time without sending the rest of the row back and racing
 * another device's pick. `null` is not a value here — `""` is the empty one —
 * because the reader's shape has no second empty.
 */
export const ProjectDefaultsPatchSchema = z.object({
  profileId: z.string().optional(),
  agentId: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  modeId: z.string().optional(),
  configChoices: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  mcpServerIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  commandIds: z.array(z.string()).optional(),
  suggestKinds: z.array(z.string()).optional(),
  uiGroups: z.array(z.string()).optional(),
  voiceProvider: z.string().optional(),
  askProfiles: z.record(z.string(), z.object({ profileId: z.string(), model: z.string().optional() })).optional(),
});

export type ProjectDefaultsPatch = z.infer<typeof ProjectDefaultsPatchSchema>;

/** The column value for each field, in one place so the two writers — the
    patch route and a backup import, both of which can move a single setting
    — cannot drift. Only the keys a patch names are present; a whole defaults
    object names all eleven, which is what an import wants. */
export function projectDefaultsColumns(patch: ProjectDefaultsPatch) {
  const out: Record<string, unknown> = {};
  if (patch.profileId !== undefined) out.defaultProfileId = patch.profileId || null;
  if (patch.agentId !== undefined) out.defaultAgentId = patch.agentId || null;
  if (patch.model !== undefined) out.defaultModel = patch.model || null;
  if (patch.effort !== undefined) out.defaultEffort = patch.effort || null;
  if (patch.modeId !== undefined) out.defaultModeId = patch.modeId || null;
  if (patch.configChoices !== undefined) out.defaultConfigChoices = patch.configChoices;
  if (patch.mcpServerIds !== undefined) out.defaultMcpServerIds = patch.mcpServerIds;
  if (patch.skillIds !== undefined) out.defaultSkillIds = patch.skillIds;
  if (patch.commandIds !== undefined) out.defaultCommandIds = patch.commandIds;
  if (patch.suggestKinds !== undefined) out.defaultSuggestKinds = normalizeSuggestKinds(patch.suggestKinds);
  if (patch.uiGroups !== undefined) out.defaultUiGroups = normalizeUiGroups(patch.uiGroups);
  if (patch.voiceProvider !== undefined) out.defaultVoiceProvider = patch.voiceProvider || null;
  if (patch.askProfiles !== undefined) out.defaultAskProfiles = Object.keys(patch.askProfiles).length ? patch.askProfiles : null;
  return out;
}

/** The columns read back as the client's whole-field shape. A row from before
    any of these columns existed reads as the empty defaults, which is what
    "nobody has picked yet" means — never as a value invented here. */
export const projectDefaultsOf = (row: typeof projectsTable.$inferSelect): ProjectDefaults => ({
  profileId: row.defaultProfileId ?? "",
  agentId: row.defaultAgentId ?? "",
  model: row.defaultModel ?? "",
  effort: row.defaultEffort ?? "",
  modeId: row.defaultModeId ?? "",
  configChoices: row.defaultConfigChoices ?? {},
  mcpServerIds: row.defaultMcpServerIds ?? [],
  skillIds: row.defaultSkillIds ?? [],
  commandIds: row.defaultCommandIds ?? [],
  suggestKinds: suggestKindsOf(row.defaultSuggestKinds, row.defaultSuggestFollowups),
  uiGroups: uiGroupsOf(row.defaultUiGroups, row.defaultUiBlocks),
  voiceProvider: row.defaultVoiceProvider ?? "",
  askProfiles: row.defaultAskProfiles ?? {},
});

/** A project row with the start-default columns taken off it.
 *
 * They are folded into `defaults` on the wire and never sent beside it: a row
 * arriving with both `default_model` and `defaults.model` would be two shapes
 * for one fact, which is the drift `projectDefaultsColumns` exists to stop
 * from the writing end. Both readers of a row — `rowToProject` and a backup
 * export — go through this so there is one list of the columns to keep in
 * step with `projectDefaultsColumns`. */
export function withoutDefaults(row: typeof projectsTable.$inferSelect) {
  const {
    defaultProfileId: _p,
    defaultAgentId: _a,
    defaultModel: _m,
    defaultEffort: _e,
    defaultModeId: _mode,
    defaultConfigChoices: _cc,
    defaultMcpServerIds: _mcp,
    defaultSkillIds: _skills,
    defaultCommandIds: _commands,
    defaultSuggestFollowups: _sf,
    defaultSuggestKinds: _sk,
    defaultUiBlocks: _ui,
    defaultUiGroups: _ug,
    defaultVoiceProvider: _vp,
    spaceId: _space,
    ...rest
  } = row;
  return rest;
}

/** The column is nullable (rows predate it); the API says "" for "none",
    like a profile's `logoUrl`, so the client has one shape to read. */
const rowToProject = (
  row: typeof projectsTable.$inferSelect,
  helpers: HelperCommand[],
  spaceIds: string[],
): Project => ({
  ...withoutDefaults(row),
  spaceIds,
  logoUrl: row.logoUrl ?? "",
  previewUrl: row.previewUrl ?? "",
  helpers,
  defaults: projectDefaultsOf(row),
});

/** The row an input maps to — one place, so create and update cannot drift.
    Project rules are stored in the `rules` table (rules.ts), not here, and so
    are the start defaults: they have their own route (`setProjectDefaults`)
    because a request that moved one setting must not rewrite the other eleven
    from a stale copy of the row. */
const columns = (input: ProjectInput) => ({
  name: input.name,
  cwd: input.cwd,
  description: input.description ?? null,
  logoUrl: input.logoUrl ?? "",
  previewUrl: input.previewUrl ?? "",
});

/** Each project's spaces, in the switcher's order, so "the first space" is the
    same one everywhere a client has to pick. */
async function spaceIdsByProject(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ projectId: projectSpaces.projectId, spaceId: projectSpaces.spaceId })
    .from(projectSpaces)
    .innerJoin(spacesTable, eq(spacesTable.id, projectSpaces.spaceId))
    .where(inArray(projectSpaces.projectId, ids))
    .orderBy(asc(spacesTable.sortOrder), asc(spacesTable.name));
  for (const row of rows) out.set(row.projectId, [...(out.get(row.projectId) ?? []), row.spaceId]);
  return out;
}

/** Replace a project's spaces with exactly these. Unknown ids are an error, not
    a silent skip: the caller asked for a place that does not exist. */
async function setProjectSpaces(projectId: string, spaceIds: string[]): Promise<void> {
  const ids = [...new Set(spaceIds)];
  const known = await db.select({ id: spacesTable.id }).from(spacesTable).where(inArray(spacesTable.id, ids));
  if (known.length !== ids.length) throw new Error("Unknown space.");
  await db.transaction(async (tx) => {
    await tx.delete(projectSpaces).where(eq(projectSpaces.projectId, projectId));
    await tx.insert(projectSpaces).values(ids.map((spaceId) => ({ projectId, spaceId })));
  });
}

/** The ids an input names, spelling either way. */
const inputSpaceIds = (input: ProjectInput): string[] | undefined =>
  input.spaceIds ?? (input.spaceId ? [input.spaceId] : undefined);

/** Every project, or only one space's — the sidebar and the pickers that are
    scoped to the space in front of you ask for the second. A project in several
    spaces is in each one's list. */
export async function listProjects(spaceId?: string): Promise<Project[]> {
  const rows = await db
    .select()
    .from(projectsTable)
    .where(
      spaceId
        ? inArray(
            projectsTable.id,
            db.select({ id: projectSpaces.projectId }).from(projectSpaces).where(eq(projectSpaces.spaceId, spaceId)),
          )
        : undefined,
    )
    .orderBy(asc(projectsTable.sortOrder), asc(projectsTable.name));
  const ids = rows.map((r) => r.id);
  const [helpers, spaces] = await Promise.all([helpersByProject(ids), spaceIdsByProject(ids)]);
  return rows.map((row) => rowToProject(row, helpers.get(row.id) ?? [], spaces.get(row.id) ?? []));
}

export async function getProject(id: string): Promise<Project | undefined> {
  const row = (await db.select().from(projectsTable).where(eq(projectsTable.id, id)).limit(1))[0];
  return row
    ? rowToProject(row, await listHelpers(id), (await spaceIdsByProject([id])).get(id) ?? [])
    : undefined;
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const id = randomUUID();
  /* The deliberate creation of the directory (`ensureProjectDir` no longer makes
     it on a spawn): a project made here has a cwd, and one deleted later is a
     spawn error rather than a silently recreated empty folder. */
  mkdirSync(input.cwd, { recursive: true });
  // A new project lands at the end of the list, not in the middle of an order
  // somebody arranged by hand.
  const last = (await db.select({ max: max(projectsTable.sortOrder) }).from(projectsTable))[0]?.max ?? 0;
  /* A create that names no space gets the default one — a project in no space
     would be invisible in every one. */
  const spaceIds = inputSpaceIds(input) ?? [await defaultSpaceId()];
  await db.insert(projectsTable).values({ id, ...columns(input), sortOrder: last + 1 });
  try {
    await setProjectSpaces(id, spaceIds);
  } catch (error) {
    await db.delete(projectsTable).where(eq(projectsTable.id, id));
    throw error;
  }
  return (await getProject(id))!;
}

/** Reorder by the ids the client hands back, in the order it drew them. Ids
    the caller does not name keep their relative order *after* the named ones:
    a stale list from a second tab reorders what it knew about and never drops
    or shuffles a project it had not seen. */
export async function reorderProjects(ids: string[]): Promise<Project[]> {
  if (ids.length > 0) {
    await db.transaction(async (tx) => {
      // Unnamed rows are pushed past the named block so the two halves cannot
      // interleave; ordering within each half is preserved.
      await tx.update(projectsTable).set({ sortOrder: sql`${projectsTable.sortOrder} + ${ids.length}` });
      for (const [i, id] of ids.entries()) {
        await tx.update(projectsTable).set({ sortOrder: i }).where(eq(projectsTable.id, id));
      }
    });
  }
  return await listProjects();
}

export async function updateProject(id: string, input: ProjectInput): Promise<Project | undefined> {
  const changed = ((await db
    .update(projectsTable)
    .set(columns(input))
    .where(eq(projectsTable.id, id))
    ).rowCount ?? 0);
  if (changed === 0) return undefined;
  const spaceIds = inputSpaceIds(input);
  if (spaceIds) await setProjectSpaces(id, spaceIds);
  return await getProject(id);
}

/**
 * Move some of a project's start defaults.
 *
 * Its own door rather than the project editor's `PUT`: the client writes this
 * from a composer picker dozens of times a day, and the editor does not hold
 * the rest of the row to send back with it. Only the keys the patch names are
 * written, so a second device's pick landing meanwhile is not clobbered by a
 * stale copy of the fields neither request touched.
 *
 * Answers the whole project, like every other write the catalog invalidates
 * on — the client's cache is the list, so the response is also the fresh row.
 */
export async function setProjectDefaults(
  id: string,
  patch: ProjectDefaultsPatch,
): Promise<Project | undefined> {
  const values = projectDefaultsColumns(patch);
  if (Object.keys(values).length > 0) {
    const changed = ((await db
      .update(projectsTable)
      .set(values)
      .where(eq(projectsTable.id, id))
      ).rowCount ?? 0);
    if (changed === 0) return undefined;
  }
  return await getProject(id);
}

/** Everything keyed to the project (knowledge, sessions' rows) goes with it —
    that is the cascades' job, not this function's. */
export async function deleteProject(id: string): Promise<boolean> {
  return ((await db.delete(projectsTable).where(eq(projectsTable.id, id))).rowCount ?? 0) > 0;
}
