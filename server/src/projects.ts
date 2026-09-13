import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, projects as projectsTable } from "./db/index.js";
import { helpersByProject, listHelpers, type HelperCommand } from "./project-helpers.js";

// A project is the WORKSPACE a session runs in — a directory and a name. What
// a thread brings into it (MCP servers, skills, commands) is the profile's
// and the thread's own (db/links.ts), not the project's: the same directory
// is worked on with different tools by different people. Its one extra is the
// helper commands a person runs against the workspace by hand
// (`project-helpers.ts`) — buttons, not toolset.
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
export type Project = ProjectInput & { id: string; helpers?: HelperCommand[] };

/** The column is nullable (rows predate it); the API says "" for "none",
    like a profile's `logoUrl`, so the client has one shape to read. */
const rowToProject = (row: typeof projectsTable.$inferSelect, helpers: HelperCommand[]): Project => ({
  ...row,
  logoUrl: row.logoUrl ?? "",
  previewUrl: row.previewUrl ?? "",
  helpers,
});

/** The row an input maps to — one place, so create and update cannot drift.
    Project rules are stored in the `rules` table (rules.ts), not here. */
const columns = (input: ProjectInput) => ({
  name: input.name,
  cwd: input.cwd,
  description: input.description ?? null,
  logoUrl: input.logoUrl ?? "",
  previewUrl: input.previewUrl ?? "",
});

export async function listProjects(): Promise<Project[]> {
  const rows = await db.select().from(projectsTable);
  const helpers = await helpersByProject(rows.map((r) => r.id));
  return rows.map((row) => rowToProject(row, helpers.get(row.id) ?? []));
}

export async function getProject(id: string): Promise<Project | undefined> {
  const row = (await db.select().from(projectsTable).where(eq(projectsTable.id, id)).limit(1))[0];
  return row ? rowToProject(row, await listHelpers(id)) : undefined;
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const id = randomUUID();
  await db.insert(projectsTable)
    .values({ id, ...columns(input) });
  return (await getProject(id))!;
}

export async function updateProject(id: string, input: ProjectInput): Promise<Project | undefined> {
  const changed = ((await db
    .update(projectsTable)
    .set(columns(input))
    .where(eq(projectsTable.id, id))
    ).rowCount ?? 0);
  return changed > 0 ? await getProject(id) : undefined;
}

/** Everything keyed to the project (knowledge, sessions' rows) goes with it —
    that is the cascades' job, not this function's. */
export async function deleteProject(id: string): Promise<boolean> {
  return ((await db.delete(projectsTable).where(eq(projectsTable.id, id))).rowCount ?? 0) > 0;
}
