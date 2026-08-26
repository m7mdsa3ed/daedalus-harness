import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  commands as commandsTable,
  db,
  mcpServers as mcpServersTable,
  projectCommands,
  projectMcpServers,
  projectSkills,
  projects as projectsTable,
  skills as skillsTable,
} from "./db/index.js";

// A project is the WORKSPACE a session runs in; the agent side lives in profiles.ts.
// MCP servers and skills are library entries (library.ts), referenced by id.
export const ProjectInputSchema = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1),
  description: z.string().nullable().default(null),
  mcpServerIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
  commandIds: z.array(z.string()).default([]),
});

export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export type Project = ProjectInput & { id: string };

/**
 * The links, grouped by project.
 *
 * These used to be id arrays on the project record, which nothing kept honest:
 * deleting an MCP server left its id behind in every project that referenced
 * it, and the readers filtered the corpses out at spawn time. They are join
 * tables with `ON DELETE CASCADE` now, so a dangling id is not a thing that can
 * exist — which is why nothing downstream filters any more.
 */
function linksFor(projectIds: string[]) {
  const mcp = new Map<string, string[]>();
  const skill = new Map<string, string[]>();
  const command = new Map<string, string[]>();
  if (projectIds.length > 0) {
    for (const row of db
      .select()
      .from(projectMcpServers)
      .where(inArray(projectMcpServers.projectId, projectIds))
      .all()) {
      mcp.set(row.projectId, [...(mcp.get(row.projectId) ?? []), row.mcpServerId]);
    }
    for (const row of db
      .select()
      .from(projectSkills)
      .where(inArray(projectSkills.projectId, projectIds))
      .all()) {
      skill.set(row.projectId, [...(skill.get(row.projectId) ?? []), row.skillId]);
    }
    for (const row of db
      .select()
      .from(projectCommands)
      .where(inArray(projectCommands.projectId, projectIds))
      .all()) {
      command.set(row.projectId, [...(command.get(row.projectId) ?? []), row.commandId]);
    }
  }
  return { mcp, skill, command };
}

export function listProjects(): Project[] {
  const rows = db.select().from(projectsTable).all();
  const { mcp, skill, command } = linksFor(rows.map((r) => r.id));
  return rows.map((row) => ({
    ...row,
    mcpServerIds: mcp.get(row.id) ?? [],
    skillIds: skill.get(row.id) ?? [],
    commandIds: command.get(row.id) ?? [],
  }));
}

export function getProject(id: string): Project | undefined {
  const row = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
  if (!row) return undefined;
  const { mcp, skill, command } = linksFor([id]);
  return {
    ...row,
    mcpServerIds: mcp.get(id) ?? [],
    skillIds: skill.get(id) ?? [],
    commandIds: command.get(id) ?? [],
  };
}

/** Ids the library actually holds. A request naming an entry that no longer
    exists is stale, not fatal — it links what it can, which is what the old
    read-time filtering did, only now the stored state is clean too. */
function existing(
  ids: string[],
  table: typeof mcpServersTable | typeof skillsTable | typeof commandsTable,
): string[] {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const found = db
    .select({ id: table.id })
    .from(table)
    .where(inArray(table.id, unique))
    .all()
    .map((r) => r.id);
  return unique.filter((id) => found.includes(id));
}

/** The database handle inside `db.transaction` — the same query surface, minus
    the driver escape hatch, so helpers can take either. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function writeLinks(tx: Tx, id: string, input: ProjectInput): void {
  tx.delete(projectMcpServers).where(eq(projectMcpServers.projectId, id)).run();
  tx.delete(projectSkills).where(eq(projectSkills.projectId, id)).run();
  tx.delete(projectCommands).where(eq(projectCommands.projectId, id)).run();
  for (const mcpServerId of existing(input.mcpServerIds, mcpServersTable)) {
    tx.insert(projectMcpServers).values({ projectId: id, mcpServerId }).run();
  }
  for (const skillId of existing(input.skillIds, skillsTable)) {
    tx.insert(projectSkills).values({ projectId: id, skillId }).run();
  }
  for (const commandId of existing(input.commandIds, commandsTable)) {
    tx.insert(projectCommands).values({ projectId: id, commandId }).run();
  }
}

export function createProject(input: ProjectInput): Project {
  const id = randomUUID();
  db.transaction((tx) => {
    tx.insert(projectsTable).values({ id, name: input.name, cwd: input.cwd, description: input.description }).run();
    writeLinks(tx, id, input);
  });
  return getProject(id)!;
}

export function updateProject(id: string, input: ProjectInput): Project | undefined {
  const exists = db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, id)).get();
  if (!exists) return undefined;
  db.transaction((tx) => {
    tx.update(projectsTable)
      .set({ name: input.name, cwd: input.cwd, description: input.description })
      .where(eq(projectsTable.id, id))
      .run();
    writeLinks(tx, id, input);
  });
  return getProject(id);
}

/** The links go with it — that is the cascade's job, not this function's. */
export function deleteProject(id: string): boolean {
  return db.delete(projectsTable).where(eq(projectsTable.id, id)).run().changes > 0;
}
