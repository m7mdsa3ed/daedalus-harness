/*
 * The `harness` MCP server (stdio): an agent managing this harness itself.
 *
 * Instead of registering one MCP tool per operation, this exposes the whole
 * harness REST surface through exactly two tools:
 *
 *   harness_help  find an operation and its fields (answered from the catalog,
 *                  with no round trip)
 *   harness_run   run one by name, with its fields merged into `args`
 *
 * The reason is context: 106 named tools cost ~14.5k tokens in every thread
 * that links the server, before the model does anything. Two cost ~0.4k, and
 * the catalog is read only when the model asks for it — a search, a group, or
 * one operation's fields.
 *
 * The catalog (`harness-tools.ts`) is unchanged and still the single source of
 * truth. Every call is dispatched to `HARNESS_URL` (`/hm/<key>/<sessionId>`),
 * the loopback that names the calling thread, which re-dispatches to the app's
 * own `/api` route.
 *
 *   node dist/harness-mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HARNESS_TOOLS, type HarnessTool } from "./harness-tools.js";
import { HARNESS_SERVER_NAME } from "./workflows/types.js";

const base = process.env.HARNESS_URL;
if (!base) {
  process.stderr.write("harness MCP server: HARNESS_URL is not set\n");
  process.exit(1);
}

const server = new McpServer(
  { name: HARNESS_SERVER_NAME, version: "1.0.0" },
  {
    instructions:
      "Manage this harness itself. Call harness_help to find an operation — no arguments lists them all, `search` filters by name or description, and `tool` returns one operation's exact fields — then harness_run with the operation name and every field in `args` (path, query and body together). It covers projects, profiles, agents, the library (MCP servers, skills, commands, saved prompts), rules, routines, schedules, threads and the task board, on the same routes the app calls.",
  },
);

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))) as Record<string, unknown>;
  if (!res.ok) {
    const error = body.error;
    throw new Error(typeof error === "string" ? error : JSON.stringify(error ?? body));
  }
  return body;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failed = (error: unknown) => ({
  content: [{ type: "text" as const, text: `harness error: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});

/** A zod field's own description, if it carried one. */
const described = (schema: unknown): string => (schema as { description?: string }).description ?? "";
const paramNames = (t: HarnessTool) => Object.keys(t.params ?? {});
const queryNames = (t: HarnessTool) => Object.keys(t.query ?? {});
/** Every field the caller passes, whatever slot it lands in. */
const allNames = (t: HarnessTool) => [...paramNames(t), ...queryNames(t)];

/** One operation's entry: how to call it, and what to pass where. */
function detail(t: HarnessTool) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    method: t.method,
    path: t.path,
    pathParams: Object.fromEntries(Object.entries(t.params ?? {}).map(([k, v]) => [k, described(v)])),
    queryParams: Object.fromEntries(Object.entries(t.query ?? {}).map(([k, v]) => [k, described(v)])),
    body: t.data ? "Free-form: pass body fields directly in `args` alongside the rest (see the description above)." : "none",
  };
}

server.registerTool(
  "harness_help",
  {
    title: "Find a harness operation",
    description:
      "The operations this server can perform on the harness (projects, profiles, agents, the task board, the library, rules, routines, schedules, threads, and readouts). Call with no arguments to list them all, `search` to filter by name or description, or `tool` to get one operation's exact fields. Then run it with harness_run.",
    inputSchema: {
      tool: z.string().optional().describe("An operation's name, for its full field list."),
      search: z.string().optional().describe("Only operations whose name or description contains this."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ tool, search }) => {
    try {
      if (tool) {
        const found = HARNESS_TOOLS.find((t) => t.name === tool);
        if (!found) return failed(`unknown operation "${tool}" — call harness_help for the list`);
        return json(detail(found));
      }
      const needle = search?.toLowerCase();
      const matches = HARNESS_TOOLS.filter(
        (t) => !needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle),
      ).map((t) => ({ name: t.name, method: t.method, description: t.description, args: allNames(t) }));
      return json({ count: matches.length, of: HARNESS_TOOLS.length, tools: matches });
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "harness_run",
  {
    title: "Run a harness operation",
    description:
      "Run one operation named by harness_help. Put every field the operation takes directly in `args` — path parameters, query parameters and the JSON body together; the server routes each to the right place. Call harness_help with `tool` first if you are unsure of the fields.",
    inputSchema: {
      tool: z.string().min(1).describe("An operation name from harness_help, e.g. tasks_create."),
      args: z.record(z.string(), z.unknown()).optional().describe("The operation's fields."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tool, args }) => {
    const found = HARNESS_TOOLS.find((t) => t.name === tool);
    if (!found) return failed(`unknown operation "${tool}" — call harness_help for the list`);
    const field = (args ?? {}) as Record<string, unknown>;
    try {
      /* `args` is one flat object; the catalog says which keys are path, which
         are query, and the rest are the body. */
      const params = new Set(paramNames(found));
      const queries = new Set(queryNames(found));
      let path = found.path;
      for (const key of params) path = path.replace(`:${key}`, encodeURIComponent(String(field[key] ?? "")));
      const search = new URLSearchParams();
      for (const key of queries) {
        const value = field[key];
        if (value !== undefined && value !== null) search.set(key, String(value));
      }
      let payload: string | undefined;
      if (found.method !== "GET") {
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(field)) {
          if (!params.has(key) && !queries.has(key)) body[key] = value;
        }
        payload = JSON.stringify(body);
      }
      const suffix = search.size ? `?${search}` : "";
      return json(await call(`${path}${suffix}`, { method: found.method, body: payload }));
    } catch (error) {
      return failed(error);
    }
  },
);

server
  .connect(new StdioServerTransport())
  .then(() => process.stderr.write(`harness MCP server running (2 tools over ${HARNESS_TOOLS.length} operations)\n`))
  .catch((err) => {
    process.stderr.write(`harness MCP server failed: ${String(err)}\n`);
    process.exit(1);
  });
