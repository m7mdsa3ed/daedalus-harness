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

const server = new McpServer(
  { name: AGENTS_SERVER_NAME, version: "1.0.0" },
  {
    instructions:
      "Ask another (profile, agent) pair to do a task and read its reply. Call list_agents for the pairs. Leave profile and agent out of ask_agent unless the user named them: the user may already have chosen a profile and model for each agent on this thread, and if not, they are shown a picker — some profiles have missing or broken credentials, and only they know which to use. The asked agent runs in a new thread and sees only the brief you give it, so make that brief complete; an ask still running when the call returns reports back as a <task-notification>, so do not poll; cancel_agent stops one.",
  },
);

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

interface Pair {
  profileId: string;
  profile: string;
  agentId: string;
  agent: string;
  installed: boolean;
  models: string[];
  defaultModel: string | null;
}

/** The picker's field names — recognised by the client (`ask-agents.tsx`), which
    draws them as the config menu's Profile and Model rows. Keys, not schema
    annotations, because a key survives every runtime's elicitation bridge. */
const PAIR = "askAgentPair";
const MODEL = "askAgentModel";
const REMEMBER = "askAgentRemember";

/** Who the ask goes to when the thread has no choice for it: nobody (the server
    applies the thread's own), or whoever the user picks now. */
async function pickPair(body: { profile?: string; agent?: string }): Promise<{ profile: string; agent: string; model?: string } | null> {
  if (body.profile && body.agent) return null;
  const { askProfiles } = (await call("/ask-profiles")) as { askProfiles: Record<string, unknown> };
  const { pairs } = (await call("/agents")) as { pairs: Pair[] };
  const is = (id: string, name: string, q: string) => id === q || name.toLowerCase() === q.trim().toLowerCase();
  const named = body.agent ? pairs.find((p) => is(p.agentId, p.agent, body.agent!)) : undefined;
  if (body.agent && !named) return null; // the server names what exists
  if (named ? askProfiles[named.agentId] : !body.agent && Object.keys(askProfiles).length === 1) return null;
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    throw new Error("no profile chosen for this thread and this runtime cannot show a picker — ask the user which profile and agent to use, then pass them");
  }
  const usable = pairs.filter((p) => p.installed && (!named || p.agentId === named.agentId));
  if (usable.length === 0) throw new Error("no installed agent to ask");
  const key = (p: Pair) => JSON.stringify([p.profileId, p.agentId]);
  const result = await server.server.elicitInput(
    {
      message: "Which profile should the asked agent use?",
      requestedSchema: {
        type: "object",
        properties: {
          [PAIR]: {
            type: "string",
            title: "Agent / profile",
            oneOf: usable.map((p) => ({ const: key(p), title: `${p.agent} / ${p.profile}` })),
          },
          [MODEL]: { type: "string", title: "Model (blank = the profile's default)" },
          [REMEMBER]: { type: "boolean", title: "Use this for every ask to this agent in this thread", default: true },
        },
        required: [PAIR],
      },
    },
    { timeout: 10 * 60_000 },
  );
  if (result.action !== "accept") throw new Error("the user declined to choose a profile — do not ask another agent");
  const hit = usable.find((p) => key(p) === result.content?.[PAIR]);
  if (!hit) throw new Error("the chosen profile is not available");
  const model = typeof result.content?.[MODEL] === "string" && result.content[MODEL] ? (result.content[MODEL] as string) : undefined;
  if (result.content?.[REMEMBER] !== false) {
    await call("/ask-profiles", { method: "PUT", body: JSON.stringify({ agentId: hit.agentId, profileId: hit.profileId, model }) });
  }
  return { profile: hit.profileId, agent: hit.agentId, model };
}

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
Always pass \`description\`: a short (3-8 word) name for the errand — "Audit the auth flow", "Second opinion on the migration" — which titles the row in the transcript. The row already says which agent answered; the description says what it was asked to do.
Use list_agents for the names. Pass \`profile\` and \`agent\` ONLY if the user named them; otherwise omit both — the profile and model the user set for that agent on this thread are used, or the user is shown a picker (some profiles have broken or missing credentials, and only they know which). Never pick one on your own or fall back to another after a failure. \`model\` defaults to that profile's own default. If the returned status is "running", do NOT poll: the reply arrives in this thread as a <task-notification> message carrying the askId and its output when the agent finishes. Meanwhile do other work, or end your turn if there is none. Several asks may run at once; the asked agent cannot ask others in turn.`,
    inputSchema: {
      profile: z.string().min(1).optional().describe("Profile name or id from list_agents — only when the user named it; omit to use the thread's pair or let the user pick."),
      agent: z.string().min(1).optional().describe("Agent name or id from list_agents — only when the user named it."),
      prompt: z.string().min(1).describe("The complete brief: it sees nothing else."),
      description: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("A short (3-8 word) name for the errand — it titles this ask's row in the transcript. Always give one."),
      model: z.string().optional().describe("A model id from that profile's catalog."),
      effort: z.string().optional(),
      timeoutSec: z.number().int().positive().optional().describe("How long the asked agent may work (default 15 min)."),
      waitSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ waitSec, ...body }) => {
    try {
      const chosen = await pickPair(body);
      return answer(await call(`/asks?wait=${clampWait(waitSec)}`, { method: "POST", body: JSON.stringify({ ...body, ...chosen }) }));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "wait_agent",
  {
    title: "Wait for an agent",
    description: `Block up to timeoutSec (default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}) on an ask and return it as it stands. Rarely needed: a running ask tells this thread when it ends (a <task-notification>). Use it only when your next step cannot happen without the reply and nothing else is worth doing meanwhile.`,
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
