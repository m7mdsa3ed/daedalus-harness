import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, readJson, writeJson } from "./config.js";

// A project is the WORKSPACE a session runs in; the agent side lives in profiles.ts.
// MCP servers and skills are library entries (library.ts), referenced by id.
export const ProjectInputSchema = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1),
  mcpServerIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
});

export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export type Project = ProjectInput & { id: string };

const PROJECTS_PATH = join(DATA_DIR, "projects.json");

export function listProjects(): Project[] {
  // Records on disk may lack fields the schema has since gained — normalize to
  // the current shape (and drop anything stale) so the API only ever emits it.
  return readJson<Partial<Project>[]>(PROJECTS_PATH, []).map((p) => ({
    id: p.id!,
    name: p.name ?? "",
    cwd: p.cwd ?? "",
    mcpServerIds: p.mcpServerIds ?? [],
    skillIds: p.skillIds ?? [],
  }));
}

export function getProject(id: string): Project | undefined {
  return listProjects().find((p) => p.id === id);
}

export function createProject(input: ProjectInput): Project {
  const project: Project = { id: randomUUID(), ...input };
  writeJson(PROJECTS_PATH, [...listProjects(), project]);
  return project;
}

export function updateProject(id: string, input: ProjectInput): Project | undefined {
  const projects = listProjects();
  if (!projects.some((p) => p.id === id)) return undefined;
  const updated: Project = { ...input, id };
  writeJson(PROJECTS_PATH, projects.map((p) => (p.id === id ? updated : p)));
  return updated;
}

export function deleteProject(id: string): boolean {
  const projects = listProjects();
  const next = projects.filter((p) => p.id !== id);
  if (next.length === projects.length) return false;
  writeJson(PROJECTS_PATH, next);
  return true;
}
