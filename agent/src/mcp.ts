import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type * as acp from "./acp.js";
import type { CommandDef } from "./commands.js";
import { dynamicTool, jsonSchema, type Tool } from "ai";

export interface McpHandle {
  /** Tool set keyed `mcp__<server>__<tool>` — the name shape every harness view already reads. */
  tools: Record<string, Tool>;
  /** Server prompts as slash commands, named `<server>:<prompt>`. */
  prompts: CommandDef[];
  /** Failures worth telling the model about (a server that would not start). */
  failures: string[];
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;
/* Generous on purpose — an MCP tool can legitimately run for minutes — but a
   bound has to exist: a server that never answers would otherwise hold the
   turn open forever. */
const CALL_TIMEOUT_MS = 600_000;

/**
 * The name a tool is offered to the model under.
 *
 * Providers constrain a function name to `^[a-zA-Z0-9_-]+$` and answer a 400
 * for anything else — the whole request, not the one tool, so a single server
 * whose name carries a space makes every turn of that thread fail before the
 * model sees it. A server's name is the user's prose (it is what the harness
 * draws in its library), so the two namespaces cannot be the same string.
 *
 * Applied to the assembled key rather than the server name alone, because a
 * server's own tool names are equally outside our control.
 *
 * ponytail: two servers whose names differ only in punctuation ("A B", "A-B")
 * collide here, and the second silently wins. Key by server id if that ever
 * stops being hypothetical.
 */
export function toolKey(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

/* Best-effort by contract: a server that fails to connect is reported in
   `failures` (folded into the system prompt) and never fatal — an agent that
   cannot spawn one MCP server must still answer prompts. */
export async function connectMcpServers(servers: acp.McpServer[]): Promise<McpHandle> {
  const tools: Record<string, Tool> = {};
  const prompts: CommandDef[] = [];
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
        tools[toolKey(name, t.name)] = dynamicTool({
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
      /* Prompts and resources are optional halves of the protocol, and asking
         a server that does not serve them is a -32601, not an empty list. The
         connect handshake already told us which it has. */
      const caps = client.getServerCapabilities();
      if (caps?.prompts) prompts.push(...(await listPrompts(client, name)));
      if (caps?.resources) addResourceTools(tools, client, name);
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
      const at = clients.indexOf(client);
      if (at >= 0) clients.splice(at, 1);
      void client.close().catch(() => {});
    }
  }

  return {
    tools,
    prompts,
    failures,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

/* A slash command carries one free-text argument and an MCP prompt declares
   named ones, so the line is read as `key=value` tokens with whatever is left
   over going to the first declared argument — which is the single-argument
   case, i.e. nearly all of them. */
export function promptArgs(declared: { name: string; required?: boolean }[], line: string): Record<string, string> {
  const args: Record<string, string> = {};
  const names = new Set(declared.map((d) => d.name));
  const rest: string[] = [];
  for (const token of line.split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    const key = eq > 0 ? token.slice(0, eq) : "";
    if (names.has(key)) args[key] = token.slice(eq + 1);
    else rest.push(token);
  }
  const first = declared.find((d) => d.required && !(d.name in args)) ?? declared.find((d) => !(d.name in args));
  if (first && rest.length) args[first.name] = rest.join(" ");
  return args;
}

async function listPrompts(client: Client, server: string): Promise<CommandDef[]> {
  const listed = await withTimeout(client.listPrompts(), CONNECT_TIMEOUT_MS, `list prompts of ${server}`);
  return listed.prompts.map((p) => ({
    name: `${server}:${p.name}`,
    description: p.description ?? `${p.name} (MCP prompt from ${server})`,
    body: `(the ${p.name} prompt from ${server})`,
    fetch: async (line: string) => {
      const result = await withTimeout(
        client.getPrompt({ name: p.name, arguments: promptArgs(p.arguments ?? [], line) }),
        CALL_TIMEOUT_MS,
        `get prompt ${p.name} from ${server}`,
      );
      const text = result.messages
        .map((m) => mcpResultText({ content: [m.content] }))
        .join("\n\n")
        .trim();
      return text || `(the ${p.name} prompt from ${server} is empty)`;
    },
  }));
}

/* Two tools rather than a tool per resource: a server can hold thousands, and
   the model needs the list in front of it to pick a uri, not every uri in its
   context window. A server that already ships a tool of either name keeps it —
   its own is the more specific thing. */
function addResourceTools(tools: Record<string, Tool>, client: Client, server: string): void {
  const list = toolKey(server, "list_resources");
  const read = toolKey(server, "read_resource");
  if (!(list in tools)) {
    tools[list] = dynamicTool({
      description: `List the resources available from the ${server} MCP server, as uri, name and description.`,
      inputSchema: jsonSchema({ type: "object", properties: {} } as never),
      execute: async () => {
        const result = await withTimeout(client.listResources(), CALL_TIMEOUT_MS, `list resources of ${server}`);
        if (!result.resources.length) return `${server} exposes no resources.`;
        return result.resources
          .map((r) => [r.uri, r.name, r.description].filter(Boolean).join(" — "))
          .join("\n");
      },
    });
  }
  if (!(read in tools)) {
    tools[read] = dynamicTool({
      description: `Read one resource from the ${server} MCP server by its uri (see list_resources).`,
      inputSchema: jsonSchema({
        type: "object",
        properties: { uri: { type: "string", description: "The resource uri" } },
        required: ["uri"],
      } as never),
      execute: async (input) => {
        const uri = String((input as { uri?: unknown })?.uri ?? "");
        if (!uri) throw new Error("uri is required");
        const result = await withTimeout(
          client.readResource({ uri }),
          CALL_TIMEOUT_MS,
          `read resource ${uri} from ${server}`,
        );
        return mcpResultText({ content: result.contents });
      },
    });
  }
}

function transportFor(server: acp.McpServer) {
  /* The two remote transports share a shape — url plus headers — and differ
     only in the protocol on the wire: streamable HTTP is the current one, SSE
     the older one a spec client (Zed, older gateways) still sends. The SDK
     ships a client for each and neither speaks the other's dialect, so the
     branch is the transport, not a header. */
  if ("type" in server && (server.type === "http" || server.type === "sse")) {
    const headers: Record<string, string> = {};
    for (const h of server.headers) headers[h.name] = h.value;
    const url = new URL(server.url);
    const requestInit = { headers };
    return server.type === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
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
      /* Keyed on `text` rather than `type === "text"`: a resource's contents
         block carries the text under a uri and no type at all, and stringifying
         it handed the model JSON of the file it asked to read. */
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
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
