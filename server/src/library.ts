import type { BuiltinMcp } from "./db/schema.js";
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

/**
 * The harness's own servers, offered to the library as rows with nothing in
 * them but a name and which one they are. Fixed ids, so injecting one twice is
 * one row — and so a migration could link profiles to them by name.
 */
export const BUILTIN_MCP: Record<BuiltinMcp, { id: string; name: string; description: string }> = {
  "web-search": {
    id: "builtin:web-search",
    name: "web-search",
    description:
      "The harness's web search + fetch tools, on the backend in Settings › Web search. Replaces Claude Code's built-in WebSearch/WebFetch on threads that link it.",
  },
  knowledge: {
    id: "builtin:knowledge",
    name: "knowledge",
    description: "A per-project knowledge base the agent can read and write, scoped to the thread's project.",
  },
  workflow: {
    id: "builtin:workflow",
    name: "workflow",
    description:
      "Run a declarative multi-step workflow: every step is a real thread on this server, mirrored into the calling thread as a subagent. Works on any agent; replaces Claude Code's built-in Workflow tool on threads that link it.",
  },
};

export function isBuiltinMcp(kind: string): kind is BuiltinMcp {
  return Object.hasOwn(BUILTIN_MCP, kind);
}

export const McpServerInputSchema = z.union([
  z.object({
    type: z.literal("builtin"),
    name: z.string().min(1),
    builtin: z.enum(["web-search", "knowledge", "workflow"]),
  }),
  z.object({
    type: z.literal("http"),
    name: z.string().min(1),
    url: z.string().url(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
    /* How the row authenticates. A stored answer, not a typed one: the client
       gets it from `POST /api/mcp-servers/probe` (the form's Check, and the
       probe it runs on save) and sends back what the server told it, because
       a spawn must not make a network call to find out what to hand the
       agent. Defaults to "none", which is every row written before OAuth
       existed and every server that answers unauthenticated. */
    auth: z.enum(["none", "oauth"]).default("none"),
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
  if (row.type === "builtin") {
    return { id: row.id, type: "builtin", name: row.name, builtin: row.builtin ?? "web-search" };
  }
  return row.type === "http"
    ? { id: row.id, type: "http", name: row.name, url: row.url ?? "", headers: row.headers ?? [], auth: row.auth }
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
  const blank = { url: null, headers: null, command: null, args: null, env: null, builtin: null, auth: "none" as const };
  if (input.type === "builtin") {
    return { ...blank, id, type: "builtin", name: input.name, builtin: input.builtin };
  }
  return input.type === "http"
    ? { ...blank, id, type: "http", name: input.name, url: input.url, headers: input.headers, auth: input.auth }
    : {
        ...blank,
        id,
        type: "stdio",
        name: input.name,
        command: input.command,
        args: input.args,
        env: input.env,
      };
}

export const mcpServers = {
  list: (): McpServerDef[] => db.select().from(mcpServersTable).all().map(toDef),
  create(input: McpServerInput): McpServerDef {
    // A built-in goes through `ensureBuiltin`: it has one id, not a fresh one.
    if (input.type === "builtin") return mcpServers.ensureBuiltin(input.builtin);
    const row = toRow(randomUUID(), input);
    db.insert(mcpServersTable).values(row).run();
    return toDef(row as McpRow);
  },
  /** Put one of the harness's own servers in the library — the "inject"
      action on the MCP page. Idempotent by fixed id: asking twice is one row,
      and a row the user renamed keeps its name. */
  ensureBuiltin(kind: BuiltinMcp): McpServerDef {
    const { id, name } = BUILTIN_MCP[kind];
    db.insert(mcpServersTable)
      .values(toRow(id, { type: "builtin", name, builtin: kind }))
      .onConflictDoNothing()
      .run();
    return toDef(db.select().from(mcpServersTable).where(eq(mcpServersTable.id, id)).get()!);
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
