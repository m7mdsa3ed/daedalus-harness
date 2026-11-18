/*
 * The `browser` MCP server (stdio): an agent driving its project's browser.
 *
 * A thin child exactly like `harness-mcp.ts`. It holds no CDP state: every call
 * is POSTed to `BROWSER_URL` (`/bm/<key>/<sessionId>`, the loopback that names
 * the calling thread) plus the tool's name, and the server — which holds the
 * only connection to Chrome (`browsers.ts`) — runs it. A server restart
 * therefore costs nothing to reconnect: the next call relaunches the browser,
 * and old uids are simply stale.
 *
 *   node dist/browser-mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BROWSER_INSTRUCTIONS, BROWSER_SERVER_NAME, BROWSER_TOOLS, type BrowserToolResult } from "./browser-mcp-tools.js";

const base = process.env.BROWSER_URL;
if (!base) {
  process.stderr.write("browser MCP server: BROWSER_URL is not set\n");
  process.exit(1);
}

const server = new McpServer({ name: BROWSER_SERVER_NAME, version: "1.0.0" }, { instructions: BROWSER_INSTRUCTIONS });

async function call(tool: string, args: unknown): Promise<BrowserToolResult> {
  const res = await fetch(`${base}/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
    // Above the route's own 10s settle cap and a 30s wait_for.
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))) as Record<string, unknown>;
  if (!res.ok) {
    const error = body.error;
    throw new Error(typeof error === "string" ? error : JSON.stringify(error ?? body));
  }
  return body as unknown as BrowserToolResult;
}

const failed = (error: unknown) => ({
  content: [{ type: "text" as const, text: `browser error: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});

for (const [name, def] of Object.entries(BROWSER_TOOLS)) {
  server.registerTool(
    name,
    { title: def.title, description: def.description, inputSchema: def.shape, annotations: def.annotations },
    async (args: Record<string, unknown>) => {
      try {
        const result = await call(name, args);
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
        if (result.image) content.push({ type: "image", data: result.image.data, mimeType: result.image.mimeType });
        content.push({ type: "text", text: result.text });
        return result.isError ? { content, isError: true } : { content };
      } catch (error) {
        return failed(error);
      }
    },
  );
}

server
  .connect(new StdioServerTransport())
  .then(() => process.stderr.write(`browser MCP server running (${Object.keys(BROWSER_TOOLS).length} tools)\n`))
  .catch((err) => {
    process.stderr.write(`browser MCP server failed: ${String(err)}\n`);
    process.exit(1);
  });
