import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import type * as acp from "./acp.js";
import { db } from "./db/index.js";
import { mcpCatalog } from "./db/schema.js";

/**
 * Connect to one MCP server the way a thread's agent would, and report what it
 * advertises.
 *
 * The def handed in is the one `mcpServersFor` resolves — a builtin already
 * synthesized, an OAuth row already pointing at the shim's loopback URL — so
 * what this connects to is exactly what the child gets. Checking the *stored*
 * row instead would test a URL no agent is ever given.
 *
 * A network call behind a button somebody is watching, never on the spawn
 * path: it spawns a stdio child, so the timeout is what guarantees the child is
 * reaped rather than left holding the request open.
 */

const CONNECT_TIMEOUT_MS = 20_000;
/** A tool call may be a search, a build or a long fetch, so it gets its own,
    longer budget than the handshake does. */
const CALL_TIMEOUT_MS = 120_000;

export interface McpCheckEntry {
  name: string;
  description?: string;
  /** A tool's JSON Schema, as the server declared it. Carried whole rather
      than picked apart: what a tool takes is half of what somebody reading
      the list needs to know. */
  inputSchema?: unknown;
  /** A tool's declared *output* schema, where it declares one (MCP 2025-06-18).
      Carried for the same reason the input one is: what a tool answers is half
      of what somebody reading the list needs to know. */
  outputSchema?: unknown;
  /** A prompt's declared arguments. */
  arguments?: { name: string; description?: string; required?: boolean }[];
  /** A resource's URI and type. `name` is the URI for a resource (it is what
      identifies it), so this is the human name where the server gave one. */
  uri?: string;
  mimeType?: string;
}

/** How long a stored listing stands before the next read connects again. A
    server's tools change when somebody deploys one, which is not an event this
    machine can hear, so the cache expires rather than being invalidated. */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

export interface McpCheckResult {
  ok: boolean;
  /** How long the connect plus the listings took, for a server that is merely slow. */
  ms: number;
  /** What the server called itself in the initialize answer — not the row's name. */
  serverInfo?: { name: string; version: string };
  tools: McpCheckEntry[];
  prompts: McpCheckEntry[];
  resources: McpCheckEntry[];
  /** RFC 6570 URI templates (`uri` holds the template), read by filling one in. */
  resourceTemplates?: McpCheckEntry[];
  /** How the server says it wants to be used — the initialize answer's
      `instructions`, which a client puts in front of its model. */
  instructions?: string;
  /** The capability keys the server declared (`tools`, `prompts`, `resources`,
      `logging`, `completions`, …), with each one's sub-flags. */
  capabilities?: Record<string, unknown>;
  error?: string;
  /** Unix ms of the connection this listing came from — the row's, when it is
      a remembered one, so the reader can see how old the answer is. */
  checkedAt?: number;
}

/**
 * The same check, remembered.
 *
 * `force` is the Check button: somebody pressing it is asking for a live
 * connection, and a remembered answer from an hour ago is the one thing that
 * press must not show. Every other reader — the settings list, drawing what
 * each server offers without being asked — takes a stored listing while it is
 * fresh, and only the miss costs a connect.
 *
 * In-flight checks are coalesced by row, so a list of a dozen servers opened
 * in two tabs is a dozen connects and not two dozen.
 */
const inFlight = new Map<string, Promise<McpCheckResult>>();

export async function mcpCatalogFor(
  id: string,
  def: acp.McpServer,
  force = false,
): Promise<McpCheckResult> {
  if (!force) {
    const [row] = await db.select().from(mcpCatalog).where(eq(mcpCatalog.mcpServerId, id));
    if (row && Date.now() - row.checkedAt < CATALOG_TTL_MS) {
      return { ...(row.result as McpCheckResult), checkedAt: row.checkedAt };
    }
  }
  const running = inFlight.get(id);
  if (running) return running;
  const started = (async () => {
    const result = { ...(await checkMcpServer(def)), checkedAt: Date.now() };
    await db
      .insert(mcpCatalog)
      .values({ mcpServerId: id, result, checkedAt: result.checkedAt })
      .onConflictDoUpdate({
        target: mcpCatalog.mcpServerId,
        set: { result, checkedAt: result.checkedAt },
      });
    return result;
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, started);
  return started;
}

export async function checkMcpServer(def: acp.McpServer): Promise<McpCheckResult> {
  const started = Date.now();
  const client = new Client({ name: "daedalus-harness", version: "0.1.0" });
  const result: McpCheckResult = { ok: false, ms: 0, tools: [], prompts: [], resources: [] };
  try {
    await connect(client, def);
    const info = client.getServerVersion();
    if (info) result.serverInfo = { name: String(info.name), version: String(info.version ?? "") };
    /* Each listing is guarded by the capability the handshake declared: asking
       a server that does not serve prompts is a -32601, which would read as a
       broken server rather than a server without prompts. */
    const caps = client.getServerCapabilities();
    if (caps) result.capabilities = caps as Record<string, unknown>;
    const instructions = client.getInstructions()?.trim();
    if (instructions) result.instructions = instructions;
    if (caps?.tools) {
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "list tools");
      result.tools = listed.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      }));
    }
    if (caps?.prompts) {
      const listed = await withTimeout(client.listPrompts(), CONNECT_TIMEOUT_MS, "list prompts");
      result.prompts = listed.prompts.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }));
    }
    if (caps?.resources) {
      const listed = await withTimeout(client.listResources(), CONNECT_TIMEOUT_MS, "list resources");
      result.resources = listed.resources.map((r) => ({
        name: r.uri,
        description: r.name ?? r.description,
        uri: r.uri,
        mimeType: r.mimeType,
      }));
      /* A server may serve templates and no fixed resources at all, and an
         old one answers -32601 here — which is "none", not a broken server. */
      const templates = await withTimeout(
        client.listResourceTemplates(),
        CONNECT_TIMEOUT_MS,
        "list resource templates",
      ).catch(() => ({ resourceTemplates: [] }));
      result.resourceTemplates = templates.resourceTemplates.map((t) => ({
        name: t.uriTemplate,
        description: t.name ?? t.description,
        uri: t.uriTemplate,
        mimeType: t.mimeType,
      }));
    }
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    /* Always: a connect that timed out has already spawned the stdio child, and
       close() is the only thing that reaps it. */
    await client.close().catch(() => {});
    result.ms = Date.now() - started;
  }
  return result;
}

/** The three things an MCP server offers, which is the whole of its surface.
    The composer renders prompts and resources; a tool call is the agent's. */
export type McpInvokeKind = "tool" | "prompt" | "resource";

export interface McpInvocation {
  kind: McpInvokeKind;
  /** The tool's or prompt's name; a resource's URI. */
  name: string;
  /** Arguments, for the two kinds that take them. */
  args?: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  ms: number;
  /** What the server answered, whole — content blocks, `structuredContent`,
      `isError`, a prompt's messages, a resource's contents. The caller renders
      it rather than interpreting it: what it needed was exactly this payload. */
  result?: unknown;
  /** The call never happened: a transport failure, a timeout, an unknown name.
      A tool that ran and failed is `result.isError`, which is not this. */
  error?: string;
}

/**
 * Run one thing on one server and hand back what it said.
 *
 * One door for all three kinds rather than three routes: what differs is a
 * single SDK method, and everything around it — the connection, the timeout,
 * the reaping, the shape of the answer — is identical. A fourth kind, if MCP
 * grows one, is a case here.
 *
 * On the pooled connection (below). No caching of the answer and no retry:
 * somebody pressed Run, and a tool call can be a write.
 */
export async function invokeMcp(id: string, def: acp.McpServer, call: McpInvocation): Promise<McpCallResult> {
  const started = Date.now();
  try {
    const client = await pooledClient(id, def);
    const args = call.args ?? {};
    /* `Promise<unknown>`: the three answers are three shapes and the caller
       renders whichever came back rather than narrowing it. */
    const run: Promise<unknown> =
      call.kind === "tool"
        ? client.callTool({ name: call.name, arguments: args })
        : call.kind === "prompt"
          ? /* A prompt's arguments are strings by the spec, so whatever the
               person typed is rendered as one rather than rejected — a number
               in the box is what they meant, not a type error. */
            client.getPrompt({ name: call.name, arguments: stringArgs(args) })
          : client.readResource({ uri: call.name });
    const result = await withTimeout(run, CALL_TIMEOUT_MS, `run ${call.name}`);
    return { ok: true, ms: Date.now() - started, result };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: (err as Error).message };
  }
}

/* ── The pool ──

   One live client per server row, for everything that is not the Check
   button: the composer's `@` and `/` reads. A stdio server is a process,
   and connecting per call spawned one per read. Idle entries close after a while, a
   transport that closes drops its entry, and the key carries the resolved def,
   so an edited row (or a builtin resolved for another project) connects
   afresh rather than reusing the old one.

   A server that says its lists changed invalidates the stored listing, so the
   next read connects instead of answering from a cache that is now wrong. */
const POOL_IDLE_MS = 5 * 60 * 1000;

interface Pooled {
  key: string;
  client: Promise<Client>;
  timer: ReturnType<typeof setTimeout>;
}

const pool = new Map<string, Pooled>();

function pooledClient(id: string, def: acp.McpServer): Promise<Client> {
  const key = JSON.stringify(def);
  const entry = pool.get(id);
  if (entry && entry.key === key) {
    entry.timer.refresh();
    return entry.client;
  }
  if (entry) dropPooled(id);
  const invalidate = () => void db.delete(mcpCatalog).where(eq(mcpCatalog.mcpServerId, id)).catch(() => {});
  const client = new Client(
    { name: "daedalus-harness", version: "0.1.0" },
    {
      listChanged: {
        tools: { autoRefresh: false, onChanged: invalidate },
        prompts: { autoRefresh: false, onChanged: invalidate },
        resources: { autoRefresh: false, onChanged: invalidate },
      },
    },
  );
  const connecting = connect(client, def).then(
    () => {
      client.onclose = () => {
        if (pool.get(id)?.client === connecting) pool.delete(id);
      };
      return client;
    },
    async (err: unknown) => {
      /* A failed connect is not remembered: the next call tries again, and
         close() reaps a stdio child the timeout left running. */
      if (pool.get(id)?.client === connecting) pool.delete(id);
      await client.close().catch(() => {});
      throw err;
    },
  );
  const timer = setTimeout(() => dropPooled(id), POOL_IDLE_MS);
  timer.unref();
  pool.set(id, { key, client: connecting, timer });
  return connecting;
}

function dropPooled(id: string): void {
  const entry = pool.get(id);
  if (!entry) return;
  pool.delete(id);
  clearTimeout(entry.timer);
  void entry.client.then((c) => c.close()).catch(() => {});
}

function stringArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}

/** Connect, and when it fails, say what a stdio child printed on its way
    down: "connection closed" is every broken server's error, and its stderr is
    the only thing that says which broken it is — the first question about a
    server nobody has run here before. The pipe is drained for the child's whole
    life (a full pipe blocks the writer); only the tail is kept. */
async function connect(client: Client, def: acp.McpServer): Promise<void> {
  let stderr = "";
  const transport = transportFor(def, (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect");
  } catch (err) {
    const tail = stderr.trim();
    throw new Error(tail ? `${(err as Error).message}\n\n${tail}` : (err as Error).message);
  }
}

/* The agent builds the same three transports from the same union
   (`agent/src/mcp.ts`). Duplicated rather than shared: `agent/` and `server/`
   are separate packages with no workspace between them, and twenty lines is a
   smaller thing to keep honest than a fourth package.
   ponytail: if a third caller appears, that is when it becomes a package. */
function transportFor(server: acp.McpServer, onStderr: (chunk: string) => void) {
  if ("type" in server && (server.type === "http" || server.type === "sse")) {
    const headers: Record<string, string> = {};
    for (const h of server.headers) headers[h.name] = h.value;
    const requestInit = { headers };
    const url = new URL(server.url);
    return server.type === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  }
  if ("command" in server) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const v of server.env) env[v.name] = v.value;
    const transport = new StdioClientTransport({ command: server.command, args: server.args, env, stderr: "pipe" });
    transport.stderr?.on("data", (chunk: Buffer) => onStderr(chunk.toString()));
    return transport;
  }
  throw new Error(`unsupported MCP transport: ${"type" in server ? String(server.type) : "unknown"}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out trying to ${what}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}
