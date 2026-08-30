import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, projects as projectsTable } from "./db/index.js";

// A project is the WORKSPACE a session runs in — a directory and a name. What
// a thread brings into it (MCP servers, skills, commands) is the profile's
// and the thread's own (db/links.ts), not the project's: the same directory
// is worked on with different tools by different people.
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
export type Project = ProjectInput & { id: string };

/** The column is nullable (rows predate it); the API says "" for "none",
    like a profile's `logoUrl`, so the client has one shape to read. */
const rowToProject = (row: typeof projectsTable.$inferSelect): Project => ({
  ...row,
  logoUrl: row.logoUrl ?? "",
});

export function listProjects(): Project[] {
  return db.select().from(projectsTable).all().map(rowToProject);
}

export function getProject(id: string): Project | undefined {
  const row = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
  return row ? rowToProject(row) : undefined;
}

export function createProject(input: ProjectInput): Project {
  const id = randomUUID();
  db.insert(projectsTable)
    .values({ id, name: input.name, cwd: input.cwd, description: input.description ?? null, logoUrl: input.logoUrl ?? "" })
    .run();
  return getProject(id)!;
}

export function updateProject(id: string, input: ProjectInput): Project | undefined {
  const changed = db
    .update(projectsTable)
    .set({ name: input.name, cwd: input.cwd, description: input.description ?? null, logoUrl: input.logoUrl ?? "" })
    .where(eq(projectsTable.id, id))
    .run().changes;
  return changed > 0 ? getProject(id) : undefined;
}

/** Everything keyed to the project (knowledge, previews, sessions' rows) goes
    with it — that is the cascades' job, not this function's. */
export function deleteProject(id: string): boolean {
  return db.delete(projectsTable).where(eq(projectsTable.id, id)).run().changes > 0;
}
