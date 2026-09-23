import { randomUUID } from "node:crypto";
import { asc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import { db, projects as projectsTable } from "./db/index.js";
import { helpersByProject, listHelpers, type HelperCommand } from "./project-helpers.js";

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
 * appears — no model (the agent's own), no effort, no mode, no persona.
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
  personaId: string;
  mcpServerIds: string[];
  skillIds: string[];
  commandIds: string[];
  suggestFollowups: boolean;
  uiBlocks: boolean;
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
  personaId: "",
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
  suggestFollowups: true,
  uiBlocks: true,
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
  personaId: z.string().optional(),
  mcpServerIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  commandIds: z.array(z.string()).optional(),
  suggestFollowups: z.boolean().optional(),
  uiBlocks: z.boolean().optional(),
});

export type ProjectDefaultsPatch = z.infer<typeof ProjectDefaultsPatchSchema>;

/** The column value for each field, in one place so the two writers — the
    patch route and a backup import, both of which can move a single setting
    — cannot drift. Only the keys a patch names are present; a whole defaults
    object names all twelve, which is what an import wants. */
export function projectDefaultsColumns(patch: ProjectDefaultsPatch) {
  const out: Record<string, unknown> = {};
  if (patch.profileId !== undefined) out.defaultProfileId = patch.profileId || null;
  if (patch.agentId !== undefined) out.defaultAgentId = patch.agentId || null;
  if (patch.model !== undefined) out.defaultModel = patch.model || null;
  if (patch.effort !== undefined) out.defaultEffort = patch.effort || null;
  if (patch.modeId !== undefined) out.defaultModeId = patch.modeId || null;
  if (patch.configChoices !== undefined) out.defaultConfigChoices = patch.configChoices;
  if (patch.personaId !== undefined) out.defaultPersonaId = patch.personaId || null;
  if (patch.mcpServerIds !== undefined) out.defaultMcpServerIds = patch.mcpServerIds;
  if (patch.skillIds !== undefined) out.defaultSkillIds = patch.skillIds;
  if (patch.commandIds !== undefined) out.defaultCommandIds = patch.commandIds;
  if (patch.suggestFollowups !== undefined) out.defaultSuggestFollowups = patch.suggestFollowups;
  if (patch.uiBlocks !== undefined) out.defaultUiBlocks = patch.uiBlocks;
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
  personaId: row.defaultPersonaId ?? "",
  mcpServerIds: row.defaultMcpServerIds ?? [],
  skillIds: row.defaultSkillIds ?? [],
  commandIds: row.defaultCommandIds ?? [],
  suggestFollowups: row.defaultSuggestFollowups ?? true,
  uiBlocks: row.defaultUiBlocks ?? true,
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
    defaultPersonaId: _persona,
    defaultMcpServerIds: _mcp,
    defaultSkillIds: _skills,
    defaultCommandIds: _commands,
    defaultSuggestFollowups: _sf,
    defaultUiBlocks: _ui,
    ...rest
  } = row;
  return rest;
}

/** The column is nullable (rows predate it); the API says "" for "none",
    like a profile's `logoUrl`, so the client has one shape to read. */
const rowToProject = (
  row: typeof projectsTable.$inferSelect,
  helpers: HelperCommand[],
): Project => ({
  ...withoutDefaults(row),
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

export async function listProjects(): Promise<Project[]> {
  const rows = await db
    .select()
    .from(projectsTable)
    .orderBy(asc(projectsTable.sortOrder), asc(projectsTable.name));
  const helpers = await helpersByProject(rows.map((r) => r.id));
  return rows.map((row) => rowToProject(row, helpers.get(row.id) ?? []));
}

export async function getProject(id: string): Promise<Project | undefined> {
  const row = (await db.select().from(projectsTable).where(eq(projectsTable.id, id)).limit(1))[0];
  return row ? rowToProject(row, await listHelpers(id)) : undefined;
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const id = randomUUID();
  // A new project lands at the end of the list, not in the middle of an order
  // somebody arranged by hand.
  const last = (await db.select({ max: max(projectsTable.sortOrder) }).from(projectsTable))[0]?.max ?? 0;
  await db.insert(projectsTable)
    .values({ id, ...columns(input), sortOrder: last + 1 });
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
  return changed > 0 ? await getProject(id) : undefined;
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
