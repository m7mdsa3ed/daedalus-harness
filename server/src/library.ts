import type { BuiltinMcp } from "./db/schema.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  commands as commandsTable,
  db,
  mcpServers as mcpServersTable,
  personas as personasTable,
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
  agents: {
    id: "builtin:agents",
    name: "Agents",
    description:
      "Hand work to another worker with one tool: a subagent on this thread's own model, an ask of another profile and agent pair, or a multi-step workflow where every step is a real thread of this project. Its answer comes back to the caller, drawn as a subagent; the Daedalus agent always has this server, because it is that runtime's only way to delegate.",
  },
  harness: {
    id: "builtin:harness",
    name: "Harness",
    description:
      "Manage this harness from the agent — projects, spaces, profiles and agents, the task board, the library (MCP servers, skills, commands, model prompts), rules, themes, knowledge, routines, schedules and threads, on the same routes the app itself calls.",
  },
};

/**
 * The built-ins whose stdio server is synthesized from a *thread*: its env
 * names the calling session's own loopback URL (`workflow`, `agents`, `harness`)
 * or the desktop preview that thread is driving (`browser`). There is no such
 * server without a thread, so a settings screen — or any caller with no session
 * behind it — can neither connect to one nor list its tools. The two that
 * resolve without a thread are `web-search` (on `data/config.json`) and
 * `knowledge` (on the project). Kept here, beside `BUILTIN_MCP`, in the module
 * that owns the built-in kinds and low enough that nothing imports it upward.
 */
const THREAD_SCOPED_BUILTINS = new Set<BuiltinMcp>(["agents", "harness"]);

/** Whether a built-in only exists as a thread's own server — see above. */
export function isThreadScopedBuiltin(kind: BuiltinMcp): boolean {
  return THREAD_SCOPED_BUILTINS.has(kind);
}

/**
 * Built-ins were injected under their kind slug ("web-search") before they had
 * titles. Only that exact value is replaced — like seeding, a name the user
 * chose is theirs. Cheap enough to run on every boot.
 */
export async function retitleBuiltinMcp(): Promise<void> {
  // `builtin:browser` was removed (chrome-devtools-mcp is a plain stdio row now); its links cascade.
  await db.delete(mcpServersTable).where(eq(mcpServersTable.id, "builtin:browser"));
  // `builtin:video` (video-mcp) was removed too; its links cascade.
  await db.delete(mcpServersTable).where(eq(mcpServersTable.id, "builtin:video"));
  /* `builtin:workflow` is the same removal one release on: its three tools moved
     under the `agents` server's one `agent` tool (docs/plans/agent-tool.md), so
     the row nobody can link any more is dropped and its links cascade. A thread
     that had it keeps working — `agents` is a row of its own, and the Daedalus
     agent requires it. */
  await db.delete(mcpServersTable).where(eq(mcpServersTable.id, "builtin:workflow"));
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
    builtin: z.enum(["web-search", "knowledge", "agents", "harness"]),
  }),
  z.object({
    type: z.literal("http"),
    name: z.string().min(1),
    logoUrl: z.string().url().max(150_000).optional(),
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
    logoUrl: z.string().url().max(150_000).optional(),
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

/** A persona (`personas` table): instruction text a whole thread runs under. */
export const PersonaInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** Appended to the agent's own prompt, above the rules (`personas.ts`). */
  prompt: z.string().min(1),
  /** Order in every menu; ties break by name. */
  sortOrder: z.number().int().default(0),
});

export type McpServerInput = z.infer<typeof McpServerInputSchema>;
export type SkillInput = z.infer<typeof SkillInputSchema>;
export type CommandInput = z.infer<typeof CommandInputSchema>;
/** `threadScoped` rides only on a `builtin` row: the ones whose server is a
    thread's own, so a caller with no session resolves them to nothing. */
export type McpServerDef = McpServerInput & { id: string; threadScoped?: boolean };
export type SkillDef = SkillInput & { id: string };
export type CommandDef = CommandInput & { id: string };
export type PersonaInput = z.infer<typeof PersonaInputSchema>;
export type PersonaDef = PersonaInput & { id: string };

type McpRow = typeof mcpServersTable.$inferSelect;

/** The table holds both variants in one row shape — the columns the other
    variant uses are null. These two functions are the only place that knows. */
function toDef(row: McpRow): McpServerDef {
  if (row.type === "builtin") {
    const builtin = row.builtin ?? "web-search";
    return { id: row.id, type: "builtin", name: row.name, builtin, threadScoped: isThreadScopedBuiltin(builtin) };
  }
  return row.type === "http"
    ? {
        id: row.id,
        type: "http",
        name: row.name,
        logoUrl: row.logoUrl ?? undefined,
        url: row.url ?? "",
        headers: row.headers ?? [],
        auth: row.auth,
      }
    : {
        id: row.id,
        type: "stdio",
        name: row.name,
        logoUrl: row.logoUrl ?? undefined,
        command: row.command ?? "",
        args: row.args ?? [],
        env: row.env ?? [],
      };
}

function toRow(id: string, input: McpServerInput): typeof mcpServersTable.$inferInsert {
  const blank = { logoUrl: null, url: null, headers: null, command: null, args: null, env: null, builtin: null, auth: "none" as const };
  if (input.type === "builtin") {
    return { ...blank, id, type: "builtin", name: input.name, builtin: input.builtin };
  }
  return input.type === "http"
    ? {
        ...blank,
        id,
        type: "http",
        name: input.name,
        logoUrl: input.logoUrl ?? null,
        url: input.url,
        headers: input.headers,
        auth: input.auth,
      }
    : {
        ...blank,
        id,
        type: "stdio",
        name: input.name,
        logoUrl: input.logoUrl ?? null,
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

const personaColumns = {
  id: personasTable.id,
  name: personasTable.name,
  description: personasTable.description,
  prompt: personasTable.prompt,
  sortOrder: personasTable.sortOrder,
};

export const personas = {
  list: async (): Promise<PersonaDef[]> =>
    await db.select(personaColumns).from(personasTable).orderBy(asc(personasTable.sortOrder), asc(personasTable.name)),
  get: async (id: string): Promise<PersonaDef | undefined> =>
    (await db.select(personaColumns).from(personasTable).where(eq(personasTable.id, id)).limit(1))[0],
  async create(input: PersonaInput): Promise<PersonaDef> {
    const persona: PersonaDef = { id: randomUUID(), ...input };
    await db.insert(personasTable).values(persona);
    return persona;
  },
  async update(id: string, input: PersonaInput): Promise<PersonaDef | undefined> {
    const changed = ((await db.update(personasTable).set(input).where(eq(personasTable.id, id))).rowCount ?? 0);
    return changed > 0 ? { id, ...input } : undefined;
  },
  remove: async (id: string): Promise<boolean> =>
    ((await db.delete(personasTable).where(eq(personasTable.id, id))).rowCount ?? 0) > 0,
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
