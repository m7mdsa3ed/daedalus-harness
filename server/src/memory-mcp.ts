/*
 * The `memory` MCP server (stdio).
 *
 * Spawned by the agent — claude-code, codex or opencode — as a regular stdio
 * MCP server that the harness declared on a `McpServerStdio` entry in
 * `session/new` (see memoryServer in sessions.ts). It gives the agent a durable
 * cross-turn memory: facts it adds here are still there next turn, keyed to the
 * project the session runs in.
 *
 * The project id arrives through `process.env` (MEMORY_PROJECT_ID), injected by
 * the harness at spawn from the session's project — this subprocess is a separate
 * process and cannot keep a handle on the harness's own state. Search is
 * substring `LIKE`; there is no vector index, on purpose (see memory-db.ts).
 *
 * Nothing here knows about the harness or the database schema beyond the shared
 * backend — it reads env, opens the shared DB file and answers, which keeps it
 * self-contained and safe to run alongside the harness's own connection.
 *
 * Written to be invoked directly as the MCP server executable:
 *   node dist/memory-mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addMemory,
  deleteMemory,
  formatMemoryRows,
  listMemories,
  openDb,
  searchMemories,
} from "./memory-db.js";

const projectId = process.env.MEMORY_PROJECT_ID;
if (!projectId) {
  process.stderr.write("memory MCP server is missing MEMORY_PROJECT_ID\n");
  process.exit(1);
}
// The harness injects DAEDALUS_DB_PATH; fall back to the default path from the
// shared module so a bare `node dist/memory-mcp.js` still finds the DB.
const db = openDb(process.env.DAEDALUS_DB_PATH);

const server = new McpServer({ name: "memory", version: "1.0.0" });

server.registerTool(
  "memory_add",
  {
    title: "Add memory",
    description:
      "Store a durable memory for this project. Use for facts you want to recall in later turns — the user's preferences, decisions, project conventions, learned context. Roughly one memory per distinct fact.",
    inputSchema: {
      content: z.string().min(1).max(20_000).describe("The fact to remember."),
      tags: z.array(z.string()).optional().describe("Optional tags to make it easier to find."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ content, tags }: { content: string; tags?: string[] }) => {
    try {
      const { id } = addMemory(db, projectId, { content, tags });
      return { content: [{ type: "text", text: `Memory saved as ${id}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}.` }] };
    }
  },
);

server.registerTool(
  "memory_search",
  {
    title: "Search memories",
    description:
      "Search this project's saved memories (substring match on content and tags) and return ranked matches. Use to recall something saved earlier before asking the user.",
    inputSchema: {
      query: z.string().min(1).max(1000).describe("Text to search for."),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 8)."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, limit }: { query: string; limit?: number }) => {
    try {
      const rows = searchMemories(db, projectId, query, limit);
      return { content: [{ type: "text", text: formatMemoryRows(rows) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}.` }] };
    }
  },
);

server.registerTool(
  "memory_list",
  {
    title: "List memories",
    description: "List this project's saved memories, newest first. Use to survey what is stored (e.g. before pruning).",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ limit }: { limit?: number }) => {
    try {
      const rows = listMemories(db, projectId, limit);
      return { content: [{ type: "text", text: formatMemoryRows(rows) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}.` }] };
    }
  },
);

server.registerTool(
  "memory_delete",
  {
    title: "Delete memory",
    description: "Delete a memory by id. Irreversible.",
    inputSchema: {
      id: z.string().min(1).describe("The memory's id."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ id }: { id: string }) => {
    try {
      const ok = deleteMemory(db, projectId, id);
      return { content: [{ type: "text", text: ok ? `Deleted memory ${id}.` : `No memory with id ${id}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}.` }] };
    }
  },
);

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => process.stderr.write("memory MCP server running\n"))
  .catch((err) => {
    process.stderr.write(`memory MCP server failed: ${String(err)}\n`);
    process.exit(1);
  });
