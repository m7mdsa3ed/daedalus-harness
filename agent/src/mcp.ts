import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  type ClientCapabilities,
  type CreateMessageRequest,
  type CreateMessageResult,
  type ElicitRequest,
  type ElicitResult,
  type Prompt,
  type Root,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import type * as acp from "./acp.js";
import type { CommandDef } from "./commands.js";
import { dynamicTool, jsonSchema, type Tool } from "ai";
import { SpanStatusCode } from "@opentelemetry/api";
import { tracer } from "./tracing.js";

/** An image or audio block a tool handed back. The provider's tool message is
    text only (`@ai-sdk/openai-compatible` JSON-stringifies anything else), so
    these wait here and join the next model step as a user message (turn.ts). */
export interface McpMedia {
  tool: string;
  data: string;
  mediaType: string;
}

/**
 * What the MCP server may ask of us. Each is optional, and a missing one is a
 * capability we do not declare — so a server never sends a request this end
 * cannot answer. The app builds them per session (it holds the session, the
 * ACP connection and the model); this file only wires them to the SDK.
 */
export interface McpHooks {
  elicit?(server: string, params: ElicitRequest["params"], signal: AbortSignal): Promise<ElicitResult>;
  /** Whether url-mode elicitation can be forwarded too, not just forms. */
  elicitUrl?: boolean;
  sample?(server: string, params: CreateMessageRequest["params"], signal: AbortSignal): Promise<CreateMessageResult>;
  roots?(): Root[];
  /** A server's prompt list changed after connect: the command list is stale. */
  onPromptsChanged?(): void;
}

/** Passed into an MCP tool's execute by the gate that wraps it (tools/index.ts),
    which is the one place a turn's emitter is in hand — the tools themselves are
    built at connect time, before any turn exists. */
export interface McpCallExtras {
  onProgress?(text: string): void;
}

export interface McpHandle {
  /** Tool set keyed `mcp__<server>__<tool>` — the name shape every harness view
      already reads. Mutated in place when a server says its list changed; read
      when a turn builds its tools, so a change lands at the next attempt. */
  tools: Record<string, Tool>;
  /** Server prompts as slash commands, named `<server>:<prompt>`. */
  prompts: CommandDef[];
  /** Each server's `instructions` from its initialize answer — how it wants to
      be used, which the model reads in its system prompt. */
  instructions: { server: string; text: string }[];
  /** Failures worth telling the model about (a server that would not start). */
  failures: string[];
  /** Media returned by tool calls, drained at the next step boundary. */
  media: McpMedia[];
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;
/* Generous on purpose — an MCP tool can legitimately run for minutes — but a
   bound has to exist: a server that never answers would otherwise hold the
   turn open forever. Passed to the SDK as its own request timeout too: its
   default is 60s, which ended every longer call before this bound was reached. */
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
export async function connectMcpServers(servers: acp.McpServer[], hooks: McpHooks = {}): Promise<McpHandle> {
  const handle: McpHandle = {
    tools: {},
    prompts: [],
    instructions: [],
    failures: [],
    media: [],
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
  const clients: Client[] = [];

  const capabilities: ClientCapabilities = {};
  if (hooks.elicit) capabilities.elicitation = hooks.elicitUrl ? { form: {}, url: {} } : { form: {} };
  if (hooks.sample) capabilities.sampling = {};
  if (hooks.roots) capabilities.roots = {};

  for (const server of servers) {
    const name = server.name;
    /* The keys this server put in `tools`, so a changed list replaces its own
       entries and nobody else's. */
    let owned: string[] = [];
    let resourceTools = false;
    const setTools = (listed: McpTool[]) => {
      for (const key of owned) delete handle.tools[key];
      owned = [];
      for (const t of listed) {
        const key = toolKey(name, t.name);
        handle.tools[key] = mcpTool(client, name, key, t, handle.media);
        owned.push(key);
      }
      if (resourceTools) owned.push(...addResourceTools(handle.tools, client, name, handle.media));
    };
    const setPrompts = (listed: Prompt[]) => {
      const prefix = `${name}:`;
      handle.prompts = [
        ...handle.prompts.filter((p) => !p.name.startsWith(prefix)),
        ...listed.map((p) => promptCommand(client, name, p)),
      ];
    };

    const client = new Client(
      { name: "daedalus-agent", version: "0.1.0" },
      {
        capabilities,
        /* The SDK re-lists for us (debounced) when the server says a list
           changed; handlers are skipped for a server that never claims it can. */
        listChanged: {
          tools: {
            onChanged: (err, tools) => {
              if (!err && tools) setTools(tools);
            },
          },
          prompts: {
            onChanged: (err, prompts) => {
              if (err || !prompts) return;
              setPrompts(prompts);
              hooks.onPromptsChanged?.();
            },
          },
        },
      },
    );
    if (hooks.elicit) {
      const elicit = hooks.elicit;
      client.setRequestHandler(ElicitRequestSchema, (req, extra) => elicit(name, req.params, extra.signal));
    }
    if (hooks.sample) {
      const sample = hooks.sample;
      client.setRequestHandler(CreateMessageRequestSchema, (req, extra) => sample(name, req.params, extra.signal));
    }
    if (hooks.roots) {
      const roots = hooks.roots;
      client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots() }));
    }
    /* A server's log lines are the agent's stderr, which the harness already
       splices into the errors it shows — the one place they are useful. */
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      const data = typeof n.params.data === "string" ? n.params.data : JSON.stringify(n.params.data);
      process.stderr.write(`[mcp ${name}] ${n.params.level}: ${data}\n`);
    });

    const span = tracer.startSpan(`mcp connect ${name}`, {
      attributes: { "daedalus.kind": "process", "daedalus.mcp.server": name },
    });
    try {
      const transport = transportFor(server);
      /* Pushed before connect: a timed-out connect has already spawned the
         stdio child, and close() is the only thing that reaps it. */
      clients.push(client);
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect to MCP server ${name}`);
      /* Prompts and resources are optional halves of the protocol, and asking
         a server that does not serve them is a -32601, not an empty list. The
         connect handshake already told us which it has. */
      const caps = client.getServerCapabilities();
      resourceTools = Boolean(caps?.resources);
      const listed = caps?.tools
        ? await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `list tools of ${name}`)
        : { tools: [] };
      setTools(listed.tools);
      if (caps?.prompts) {
        const prompts = await withTimeout(client.listPrompts(), CONNECT_TIMEOUT_MS, `list prompts of ${name}`);
        setPrompts(prompts.prompts);
      }
      const instructions = client.getInstructions()?.trim();
      if (instructions) handle.instructions.push({ server: name, text: instructions });
      /* Warnings and up: a server at `debug` would fill stderr with noise. */
      if (caps?.logging) void client.setLoggingLevel("warning").catch(() => {});
      span.setAttribute("daedalus.mcp.tools", owned.length);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      handle.failures.push(`${name}: ${(err as Error).message}`);
      const at = clients.indexOf(client);
      if (at >= 0) clients.splice(at, 1);
      void client.close().catch(() => {});
    } finally {
      span.end();
    }
  }

  return handle;
}

function mcpTool(client: Client, server: string, key: string, t: McpTool, media: McpMedia[]): Tool {
  return dynamicTool({
    description: t.description ?? `${t.name} (MCP tool from ${server})`,
    inputSchema: jsonSchema((t.inputSchema ?? { type: "object" }) as never),
    execute: async (input, options) => {
      const extras = options as McpCallExtras & { abortSignal?: AbortSignal };
      const result = await client.callTool(
        { name: t.name, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        {
          signal: extras.abortSignal,
          timeout: CALL_TIMEOUT_MS,
          /* A server reporting progress is still working: each report restarts
             the clock, and says where it is on the tool's row. */
          resetTimeoutOnProgress: true,
          onprogress: extras.onProgress
            ? (p) => {
                const of = p.total ? `${p.progress}/${p.total}` : String(p.progress);
                extras.onProgress!(p.message ? `${p.message} (${of})` : `Progress: ${of}`);
              }
            : undefined,
        },
      );
      return mcpResult(result as McpToolResult, key, media);
    },
  });
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

function promptCommand(client: Client, server: string, p: Prompt): CommandDef {
  return {
    name: `${server}:${p.name}`,
    description: p.description ?? `${p.name} (MCP prompt from ${server})`,
    body: `(the ${p.name} prompt from ${server})`,
    fetch: async (line: string) => {
      const result = await withTimeout(
        client.getPrompt({ name: p.name, arguments: promptArgs(p.arguments ?? [], line) }),
        CALL_TIMEOUT_MS,
        `get prompt ${p.name} from ${server}`,
      );
      /* A slash command expands to prose, so a prompt's images have nowhere to
         go and are named rather than inlined as base64. */
      const text = result.messages
        .map((m) => blocksText([m.content]).text)
        .join("\n\n")
        .trim();
      return text || `(the ${p.name} prompt from ${server} is empty)`;
    },
  };
}

/* Tools rather than a tool per resource: a server can hold thousands, and the
   model needs the list in front of it to pick a uri, not every uri in its
   context window. A server that already ships a tool of the same name keeps
   it — its own is the more specific thing. Answers the keys it added. */
function addResourceTools(
  tools: Record<string, Tool>,
  client: Client,
  server: string,
  media: McpMedia[],
): string[] {
  const list = toolKey(server, "list_resources");
  const templates = toolKey(server, "list_resource_templates");
  const read = toolKey(server, "read_resource");
  const added: string[] = [];
  if (!(list in tools)) {
    added.push(list);
    tools[list] = dynamicTool({
      description: `List the resources available from the ${server} MCP server, as uri, name and description.`,
      inputSchema: jsonSchema({ type: "object", properties: {} } as never),
      execute: async () => {
        const result = await withTimeout(client.listResources(), CALL_TIMEOUT_MS, `list resources of ${server}`);
        if (!result.resources.length) return `${server} exposes no fixed resources (see list_resource_templates).`;
        return result.resources
          .map((r) => [r.uri, r.name, r.description].filter(Boolean).join(" — "))
          .join("\n");
      },
    });
  }
  if (!(templates in tools)) {
    added.push(templates);
    tools[templates] = dynamicTool({
      description: `List the resource URI templates of the ${server} MCP server (RFC 6570, e.g. file:///{path}). Fill one in and pass it to read_resource.`,
      inputSchema: jsonSchema({ type: "object", properties: {} } as never),
      execute: async () => {
        const result = await withTimeout(
          client.listResourceTemplates(),
          CALL_TIMEOUT_MS,
          `list resource templates of ${server}`,
        );
        if (!result.resourceTemplates.length) return `${server} has no resource templates.`;
        return result.resourceTemplates
          .map((r) => [r.uriTemplate, r.name, r.description].filter(Boolean).join(" — "))
          .join("\n");
      },
    });
  }
  if (!(read in tools)) {
    added.push(read);
    tools[read] = dynamicTool({
      description: `Read one resource from the ${server} MCP server by its uri — one from list_resources, or a filled-in list_resource_templates template.`,
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
        return mcpResult({ content: result.contents }, read, media);
      },
    });
  }
  return added;
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

interface McpToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * The text of a list of MCP content blocks, and the media among them.
 *
 * Every block kind the spec has: `text`; `image`/`audio` (base64 + mimeType);
 * `resource_link` (a pointer — its uri is what the model can read next); an
 * embedded `resource`, whose contents are `text` or a base64 `blob` under a
 * uri — and which is also the shape `resources/read` answers with, untyped.
 * Anything else is carried as JSON rather than dropped.
 */
export function blocksText(blocks: unknown[]): { text: string; media: Omit<McpMedia, "tool">[] } {
  const parts: string[] = [];
  const media: Omit<McpMedia, "tool">[] = [];
  const binary = (data: string, mediaType: string, uri?: string) => {
    const kb = Math.round((data.length * 3) / 4 / 1024);
    const label = `${mediaType}, ${kb} KB${uri ? `, ${uri}` : ""}`;
    if (/^(image|audio)\//.test(mediaType)) {
      media.push({ data, mediaType });
      parts.push(`[${label} — attached for you to see]`);
    } else {
      parts.push(`[binary ${label} — not readable as text]`);
    }
  };
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    /* An embedded resource wraps the contents; a read's contents are bare. */
    const inner = b.type === "resource" && b.resource && typeof b.resource === "object"
      ? (b.resource as Record<string, unknown>)
      : b;
    if (typeof inner.text === "string") parts.push(inner.text);
    else if (typeof inner.blob === "string") {
      binary(inner.blob, String(inner.mimeType ?? "application/octet-stream"), String(inner.uri ?? ""));
    } else if ((b.type === "image" || b.type === "audio") && typeof b.data === "string") {
      binary(b.data, String(b.mimeType ?? `${b.type}/*`));
    } else if (b.type === "resource_link" && typeof b.uri === "string") {
      parts.push(
        `[resource: ${b.uri}${b.name ? ` (${String(b.name)})` : ""}${b.description ? ` — ${String(b.description)}` : ""}]`,
      );
    } else parts.push(JSON.stringify(b));
  }
  return { text: parts.join("\n"), media };
}

/* A tool's answer as the text the model reads. `structuredContent` is sent
   only when the blocks say nothing: the spec asks a server to mirror it in a
   text block, and sending both would be the same answer twice. */
function mcpResult(result: McpToolResult, tool: string, sink: McpMedia[]): string {
  const { text, media } = blocksText(Array.isArray(result.content) ? result.content : []);
  const out =
    text ||
    (result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : "") ||
    "(empty result)";
  if (result.isError) throw new Error(out);
  for (const m of media) sink.push({ tool, ...m });
  return out;
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
