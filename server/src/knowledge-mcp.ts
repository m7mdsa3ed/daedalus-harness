/*
 * The `knowledge` MCP server (stdio).
 *
 * Spawned by the agent — claude-code, codex or opencode — as a regular stdio
 * MCP server that the harness declared on a `McpServerStdio` entry in
 * `session/new` (see knowledgeServer in sessions.ts). It gives the agent a
 * project knowledge base: titled reference material — docs, API notes, longer
 * prose — that persists across turns, keyed to the project the session runs in.
 *
 * The project id arrives through `process.env` (KNOWLEDGE_PROJECT_ID), injected
 * by the harness at spawn from the session's project. Search is substring
 * `LIKE`; there is no vector index, on purpose (see knowledge-db.ts).
 *
 * Nothing here knows about the harness or the database schema beyond the shared
 * backend — it reads env, opens the shared DB file and answers.
 *
 * Written to be invoked directly as the MCP server executable:
 *   node dist/knowledge-mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addKnowledge,
  deleteKnowledge,
  formatKnowledgeRows,
  listKnowledge,
  openDb,
  searchKnowledge,
} from "./knowledge-db.js";

const projectId = process.env.KNOWLEDGE_PROJECT_ID;
if (!projectId) {
  process.stderr.write("knowledge MCP server is missing KNOWLEDGE_PROJECT_ID\n");
  process.exit(1);
}
// The harness injects DAEDALUS_DB_PATH; fall back to the default path from the
// shared module so a bare `node dist/knowledge-mcp.js` still finds the DB.
const db = openDb(process.env.DAEDALUS_DB_PATH);

const server = new McpServer({ name: "knowledge", version: "1.0.0" });

server.registerTool(
  "knowledge_add",
  {
    title: "Add knowledge",
    description:
      "Store a titled knowledge-base entry for this project. Use for reference material, docs, API notes, longer prose — the entry has a title plus body content. Roughly one entry per topic.",
    inputSchema: {
      title: z.string().min(1).max(500).describe("A short title for the entry."),
      content: z.string().min(1).max(50_000).describe("The entry's body content."),
      tags: z.array(z.string()).optional().describe("Optional tags to make it easier to find."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ title, content, tags }: { title: string; content: string; tags?: string[] }) => {
    try {
      const { id } = addKnowledge(db, projectId, { title, content, tags });
      return { content: [{ type: "text", text: `Knowledge entry saved as ${id}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}.` }] };
    }
  },
);

server.registerTool(
  "knowledge_search",
  {
    title: "Search knowledge",
    description:
      "Search this project's knowledge base (substring match on title, content and tags) and return ranked entries. Use to look up reference material before answering.",
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
      const rows = searchKnowledge(db, projectId, query, limit);
      return { content: [{ type: "text", text: formatKnowledgeRows(rows) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}.` }] };
    }
  },
);

server.registerTool(
  "knowledge_list",
  {
    title: "List knowledge",
    description: "List this project's knowledge entries, newest first. Use to survey what is stored.",
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
      const rows = listKnowledge(db, projectId, limit);
      return { content: [{ type: "text", text: formatKnowledgeRows(rows) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}.` }] };
    }
  },
);

server.registerTool(
  "knowledge_delete",
  {
    title: "Delete knowledge",
    description: "Delete a knowledge entry by id. Irreversible.",
    inputSchema: {
      id: z.string().min(1).describe("The entry's id."),
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
      const ok = deleteKnowledge(db, projectId, id);
      return { content: [{ type: "text", text: ok ? `Deleted knowledge entry ${id}.` : `No knowledge entry with id ${id}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}.` }] };
    }
  },
);

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => process.stderr.write("knowledge MCP server running\n"))
  .catch((err) => {
    process.stderr.write(`knowledge MCP server failed: ${String(err)}\n`);
    process.exit(1);
  });
