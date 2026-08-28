/*
 * The `web-search` MCP server (stdio).
 *
 * Spawned by the agent — claude-code, codex or opencode — as a regular stdio
 * MCP server that the harness declared on a `McpServerStdio` entry in
 * `session/new`. It replaces the agent's built-in WebSearch/WebFetch tools
 * (which claude-code disallows via `_meta.claudeCode.options.disallowedTools`
 * when this server is attached — see acp-bridge.ts). The model calls
 * `web_search` / `web_fetch` here instead, and these answer against the
 * configured private search API rather than the provider's own web tools.
 *
 * Config arrives through `process.env`, injected by the harness at spawn from
 * `data/config.json` (see `toMcpServerEnv` in websearch.ts). Nothing here knows
 * about the harness or the database — it reads those four env vars and nothing
 * else, which is what keeps this subprocess self-contained and seccomp-friendly.
 *
 * Written to be invoked directly as the MCP server executable:
 *   node dist/websearch-mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readSearchEnv, runFetch, runSearch } from "./websearch.js";

const server = new McpServer({ name: "web-search", version: "1.0.0" });

server.registerTool(
  "web_search",
  {
    title: "Web search",
    description:
      "Search the web and return ranked results with title, URL and snippet. Use for questions that depend on current information.",
    inputSchema: {
      query: z.string().min(1).max(2000).describe("The search query."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ query }: { query: string }) => {
    const env = readSearchEnv(process.env);
    const text = await runSearch(env, query);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "web_fetch",
  {
    title: "Fetch URL",
    description:
      "Fetch a URL and return its readable text content (markdown). Minimal cleanup applied.",
    inputSchema: {
      url: z.string().describe("Absolute URL to fetch."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ url }: { url: string }) => {
    const env = readSearchEnv(process.env);
    const text = await runFetch(env, url);
    return { content: [{ type: "text", text }] };
  },
);

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => process.stderr.write("web-search MCP server running\n"))
  .catch((err) => {
    process.stderr.write(`web-search MCP server failed: ${String(err)}\n`);
    process.exit(1);
  });
