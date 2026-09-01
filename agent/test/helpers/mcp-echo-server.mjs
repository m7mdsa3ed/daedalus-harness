/* Minimal MCP stdio server for tests: one `echo` tool, and — when
   MCP_PID_FILE names a path — its own pid written there at startup, so a test
   can prove the process was reaped when the agent closes the handle. Built on
   the low-level Server (plain JSON schemas, no zod) so it tracks no SDK
   surface that moves between releases. */
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.MCP_PID_FILE) writeFileSync(process.env.MCP_PID_FILE, String(process.pid));

const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo text back",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: `echo:${req.params.arguments?.text ?? ""}` }],
}));

await server.connect(new StdioServerTransport());
