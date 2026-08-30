/* Knowledge-base entries for a project, served as a REST resource.
 *
 * This is the harness's own Drizzle path (mirrors previews.ts). The agent reaches
 * the SAME table through the `knowledge` MCP server subprocess, which opens the
 * DB directly via knowledge-db.ts (raw better-sqlite3, no harness internals).
 * Two code paths, one table — safe under WAL, and each stays consistent with its
 * own half of the harness.
 *
 * Every query is scoped by project_id, so nothing a workspace learns leaks into
 * another. The routes that call these go through the `workspace()` wrapper, so a
 * missing project surfaces as a 404, not a 500.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, knowledge as knowledgeTable } from "./db/index.js";
import { getProject, listProjects } from "./projects.js";
import { WorkspaceError } from "./workspace-fs.js";

/** The shape `POST /api/projects/:id/knowledge` accepts. */
export const KnowledgeInputSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(50_000),
  tags: z.array(z.string()).optional().default([]),
});

export type KnowledgeInput = z.infer<typeof KnowledgeInputSchema>;
export type KnowledgeEntry = typeof knowledgeTable.$inferSelect;

const fail = (status: 404, message: string) => new WorkspaceError(message, status);

export function listKnowledge(projectId: string): KnowledgeEntry[] {
  if (!getProject(projectId)) throw fail(404, "unknown project");
  return db
    .select()
    .from(knowledgeTable)
    .where(eq(knowledgeTable.projectId, projectId))
    .all()
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every entry across every project, newest-updated first, each naming its
    project — the Settings › Knowledge base page, which reads the whole store
    rather than one workspace's slice. `projectName` is resolved here so the
    client needs no join; a project deleted since cascades its rows away, so
    the name is always found. */
export function listAllKnowledge(): (KnowledgeEntry & { projectName: string })[] {
  const names = new Map(listProjects().map((p) => [p.id, p.name]));
  return db
    .select()
    .from(knowledgeTable)
    .all()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((row) => ({ ...row, projectName: names.get(row.projectId) ?? row.projectId }));
}

export function addKnowledge(projectId: string, input: KnowledgeInput): KnowledgeEntry {
  if (!getProject(projectId)) throw fail(404, "unknown project");
  const id = randomUUID();
  const now = Date.now();
  db.insert(knowledgeTable)
    .values({ id, projectId, title: input.title, content: input.content, tags: input.tags, createdAt: now, updatedAt: now })
    .run();
  return db.select().from(knowledgeTable).where(eq(knowledgeTable.id, id)).get()!;
}

export function deleteKnowledge(projectId: string, id: string): boolean {
  // Scoped to project_id so an entry can never cross projects even if ids collide.
  return (
    db
      .delete(knowledgeTable)
      .where(and(eq(knowledgeTable.projectId, projectId), eq(knowledgeTable.id, id)))
      .run().changes > 0
  );
}
