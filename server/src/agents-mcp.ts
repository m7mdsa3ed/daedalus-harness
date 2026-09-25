/*
 * The `agents` MCP server (stdio): one thread asking another (profile, agent)
 * pair — Codex on one provider, Claude Code on another, the Daedalus agent on
 * a third — and reading its answer.
 *
 * A thin client like workflow-mcp.ts, over the same loopback (`AGENTS_URL`,
 * the runner's `/wf/<key>/<sessionId>`): an ask is a one-step workflow run
 * whose step names its own pair, so the child is a real thread mirrored into
 * the caller as a subagent, and waiting and cancelling are the run routes.
 * Every tool answers within its wait budget, for the reason workflow-mcp.ts
 * gives: an agent runtime's MCP timeout is shorter than a real answer.
 *
 *   node dist/agents-mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AGENTS_SERVER_NAME } from "./workflow-schema.js";

const url = process.env.AGENTS_URL;
if (!url) {
  process.stderr.write("agents MCP server: AGENTS_URL is not set\n");
  process.exit(1);
}

const DEFAULT_WAIT_SEC = 45;
const MAX_WAIT_SEC = 55;

const server = new McpServer({ name: AGENTS_SERVER_NAME, version: "1.0.0" });

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout((MAX_WAIT_SEC + 5) * 1000),
  });
  const body = (await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))) as Record<string, unknown>;
  if (!res.ok) {
    const error = body.error;
    throw new Error(typeof error === "string" ? error : JSON.stringify(error ?? body));
  }
  return body;
}

interface RunView {
  id: string;
  status: string;
  error: string | null;
  steps: { sessionId: string | null; output: unknown }[];
}

/** A run as an ask: the one step's answer, not the run's bookkeeping. */
const answer = (raw: unknown) => {
  const run = raw as RunView;
  const step = run.steps[0];
  const shaped = { askId: run.id, status: run.status, threadId: step?.sessionId ?? null, error: run.error, output: step?.output ?? null };
  return { content: [{ type: "text" as const, text: JSON.stringify(shaped, null, 2) }] };
};
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failed = (error: unknown) => ({
  content: [{ type: "text" as const, text: `agents error: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});
const clampWait = (sec: number | undefined) => Math.max(1, Math.min(MAX_WAIT_SEC, Math.floor(sec ?? DEFAULT_WAIT_SEC)));

server.registerTool(
  "list_agents",
  {
    title: "List agents",
    description:
      "The (profile, agent) pairs on this server that ask_agent can reach: each profile is a provider (credentials and a model catalog) and each agent a coding runtime. `current` marks your own pair; `installed: false` cannot be asked.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return json(await call("/agents"));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "ask_agent",
  {
    title: "Ask another agent",
    description: `Give a task to another agent — a different runtime, provider or model — and wait up to waitSec (default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}) for its reply. It runs in a NEW thread on this server, in the same project and working directory as you, and sees NOTHING of this conversation: the prompt is its whole brief, so include the goal, the files involved and what you want back. Its final reply is \`output\`.
Use list_agents for the names. Unless the user named the profile themselves, ASK THE USER which profile to use before calling — some profiles have broken or missing credentials, and only the user knows which; never pick one on your own or fall back to another after a failure. \`model\` defaults to that profile's own default. If the returned status is "running", call wait_agent with the askId until it is completed, failed or cancelled. Several asks may run at once; the asked agent cannot ask others in turn.`,
    inputSchema: {
      profile: z.string().min(1).describe("Profile name or id, from list_agents — the one the user chose."),
      agent: z.string().min(1).describe("Agent name or id, from list_agents."),
      prompt: z.string().min(1).describe("The complete brief: it sees nothing else."),
      model: z.string().optional().describe("A model id from that profile's catalog."),
      effort: z.string().optional(),
      timeoutSec: z.number().int().positive().optional().describe("How long the asked agent may work (default 15 min)."),
      waitSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ waitSec, ...body }) => {
    try {
      return answer(await call(`/asks?wait=${clampWait(waitSec)}`, { method: "POST", body: JSON.stringify(body) }));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "wait_agent",
  {
    title: "Wait for an agent",
    description: `Wait up to timeoutSec (default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}) for an ask and return it as it stands. Call again while status is "running".`,
    inputSchema: { askId: z.string().min(1), timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ askId, timeoutSec }) => {
    try {
      return answer(await call(`/runs/${encodeURIComponent(askId)}?wait=${clampWait(timeoutSec)}`));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "cancel_agent",
  {
    title: "Cancel an ask",
    description: "Stop an agent you asked: its turn is interrupted and its thread retired.",
    inputSchema: { askId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ askId }) => {
    try {
      return answer(await call(`/runs/${encodeURIComponent(askId)}/cancel`, { method: "POST", body: "{}" }));
    } catch (error) {
      return failed(error);
    }
  },
);

server
  .connect(new StdioServerTransport())
  .then(() => process.stderr.write("agents MCP server running\n"))
  .catch((err) => {
    process.stderr.write(`agents MCP server failed: ${String(err)}\n`);
    process.exit(1);
  });
