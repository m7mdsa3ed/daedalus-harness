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
});

/** The *input* shape, so `logoUrl` is optional to callers — routes parse it
    through the schema (which defaults it) and internal callers may omit it. */
export type ProjectInput = z.input<typeof ProjectInputSchema>;
/** `helpers` is optional in the type only so internal stubs need not carry
    it — every row the API answers has the array attached. */
export type Project = ProjectInput & { id: string; helpers?: HelperCommand[] };

/** The column is nullable (rows predate it); the API says "" for "none",
    like a profile's `logoUrl`, so the client has one shape to read. */
const rowToProject = (row: typeof projectsTable.$inferSelect, helpers: HelperCommand[]): Project => ({
  ...row,
  logoUrl: row.logoUrl ?? "",
  helpers,
});

/** The row an input maps to — one place, so create and update cannot drift. */
const columns = (input: ProjectInput) => ({
  name: input.name,
  cwd: input.cwd,
  description: input.description ?? null,
  logoUrl: input.logoUrl ?? "",
});

export function listProjects(): Project[] {
  const rows = db.select().from(projectsTable).all();
  const helpers = helpersByProject(rows.map((r) => r.id));
  return rows.map((row) => rowToProject(row, helpers.get(row.id) ?? []));
}

export function getProject(id: string): Project | undefined {
  const row = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
  return row ? rowToProject(row, listHelpers(id)) : undefined;
}

export function createProject(input: ProjectInput): Project {
  const id = randomUUID();
  db.insert(projectsTable)
    .values({ id, ...columns(input) })
    .run();
  return getProject(id)!;
}

export function updateProject(id: string, input: ProjectInput): Project | undefined {
  const changed = db
    .update(projectsTable)
    .set(columns(input))
    .where(eq(projectsTable.id, id))
    .run().changes;
  return changed > 0 ? getProject(id) : undefined;
}

/** Everything keyed to the project (knowledge, sessions' rows) goes with it —
    that is the cascades' job, not this function's. */
export function deleteProject(id: string): boolean {
  return db.delete(projectsTable).where(eq(projectsTable.id, id)).run().changes > 0;
}
