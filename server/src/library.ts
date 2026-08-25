import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, readJson, writeJson } from "./config.js";

// Reusable building blocks projects link to by id: MCP servers are sent to the
// agent in ACP session/new (by the client); skills are symlinked into the
// project cwd at spawn (by the server — see materialize.ts).

export const McpServerInputSchema = z.union([
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

export const SkillInputSchema = z.object({
  name: z.string().min(1),
  /** Directory on the server holding SKILL.md. */
  path: z.string().min(1),
});

export type McpServerInput = z.infer<typeof McpServerInputSchema>;
export type SkillInput = z.infer<typeof SkillInputSchema>;
export type McpServerDef = McpServerInput & { id: string };
export type SkillDef = SkillInput & { id: string };

/** Flat id-keyed JSON list — the same CRUD profiles.ts/projects.ts spell out. */
function registry<I extends object>(file: string) {
  type T = I & { id: string };
  const path = join(DATA_DIR, file);
  const list = (): T[] => readJson<T[]>(path, []);
  return {
    list,
    create(input: I): T {
      const item = { id: randomUUID(), ...input } as T;
      writeJson(path, [...list(), item]);
      return item;
    },
    update(id: string, input: I): T | undefined {
      const items = list();
      if (!items.some((i) => i.id === id)) return undefined;
      const updated = { ...input, id } as T;
      writeJson(
        path,
        items.map((i) => (i.id === id ? updated : i)),
      );
      return updated;
    },
    remove(id: string): boolean {
      const items = list();
      const next = items.filter((i) => i.id !== id);
      if (next.length === items.length) return false;
      writeJson(path, next);
      return true;
    },
  };
}

export const mcpServers = registry<McpServerInput>("mcp-servers.json");
export const skills = registry<SkillInput>("skills.json");
