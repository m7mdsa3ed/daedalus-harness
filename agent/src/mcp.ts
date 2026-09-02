import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type * as acp from "./acp.js";
import { dynamicTool, jsonSchema, type Tool } from "ai";

export interface McpHandle {
  /** Tool set keyed `mcp__<server>__<tool>` — the name shape every harness view already reads. */
  tools: Record<string, Tool>;
  /** Failures worth telling the model about (a server that would not start). */
  failures: string[];
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;
/* Generous on purpose — an MCP tool can legitimately run for minutes — but a
   bound has to exist: a server that never answers would otherwise hold the
   turn open forever. */
const CALL_TIMEOUT_MS = 600_000;

/* Best-effort by contract: a server that fails to connect is reported in
   `failures` (folded into the system prompt) and never fatal — an agent that
   cannot spawn one MCP server must still answer prompts. */
export async function connectMcpServers(servers: acp.McpServer[]): Promise<McpHandle> {
  const tools: Record<string, Tool> = {};
  const failures: string[] = [];
  const clients: Client[] = [];

  for (const server of servers) {
    const name = server.name;
    const client = new Client({ name: "daedalus-agent", version: "0.1.0" });
    try {
      const transport = transportFor(server);
      /* Pushed before connect: a timed-out connect has already spawned the
         stdio child, and close() is the only thing that reaps it. */
      clients.push(client);
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect to MCP server ${name}`);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `list tools of ${name}`);
      for (const t of listed.tools) {
        tools[`mcp__${name}__${t.name}`] = dynamicTool({
          description: t.description ?? `${t.name} (MCP tool from ${name})`,
          inputSchema: jsonSchema((t.inputSchema ?? { type: "object" }) as never),
          execute: async (input) => {
            const result = await withTimeout(
              client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> }),
              CALL_TIMEOUT_MS,
              `call ${t.name} on ${name}`,
            );
            return mcpResultText(result as { content?: unknown; isError?: boolean });
          },
        });
      }
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
      const at = clients.indexOf(client);
      if (at >= 0) clients.splice(at, 1);
      void client.close().catch(() => {});
    }
  }

  return {
    tools,
    failures,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

function transportFor(server: acp.McpServer) {
  if ("type" in server && server.type === "http") {
    const headers: Record<string, string> = {};
    for (const h of server.headers) headers[h.name] = h.value;
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers },
    });
  }
  if ("command" in server) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const v of server.env) env[v.name] = v.value;
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env,
      stderr: "ignore",
    });
  }
  throw new Error(`unsupported MCP transport: ${"type" in server ? String(server.type) : "unknown"}`);
}

function mcpResultText(result: { content?: unknown; isError?: boolean }): string {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        parts.push(String((block as { text?: unknown }).text ?? ""));
      } else {
        parts.push(JSON.stringify(block));
      }
    }
  }
  const text = parts.join("\n") || "(empty result)";
  if (result.isError) throw new Error(text);
  return text;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out trying to ${what}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}
