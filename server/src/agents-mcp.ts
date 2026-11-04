/*
 * The `agents` MCP server (stdio): the ONE way a thread hands work to another
 * worker, and the workflow library beside it.
 *
 * It used to be two servers and three tools doing almost the same thing —
 * `ask_agent` here, `run_workflow`/`run_script` on `workflow`, and the Daedalus
 * agent's own in-process `task` — which meant two tools named `list_agents`
 * answering different questions, two follow-up verbs and two waiting models, for
 * a model that had to reason about all of it. The server already treated an ask
 * as a one-step workflow, so the split was a *tool* split, not an engine split.
 *
 * There is one tool now, `agent`, and every call makes a RUN: a prompt alone is
 * one step on your own pair (a subagent), naming a pair makes that step another
 * agent's (an ask), and `steps`/`script`/`name` make it a workflow. What kind of
 * run it is comes from the arguments, never from which tool was picked — so the
 * id, the notification, the follow-up and the stop are the same for all three.
 *
 * A thin client like before, over the same loopback (`AGENTS_URL`, the engine's
 * `/wf/<key>/<sessionId>`), so nothing here knows about the database, the
 * journal or the session manager. Every tool answers within its own wait budget:
 * an agent runtime's MCP timeout is shorter than a real answer, so a run still
 * going reports back as a <task-notification>.
 *
 * The schema is generated per thread from what the thread can actually use — the
 * workflow fields only where the runtime has no engine of its own, the roles only
 * where the profile names some — because a capability that is not on offer must
 * not be advertised (`AGENTS_WORKFLOWS`, `AGENTS_ROLES`, both from the spawn).
 *
 *   node dist/agents-mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BudgetsSchema, LIMITS } from "./workflows/graph.js";
import { SCRIPT_RULES, STEP_RULES, WHICH_SHAPE } from "./workflows/manual.js";
import { AGENTS_SERVER_NAME } from "./workflows/types.js";

const url = process.env.AGENTS_URL;
if (!url) {
  process.stderr.write("agents MCP server: AGENTS_URL is not set\n");
  process.exit(1);
}

const DEFAULT_WAIT_SEC = 45;
const MAX_WAIT_SEC = 55;

/** Whether this thread may run a graph or a script. False on a runtime that
    brings its own workflow engine (`AgentDef.workflowsVia === "native"`), and
    the fields are then not advertised at all — linking ours would disallow the
    better one, by the rule in docs/mcp-and-workflows.md. */
const WORKFLOWS = process.env.AGENTS_WORKFLOWS === "1";

/** One helper model this thread can run a subagent on, from the spawn
    (`DAEDALUS_AGENT_MODEL_ROLES`'s server-side twin): what it is called, what
    it does, and the model id the assignment resolved to. */
interface Role {
  id: string;
  label: string;
  description: string;
  model: string;
}
const ROLES: Role[] = (() => {
  try {
    const raw = JSON.parse(process.env.AGENTS_ROLES ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      const r = entry as Record<string, unknown>;
      if (typeof r?.id !== "string" || !r.id) return [];
      return [
        {
          id: r.id,
          label: typeof r.label === "string" && r.label ? r.label : r.id,
          description: typeof r.description === "string" ? r.description : "",
          model: typeof r.model === "string" ? r.model : "",
        },
      ];
    });
  } catch {
    return [];
  }
})();

const rolesClause = (): string => {
  if (ROLES.length === 0) return "";
  const list = ROLES.map((r) => (r.description ? `\`${r.id}\` (${r.label} — ${r.description})` : `\`${r.id}\` (${r.label})`)).join(", ");
  return ` Run it on a named role instead of this thread's model: ${list}. \`model\` wins over \`role\`; a role only exists for this thread's own pair.`;
};

interface Pair {
  profileId: string;
  profile: string;
  agentId: string;
  agent: string;
  installed: boolean;
  models: string[];
  defaultModel: string | null;
  current: boolean;
}

const short = (list: Pair[]): string =>
  list.length === 0
    ? "none are installed"
    : list
        .map((p) => `${p.agent} / ${p.profile}${p.current ? " (yours)" : ""}${p.installed ? "" : " (not installed)"}`)
        .join(", ");

const server = new McpServer(
  { name: AGENTS_SERVER_NAME, version: "2.0.0" },
  {
    instructions: `Hand work to another worker: \`agent\` starts a run — a one-step subagent on your own pair, an ask of another (profile, agent) pair, or a workflow — and \`agent_status\`, \`agent_message\`, \`agent_control\` and \`agent_list\` manage it. A run still going when the call returns reports back as a <task-notification>, so do not poll. Read the pairs once with \`agent_list\`: leave \`agent\`/\`profile\` out unless the user named them — this thread's choices are applied for you, and if none is set the user is asked to pick, because some profiles have broken credentials and only they know which to use.`,
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
  name: string;
  status: string;
  error: string | null;
  steps: { sessionId: string | null; output: unknown; error: string | null; status: string }[];
  result?: unknown;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

/** A run as the caller sees it. Only an ASK or a SUBAGENT is "the answer is the
    one step" — a workflow keeps its whole view even when it happens to have a
    single step, because its `result`, gates, usage, artifacts and budgets are
    what the caller asked for. The shape is read off `kind`, which the fold sets
    from the run's own spec, so the tool cannot guess it from the step count. */
const answer = (raw: unknown) => {
  const run = raw as RunView & { kind?: string };
  const one = run.kind === "ask" || run.kind === "subagent";
  const shaped =
    one && run.steps?.length === 1
      ? { id: run.id, status: run.status, threadId: run.steps[0]?.sessionId ?? null, error: run.error ?? run.steps[0]?.error ?? null, output: run.steps[0]?.output ?? null }
      : run;
  return json(shaped);
};
const failed = (error: unknown) => ({
  content: [{ type: "text" as const, text: `agents error: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});
const clampWait = (sec: number | undefined) => Math.max(1, Math.min(MAX_WAIT_SEC, Math.floor(sec ?? DEFAULT_WAIT_SEC)));
/** A start with no waitSec is a background run (wait=0). */
const startWait = (sec: number | undefined) => (sec === undefined ? 0 : clampWait(sec));

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

/** The picker's field names — recognised by the client (`ask-agents.tsx`), which
    draws them as the config menu's Profile and Model rows. Keys, not schema
    annotations, because a key survives every runtime's elicitation bridge. */
const PAIR = "askAgentPair";
const MODEL = "askAgentModel";
const REMEMBER = "askAgentRemember";

/** Who an ask goes to when the thread has no choice for it: nobody (the server
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
  const namedProfile = body.profile;
  const usable = pairs.filter(
    (p) => p.installed && (!named || p.agentId === named.agentId) && (!namedProfile || is(p.profileId, p.profile, namedProfile)),
  );
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

/** A role as the model id to pass, or an answer naming the ones that exist. The
    table is the spawn's, so a role here is the model the thread's own `task`
    would have run on — and an unknown one is a sentence the model can act on,
    never a throw (the `resolveModel` idiom). */
function resolveRole(role: string | undefined, model: string | undefined): { model?: string } | { error: string } {
  if (!role || model) return { model };
  const wanted = role.trim().toLowerCase();
  const found = ROLES.find((r) => r.id === role.trim()) ?? ROLES.find((r) => r.label.toLowerCase() === wanted);
  if (!found) {
    return { error: `Unknown role '${role}'. Known roles: ${ROLES.map((r) => r.id).join(", ") || "(none — this thread names no helper models)"}.` };
  }
  /* An unassigned role ships `""`: the session model, made explicit. */
  return { model: found.model || undefined };
}

/** The wait is the only waiting model, and its default is not one number: a
    one-step errand answers soonest, so it waits by default, while a workflow is a
    long job that starts in the background — the manual's BACKGROUND paragraph is
    true exactly there. The description says which, because a model that assumed
    one default for both would either sit on a long run or end a turn expecting
    an answer that is already in its hand. */
const waitSecField = z
  .number()
  .int()
  .min(1)
  .max(MAX_WAIT_SEC)
  .optional()
  .describe(
    `Block up to this many seconds (1-${MAX_WAIT_SEC}) for the run to end. Past it, the answer arrives as a <task-notification>. Default ${DEFAULT_WAIT_SEC} for a one-step run (prompt), and 0 — start in the background — for a workflow (steps/phases/script/name).`,
  );
const runId = z.string().min(1).describe("The run's id (the task-id of its <task-notification>).");

/* ── agent ──────────────────────────────────────────────────────────────────
 *
 * Flat, and every shape field optional: some OpenAI-compatible providers reject
 * union schemas, and a model fills a flat object more reliably than it picks a
 * branch. Exactly one of `prompt`, `steps`/`phases`, `script`, `name` is the
 * contract, and the handler says which it got in a sentence the model can act on
 * rather than throwing. */
/** What the handler receives. Declared rather than inferred from the shape,
    because the shape is CONDITIONS-built (the workflow fields are only there
    where the runtime has no engine of its own) and `z.ZodRawShape` erases the
    member types — every field would arrive as `unknown`. */
interface AgentInput {
  prompt?: string;
  description?: string;
  agent?: string;
  profile?: string;
  model?: string;
  role?: string;
  effort?: string;
  projectId?: string;
  timeoutSec?: number;
  waitSec?: number;
  steps?: Record<string, unknown>[];
  phases?: Record<string, unknown>[];
  script?: string;
  name?: string;
  args?: unknown;
  budgets?: { tokens?: number; costUsd?: number; agents?: number; wallSec?: number };
  maxParallel?: number;
  priority?: number;
  concurrencyKey?: string;
  onRestart?: "resume" | "rerun" | "fail";
  totalTimeoutSec?: number;
}

/** The flow and budget fields a run can be started with, at the top level of every
    shape. `graph.ts` accepts them on a definition and `routes.ts` on the body, and
    the manual promises the model all of them — so they are passed rather than
    described. Only what was given travels: the engine spreads these over a
    definition's own, and an `undefined` would erase one. */
const flowOf = (input: AgentInput) => ({
  ...(input.budgets ? { budgets: input.budgets } : {}),
  ...(input.priority !== undefined ? { priority: input.priority } : {}),
  ...(input.concurrencyKey ? { concurrencyKey: input.concurrencyKey } : {}),
  ...(input.onRestart ? { onRestart: input.onRestart } : {}),
  ...(input.maxParallel !== undefined ? { maxParallel: input.maxParallel } : {}),
  ...(input.totalTimeoutSec !== undefined ? { totalTimeoutSec: input.totalTimeoutSec } : {}),
});

const agentFields: z.ZodRawShape = {
  prompt: z
    .string()
    .min(1)
    .max(20_000)
    .optional()
    .describe("The whole brief for one worker. It sees NOTHING of this conversation, so include the goal, the files involved and what you want back."),
  description: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("A short (3-8 word) name for the errand — it titles the row and the child thread. Always give one for a prompt."),
  agent: z.string().min(1).optional().describe("Another agent's name or id from agent_list. Absent: this thread's own runtime. ONLY when the user named it."),
  profile: z.string().min(1).optional().describe("Another profile's name or id, with `agent`. Absent: this thread's own provider."),
  model: z.string().min(1).optional().describe("An exact model id. Wins over `role`."),
  effort: z.string().min(1).optional(),
  projectId: z.string().min(1).optional().describe("Run in another project (its id, from the harness MCP's projects listing). Omit to work in this one."),
  timeoutSec: z.number().int().positive().optional().describe("An opt-in cap on how long the worker may work. By default it has no clock of its own."),
  waitSec: waitSecField,
  ...(ROLES.length > 0
    ? { role: z.string().min(1).optional().describe("A helper model role to run it on, for this thread's own pair only (see the tool description).") }
    : {}),
  ...(WORKFLOWS
    ? {
        steps: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .optional()
          .describe(
            "A workflow's steps — THE WHOLE PLAN, when it can be written down before starting. Each: name, prompt, dependsOn, and optionally title, model, effort, profile, agent, retry, timeoutSec, isolation, output, when, forEach. Prefer this over `script`: the graph is checked before anything spawns (cycles, duplicate names, unknown reads, the step limit), so a mistake costs nothing.",
          ),
        script: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A JavaScript orchestration script, when the shape is only known as it runs: `export const meta = {name, description, phases}` then a body that awaits agent(prompt, opts), parallel, pipeline, map, vote, refine, route, race, approve, sleep, waitFor, sh, artifact, state. Globals are documented by the server; an unknown option name throws with the valid ones.",
          ),
        name: z.string().min(1).optional().describe("Run a saved workflow by its meta.name (list_workflows shows the library)."),
        args: z.unknown().optional().describe("The caller's input as real JSON: a `script`'s or saved workflow's `args`, or a `steps` graph's `inputs` (what its {{inputs.KEY}} templates read)."),
        phases: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .optional()
          .describe(
            "The same plan grouped into named stages that run one after another ({name, steps}): a phase starts only when the phase before it has finished, and its own steps run side by side. Give this OR `steps`, not both.",
          ),
        budgets: BudgetsSchema.optional().describe("Run limits; hitting one stops new agents and ends the run with its partial result. Set them for open-ended fan-out."),
        maxParallel: z.number().int().min(1).max(LIMITS.maxParallel).optional().describe(`Steps of this run at once (default ${LIMITS.defaultParallel}, max ${LIMITS.maxParallel}).`),
        priority: z.number().int().min(-100).max(100).optional().describe("Higher runs first when the shared agent pool is contended."),
        concurrencyKey: z.string().min(1).max(80).optional().describe("Runs sharing a key share one concurrency pool — e.g. one writer per repo."),
        onRestart: z.enum(["resume", "rerun", "fail"]).optional().describe("What a step in flight at a server restart does; the default for every step that names none."),
        totalTimeoutSec: z.number().int().positive().optional().describe("The run's own wall clock, paused time excluded; past it the run fails."),
      }
    : {}),
};

server.registerTool(
  "agent",
  {
    title: "Hand work to an agent",
    description: `Give work to another worker and get its answer — ONE tool for every shape, because the run underneath is the same.

WHAT IT MAKES: \`prompt\` alone = one step on your own pair (a subagent, same model and rules as this thread)${
      WORKFLOWS ? ", \`steps\`/\`phases\`/\`script\` = a multi-step workflow where every step is a real thread" : ""
    }, and \`agent\`/\`profile\` = that one step on another pair (an ask). Give exactly one of ${["prompt", WORKFLOWS ? "steps" : "", WORKFLOWS ? "phases" : "", WORKFLOWS ? "script" : "", WORKFLOWS ? "name" : ""].filter(Boolean).map((f) => `\`${f}\``).join(", ")}.

WHAT IT COSTS: the call returns when the run ends OR when \`waitSec\` expires, whichever comes first. A run still going then arrives in this thread as a <task-notification> carrying its id and result — do NOT poll for it; do other work, or end your turn if there is none. A one-step run waits ${DEFAULT_WAIT_SEC}s by default because it usually answers by then; a workflow starts in the background unless you ask for a wait, because a long job is not an errand.${
      WORKFLOWS
        ? " A workflow's whole view — every step, gates, usage, artifacts, budgets and `result` — comes back even when it has a single step, so read `result` rather than one step's prose."
        : ""
    }

WHO: pass \`agent\` and \`profile\` ONLY if the user named them. Left out, the pair the user set for that agent on this thread is used, and if none is set they are shown a picker — some profiles have broken or missing credentials and only they know which. Never pick one yourself, and never fall back to a different pair after a failure. A worker sees ONLY the brief you give it.

AFTERWARDS: \`agent_message\` picks a stopped, failed or finished run back up on the same child thread and keeps its conversation; \`agent_status\` reads or waits on one; \`agent_control\` stops, holds or signals one; and a worker cannot hand work on to another (one level, never a tree).${rolesClause()}${
      WORKFLOWS ? `\n\n${WHICH_SHAPE}\n\nSTEPS\n${STEP_RULES}\n\nSCRIPT\n${SCRIPT_RULES}` : ""
    }`,
    inputSchema: agentFields,
    annotations: WRITE,
  },
  async (raw) => {
    let input = raw as AgentInput;
    try {
      /* `steps` and `phases` are two ways of writing the same plan, so they are
         one shape between them — `graph.ts` refuses a definition carrying both. */
      const graph = Boolean(input.steps || input.phases);
      const shapes = [
        input.prompt ? "prompt" : "",
        WORKFLOWS && graph ? (input.phases ? "phases" : "steps") : "",
        WORKFLOWS && input.script ? "script" : "",
        WORKFLOWS && input.name ? "name" : "",
      ].filter(Boolean);
      if (shapes.length !== 1) {
        const usable = ["prompt", ...(WORKFLOWS ? ["steps", "phases", "script", "name"] : [])].map((f) => `\`${f}\``).join(", ");
        return failed(`give exactly one of ${usable} — you gave ${shapes.length ? shapes.map((f) => `\`${f}\``).join(" and ") : "none"}`);
      }
      if (WORKFLOWS && input.steps && input.phases) {
        return failed("give `steps` OR `phases`, not both — they are two ways of writing the same plan");
      }
      if (input.projectId && shapes[0] !== "prompt") {
        return failed("`projectId` is for a one-step run; a workflow's steps each carry their own, or inherit the thread's project");
      }
      /* A one-step run has no graph to limit or order, so these are refused rather
         than accepted and quietly dropped — the run would look constrained and not be. */
      if (shapes[0] === "prompt") {
        const flow = ["budgets", "maxParallel", "priority", "concurrencyKey", "onRestart", "totalTimeoutSec"].filter(
          (f) => (input as Record<string, unknown>)[f] !== undefined,
        );
        if (flow.length) {
          return failed(
            `${flow.map((f) => `\`${f}\``).join(", ")} ${flow.length === 1 ? "belongs" : "belong"} to a workflow (steps/phases/script/name) — a one-step run has no graph to order and no budget of its own; give \`timeoutSec\` to cap it`,
          );
        }
      }

      /* A script or a saved workflow decides each agent() call's pair, model and
         clock itself, so the one-step fields have nowhere to go — refused, like
         the flow fields on a prompt, rather than accepted and dropped. */
      if (shapes[0] === "script" || shapes[0] === "name") {
        const stray = ["agent", "profile", "model", "role", "effort", "timeoutSec", "description"].filter(
          (f) => (input as Record<string, unknown>)[f] !== undefined,
        );
        if (stray.length) {
          return failed(
            `${stray.map((f) => `\`${f}\``).join(", ")} ${stray.length === 1 ? "does" : "do"} not apply to a \`${shapes[0]}\` run — its agent() calls name their own pair, model and timeout (and a script's meta names it)`,
          );
        }
      }

      /* The workflow shapes: the definition object is assembled from the flat
         fields, so the tool stays loadable on a provider that dislikes unions. */
      if (shapes[0] === "steps" || shapes[0] === "phases" || shapes[0] === "script" || shapes[0] === "name") {
        if (shapes[0] === "name") {
          return json(
            await call(`/scripts?wait=${startWait(input.waitSec)}`, {
              method: "POST",
              body: JSON.stringify({ name: input.name, args: input.args, ...flowOf(input) }),
            }),
          );
        }
        if (shapes[0] === "script") {
          return json(
            await call(`/scripts?wait=${startWait(input.waitSec)}`, {
              method: "POST",
              body: JSON.stringify({ script: input.script, args: input.args, ...flowOf(input) }),
            }),
          );
        }
        /* A graph: the top-level pair and model are the DEFAULT for every step
           that names none, so a one-step call is not a special case — it is a
           workflow whose only step inherits everything. */
        /* Every field a definition takes is reachable: the whole plan (`steps` or
           `phases`), its inputs, and the limits/flow the manual promises. What is
           not given is left absent rather than passed as `undefined`, because the
           engine spreads these over a definition's own and an undefined erases one. */
        if (input.role && (input.agent || input.profile)) {
          return failed(`a role cannot cross to another pair — "${input.role}" names a model in this thread's own catalog. Name the \`model\` that profile serves instead.`);
        }
        if (input.role) {
          const resolved = resolveRole(input.role, input.model);
          if ("error" in resolved) return failed(resolved.error);
          input = { ...input, model: resolved.model };
        }
        const definition = {
          name: input.description ?? stepsName(input.steps ?? (input.phases?.[0]?.steps as Record<string, unknown>[] | undefined)),
          ...(input.description ? { description: input.description } : {}),
          ...(input.phases
            ? { phases: (input.phases as Record<string, unknown>[]).map((phase) => ({ ...phase, steps: inherit(phase.steps, input) })) }
            : { steps: inherit(input.steps, input) }),
          ...(input.budgets ? { budgets: input.budgets } : {}),
          ...(input.maxParallel !== undefined ? { maxParallel: input.maxParallel } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.concurrencyKey ? { concurrencyKey: input.concurrencyKey } : {}),
          ...(input.onRestart ? { onRestart: input.onRestart } : {}),
          ...(input.totalTimeoutSec !== undefined ? { totalTimeoutSec: input.totalTimeoutSec } : {}),
        };
        return json(
          await call(`/runs?wait=${startWait(input.waitSec)}`, {
            method: "POST",
            body: JSON.stringify({ definition, ...(input.args !== undefined ? { inputs: input.args } : {}) }),
          }),
        );
      }

      /* One step. Naming a pair makes it an ask, and the person's choice for
         that agent outranks whatever was passed (`pickPair`). */
      let pair: { profile?: string; agent?: string } = { profile: input.profile, agent: input.agent };
      if (input.agent || input.profile) {
        const chosen = await pickPair({ profile: input.profile, agent: input.agent });
        if (chosen) pair = { profile: chosen.profile, agent: chosen.agent };
        if (chosen?.model && !input.model) input = { ...input, model: chosen.model };
      }
      /* A role names a model in THIS thread's catalog, so it is only resolved on
         the thread's own pair; on another pair it is the user's question. */
      let model = input.model;
      if (input.role && (pair.agent || pair.profile)) {
        return failed(`a role cannot cross to another pair — "${input.role}" names a model in this thread's own catalog. Name the \`model\` that profile serves instead.`);
      }
      if (input.role) {
        const resolved = resolveRole(input.role, input.model);
        if ("error" in resolved) return failed(resolved.error);
        model = resolved.model;
      }
      return answer(
        await call(`/steps?wait=${clampWait(input.waitSec)}`, {
          method: "POST",
          body: JSON.stringify({
            ...pair,
            prompt: input.prompt,
            ...(input.description ? { description: input.description } : {}),
            ...(model ? { model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.timeoutSec ? { timeoutSec: input.timeoutSec } : {}),
            ...(input.projectId ? { projectId: input.projectId } : {}),
          }),
        }),
      );
    } catch (error) {
      return failed(error);
    }
  },
);

/** The top-level pair and model are the DEFAULT for every step that names none,
    so a one-step graph is not a special case — it is a workflow whose only step
    inherits everything. A step's own value always wins. */
function inherit(steps: unknown, input: AgentInput): Record<string, unknown>[] {
  return (Array.isArray(steps) ? (steps as Record<string, unknown>[]) : []).map((step) => ({
    ...step,
    /* The pair is one unit: a step that names either half keeps its own, or a
       step naming another agent would be handed a profile meant for this one. */
    ...(step.agent === undefined && step.profile === undefined
      ? { ...(input.agent ? { agent: input.agent } : {}), ...(input.profile ? { profile: input.profile } : {}) }
      : {}),
    ...(input.model && step.model === undefined ? { model: input.model } : {}),
    ...(input.effort && step.effort === undefined ? { effort: input.effort } : {}),
    ...(input.timeoutSec && step.timeoutSec === undefined ? { timeoutSec: input.timeoutSec } : {}),
  }));
}

/** A workflow needs a name and the call may not have given a description: the
    first step's title, else the first few words of its prompt, else "Workflow". */
function stepsName(steps: Record<string, unknown>[] | undefined): string {
  const first = Array.isArray(steps) ? steps[0] : undefined;
  if (typeof first?.title === "string" && first.title.trim()) return first.title.trim();
  const prompt = typeof first?.prompt === "string" ? first.prompt : "";
  return prompt.trim().split(/\s+/).slice(0, 8).join(" ") || "Workflow";
}

server.registerTool(
  "agent_status",
  {
    title: "Read or wait on a run",
    description: `The state of one run without waiting — status, its steps with outputs and errors${WORKFLOWS ? ", open gates (approvals, timers, signal waits), state, artifacts, logs, usage" : ""} — or, with \`waitSec\`, block on it up to that long and return it as it stands. Rarely needed: a running run tells this thread when it ends. Use it when your next step cannot happen without the answer and nothing else is worth doing meanwhile, or to read what a finished one produced.`,
    inputSchema: { id: runId, waitSec: waitSecField },
    annotations: READ,
  },
  async ({ id, waitSec }) => {
    try {
      const query = waitSec === undefined ? "" : `?wait=${clampWait(waitSec)}`;
      return answer(await call(`/runs/${encodeURIComponent(id)}${query}`));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "agent_message",
  {
    title: "Continue a run",
    description: `Pick a run back up where it stopped — one that failed, was stopped, timed out or finished. For a one-step run it is the SAME child thread with its whole conversation, so the prompt can be short ("continue", or what to do differently) and is not a new brief. A workflow run is relaunched from its journal: completed steps answer without running again, and only the failed, stopped or new ones do — which is why it takes no prompt. A running run is refused; wait on it instead. Answers within \`waitSec\`, else as a <task-notification>.`,
    inputSchema: {
      id: runId,
      prompt: z.string().max(20_000).optional().describe('What to tell it; defaults to "continue where you left off".'),
      waitSec: waitSecField,
    },
    annotations: WRITE,
  },
  async ({ id, prompt, waitSec }) => {
    try {
      return answer(
        await call(`/runs/${encodeURIComponent(id)}/continue?wait=${clampWait(waitSec)}`, {
          method: "POST",
          body: JSON.stringify({ prompt }),
        }),
      );
    } catch (error) {
      return failed(error);
    }
  },
);

const CONTROL = ["cancel", "pause", "resume", "signal"] as const;

server.registerTool(
  "agent_control",
  {
    title: "Control a run",
    description: `Act on a run of this thread: \`cancel\` stops it (running steps are interrupted, pending ones never start, what it had is kept), \`pause\` holds it with every clock stopped, \`resume\` carries on where it stood, and \`signal\` delivers \`value\` to the oldest open \`waitFor(name)\` of a script run — or buffers it for the next one. An approval gate is not answerable here: the user answers those in the app, and you must not try to work around that.`,
    inputSchema: {
      id: runId,
      action: z.enum(CONTROL),
      ...(WORKFLOWS
        ? {
            name: z.string().regex(/^[\w.-]{1,80}$/).optional().describe("The signal name a script passes to waitFor. Required for `signal`."),
            value: z.unknown().optional().describe("Any JSON; what waitFor resolves with. Default null."),
          }
        : {}),
    },
    annotations: IDEMPOTENT,
  },
  async ({ id, action, name, value }) => {
    try {
      const at = `/runs/${encodeURIComponent(id)}`;
      if (action === "signal") {
        if (!WORKFLOWS) return failed("this agent has no workflow engine of its own to signal — there is nothing waiting");
        if (!name) return failed("`signal` needs a `name`: the signal a script's waitFor is waiting on");
        return json(await call(`${at}/signal`, { method: "POST", body: JSON.stringify({ name, value: value ?? null }) }));
      }
      return json(await call(`${at}/${action}`, { method: "POST", body: "{}" }));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "agent_list",
  {
    title: "List agents and runs",
    description:
      "The (profile, agent) pairs this thread can hand work to — each profile is a provider and each agent a coding runtime; `current` marks your own pair, `installed: false` cannot be asked — and, with `runs`, this thread's recent runs (id, name, status, times) newest first. Read the pairs before naming an agent, and the runs to find an id you lost or to see what is still going.",
    inputSchema: {
      runs: z.boolean().optional().describe("Also list this thread's recent runs (subagents, asks and workflows)."),
    },
    annotations: READ,
  },
  async ({ runs }) => {
    try {
      const [pairs, runsList] = await Promise.all([
        call("/agents"),
        runs ? call("/runs?limit=20") : Promise.resolve(null),
      ]);
      return json({ ...(pairs as object), ...(runsList ? { runs: (runsList as { runs: unknown[] }).runs } : {}) });
    } catch (error) {
      return failed(error);
    }
  },
);

/* ── the library ────────────────────────────────────────────────────────────
 *
 * Saved workflows manage the library; they do not hand work to anybody, which is
 * why they are four tools of their own rather than shapes of `agent`. */

if (WORKFLOWS) {
  server.registerTool(
    "list_workflows",
    {
      title: "List saved workflows",
      description:
        "Saved workflow scripts this thread can run by name with `agent({name})`: the project's and the personal library (the project one wins a name clash), mirrored to .claude/workflows/ so Claude Code sees the same files. Each has a name, description, scope, version, the JSON Schema of its inputs (what `args` it takes) and, when its author gave one, whenToUse.",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      try {
        return json(await call("/saved"));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    "save_workflow",
    {
      title: "Save a workflow",
      description:
        "Save a script as a reusable workflow named by its meta.name — into the project library (mirrored to the project's .claude/workflows/, shared with everyone who clones the repo) or the personal one (~/.claude/workflows/). Give `id` to keep the script of a run of this thread, or `script` to save source directly. Overwrites a saved workflow of the same name. Save only when the user asks to keep it.",
      inputSchema: {
        runId: z.string().min(1).optional().describe("A run of this thread whose script to save."),
        script: z.string().min(1).optional().describe("Script source to save directly (`export const meta = {…}` then the body)."),
        scope: z.enum(["project", "personal"]).optional(),
      },
      annotations: IDEMPOTENT,
    },
    async ({ runId: id, script, scope }) => {
      try {
        if ((id === undefined) === (script === undefined)) throw new Error("give either runId or script, not both and not neither");
        return json(await call("/saved", { method: "POST", body: JSON.stringify({ runId: id, script, scope }) }));
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    "delete_workflow",
    {
      title: "Delete a saved workflow",
      description:
        "Delete a saved workflow by name (and its mirrored .claude/workflows/ file). Pass scope when the same name exists in both libraries; otherwise the one `agent({name})` would pick is deleted. Delete only when the user asks.",
      inputSchema: { name: z.string().min(1), scope: z.enum(["project", "personal"]).optional() },
      annotations: DESTRUCTIVE,
    },
    async ({ name, scope }) => {
      try {
        const query = scope ? `?scope=${scope}` : "";
        return json(await call(`/saved/${encodeURIComponent(name)}${query}`, { method: "DELETE" }));
      } catch (error) {
        return failed(error);
      }
    },
  );
}

server
  .connect(new StdioServerTransport())
  .then(() => process.stderr.write("agents MCP server running\n"))
  .catch((err) => {
    process.stderr.write(`agents MCP server failed: ${String(err)}\n`);
    process.exit(1);
  });
