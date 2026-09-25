import type { BuiltinMcp } from "./db/schema.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
    name: "Web search",
    description:
      "The harness's web search + fetch tools, on the backend in Settings › Web search. Replaces Claude Code's built-in WebSearch/WebFetch on threads that link it.",
  },
  knowledge: {
    id: "builtin:knowledge",
    name: "Knowledge base",
    description: "A per-project knowledge base the agent can read and write, scoped to the thread's project.",
  },
  workflow: {
    id: "builtin:workflow",
    name: "Workflows",
    description:
      "Run a declarative multi-step workflow: every step is a real thread on this server, mirrored into the calling thread as a subagent. Works on any agent; replaces Claude Code's built-in Workflow tool on threads that link it.",
  },
  agents: {
    id: "builtin:agents",
    name: "Ask agents",
    description:
      "Ask another profile and agent pair — Codex, Claude Code, the Daedalus agent, on any provider — to do a task in a new thread of this project; its answer comes back to the caller, drawn as a subagent.",
  },
};

/**
 * Built-ins were injected under their kind slug ("web-search") before they had
 * titles. Only that exact value is replaced — like seeding, a name the user
 * chose is theirs. Cheap enough to run on every boot.
 */
export async function retitleBuiltinMcp(): Promise<void> {
  for (const [kind, { id, name }] of Object.entries(BUILTIN_MCP)) {
    await db.update(mcpServersTable).set({ name })
      .where(and(eq(mcpServersTable.id, id), eq(mcpServersTable.name, kind)));
  }
}

export function isBuiltinMcp(kind: string): kind is BuiltinMcp {
  return Object.hasOwn(BUILTIN_MCP, kind);
}

export const McpServerInputSchema = z.union([
  z.object({
    type: z.literal("builtin"),
    name: z.string().min(1),
    builtin: z.enum(["web-search", "knowledge", "workflow", "agents"]),
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
  list: async (): Promise<McpServerDef[]> => await (await db.select().from(mcpServersTable)).map(toDef),
  async create(input: McpServerInput): Promise<McpServerDef> {
    // A built-in goes through `ensureBuiltin`: it has one id, not a fresh one.
    if (input.type === "builtin") return mcpServers.ensureBuiltin(input.builtin);
    const row = toRow(randomUUID(), input);
    await db.insert(mcpServersTable).values(row);
    return toDef(row as McpRow);
  },
  /** Put one of the harness's own servers in the library — the "inject"
      action on the MCP page. Idempotent by fixed id: asking twice is one row,
      and a row the user renamed keeps its name. */
  async ensureBuiltin(kind: BuiltinMcp): Promise<McpServerDef> {
    const { id, name } = BUILTIN_MCP[kind];
    await db.insert(mcpServersTable)
      .values(toRow(id, { type: "builtin", name, builtin: kind }))
      .onConflictDoNothing();
    return toDef((await db.select().from(mcpServersTable).where(eq(mcpServersTable.id, id)).limit(1))[0]!);
  },
  async update(id: string, input: McpServerInput): Promise<McpServerDef | undefined> {
    const row = toRow(id, input);
    const changed = ((await db.update(mcpServersTable).set(row).where(eq(mcpServersTable.id, id))).rowCount ?? 0);
    return changed > 0 ? toDef(row as McpRow) : undefined;
  },
  remove: async (id: string): Promise<boolean> =>
    ((await db.delete(mcpServersTable).where(eq(mcpServersTable.id, id))).rowCount ?? 0) > 0,
};

export const commands = {
  list: async (): Promise<CommandDef[]> => await db.select().from(commandsTable),
  async create(input: CommandInput): Promise<CommandDef> {
    const command: CommandDef = { id: randomUUID(), ...input };
    await db.insert(commandsTable).values(command);
    return command;
  },
  async update(id: string, input: CommandInput): Promise<CommandDef | undefined> {
    const changed = ((await db.update(commandsTable).set(input).where(eq(commandsTable.id, id))).rowCount ?? 0);
    return changed > 0 ? { id, ...input } : undefined;
  },
  remove: async (id: string): Promise<boolean> =>
    ((await db.delete(commandsTable).where(eq(commandsTable.id, id))).rowCount ?? 0) > 0,
};

export const skills = {
  list: async (): Promise<SkillDef[]> => await db.select().from(skillsTable),
  async create(input: SkillInput): Promise<SkillDef> {
    const skill: SkillDef = { id: randomUUID(), ...input };
    await db.insert(skillsTable).values(skill);
    return skill;
  },
  async update(id: string, input: SkillInput): Promise<SkillDef | undefined> {
    const changed = ((await db.update(skillsTable).set(input).where(eq(skillsTable.id, id))).rowCount ?? 0);
    return changed > 0 ? { id, ...input } : undefined;
  },
  remove: async (id: string): Promise<boolean> =>
    ((await db.delete(skillsTable).where(eq(skillsTable.id, id))).rowCount ?? 0) > 0,
};
