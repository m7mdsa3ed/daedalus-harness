import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  commands as commandsTable,
  db,
  mcpServers as mcpServersTable,
  skills as skillsTable,
} from "./db/index.js";

// Reusable building blocks projects link to by id: MCP servers are sent to the
// agent in ACP session/new (see sessions.mcpServersFor); skills are symlinked
// into the project cwd at spawn and slash commands written into
// <cwd>/.claude/commands (see materialize.ts).
//
// Projects reference these through join tables, so deleting one here removes
// the link everywhere it was used rather than leaving a dangling id behind.

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

export const CommandInputSchema = z.object({
  /** Becomes `/name` and `<name>.md` in <cwd>/.claude/commands — so it has to
      be a safe filename, not just non-empty. */
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "letters, digits, . _ - only"),
  description: z.string().min(1),
  argumentHint: z.string().nullable().default(null),
  /** Markdown prompt body; `$ARGUMENTS` receives the typed arguments. */
  content: z.string().min(1),
});

export type McpServerInput = z.infer<typeof McpServerInputSchema>;
export type SkillInput = z.infer<typeof SkillInputSchema>;
export type CommandInput = z.infer<typeof CommandInputSchema>;
export type McpServerDef = McpServerInput & { id: string };
export type SkillDef = SkillInput & { id: string };
export type CommandDef = CommandInput & { id: string };

type McpRow = typeof mcpServersTable.$inferSelect;

/** The table holds both variants in one row shape — the columns the other
    variant uses are null. These two functions are the only place that knows. */
function toDef(row: McpRow): McpServerDef {
  return row.type === "http"
    ? { id: row.id, type: "http", name: row.name, url: row.url ?? "", headers: row.headers ?? [] }
    : {
        id: row.id,
        type: "stdio",
        name: row.name,
        command: row.command ?? "",
        args: row.args ?? [],
        env: row.env ?? [],
      };
}

function toRow(id: string, input: McpServerInput): typeof mcpServersTable.$inferInsert {
  return input.type === "http"
    ? {
        id,
        type: "http",
        name: input.name,
        url: input.url,
        headers: input.headers,
        command: null,
        args: null,
        env: null,
      }
    : {
        id,
        type: "stdio",
        name: input.name,
        url: null,
        headers: null,
        command: input.command,
        args: input.args,
        env: input.env,
      };
}

export const mcpServers = {
  list: (): McpServerDef[] => db.select().from(mcpServersTable).all().map(toDef),
  create(input: McpServerInput): McpServerDef {
    const row = toRow(randomUUID(), input);
    db.insert(mcpServersTable).values(row).run();
    return toDef(row as McpRow);
  },
  update(id: string, input: McpServerInput): McpServerDef | undefined {
    const row = toRow(id, input);
    const changed = db.update(mcpServersTable).set(row).where(eq(mcpServersTable.id, id)).run().changes;
    return changed > 0 ? toDef(row as McpRow) : undefined;
  },
  remove: (id: string): boolean =>
    db.delete(mcpServersTable).where(eq(mcpServersTable.id, id)).run().changes > 0,
};

export const commands = {
  list: (): CommandDef[] => db.select().from(commandsTable).all(),
  create(input: CommandInput): CommandDef {
    const command: CommandDef = { id: randomUUID(), ...input };
    db.insert(commandsTable).values(command).run();
    return command;
  },
  update(id: string, input: CommandInput): CommandDef | undefined {
    const changed = db.update(commandsTable).set(input).where(eq(commandsTable.id, id)).run().changes;
    return changed > 0 ? { id, ...input } : undefined;
  },
  remove: (id: string): boolean =>
    db.delete(commandsTable).where(eq(commandsTable.id, id)).run().changes > 0,
};

export const skills = {
  list: (): SkillDef[] => db.select().from(skillsTable).all(),
  create(input: SkillInput): SkillDef {
    const skill: SkillDef = { id: randomUUID(), ...input };
    db.insert(skillsTable).values(skill).run();
    return skill;
  },
  update(id: string, input: SkillInput): SkillDef | undefined {
    const changed = db.update(skillsTable).set(input).where(eq(skillsTable.id, id)).run().changes;
    return changed > 0 ? { id, ...input } : undefined;
  },
  remove: (id: string): boolean =>
    db.delete(skillsTable).where(eq(skillsTable.id, id)).run().changes > 0,
};
