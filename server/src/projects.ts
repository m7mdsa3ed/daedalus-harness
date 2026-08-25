import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, readJson, writeJson } from "./config.js";

const McpServerSchema = z.union([
  z.object({
    type: z.literal("http"),
    name: z.string().min(1),
    url: z.string().url(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }),
  z.object({
    type: z.literal("stdio").default("stdio"),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }),
]);

// A project is the WORKSPACE a session runs in; the agent side lives in profiles.ts.
export const ProjectInputSchema = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1),
  extraInstructions: z.string().optional().default(""),
  mcpServers: z.array(McpServerSchema).default([]),
  skills: z.array(z.string()).default([]),
});

export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export type Project = ProjectInput & { id: string };

const PROJECTS_PATH = join(DATA_DIR, "projects.json");

export function listProjects(): Project[] {
  return readJson<Project[]>(PROJECTS_PATH, []);
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
