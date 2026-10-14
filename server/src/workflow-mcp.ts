/*
 * The `workflow` MCP server (stdio).
 *
 * Spawned by the agent — claude-code, codex or opencode — as a regular stdio
 * MCP server the harness declared on `session/new`. It is a thin client: the
 * engine (workflows.ts) lives in the server process, and the only thing this
 * process is handed is `WORKFLOW_URL`, the loopback address that names the
 * calling thread. Nothing here knows about the database or the manager.
 *
 * Every tool answers within its own wait budget and never longer: an agent
 * runtime's MCP tool timeout is its own (codex defaults to 60s; Claude Code's
 * is a hard wall clock) and a pipeline is longer than any of them — so
 * `run_workflow` returns the run as it stands when the budget is up, and
 * `wait_workflow` picks it up again.
 *
 * Written to be invoked directly as the MCP server executable:
 *   node dist/workflow-mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LIMITS, WORKFLOW_SERVER_NAME, WorkflowDefinitionShape } from "./workflow-schema.js";
import { SCRIPT_LIMITS } from "./workflow-script.js";

const url = process.env.WORKFLOW_URL;
if (!url) {
  process.stderr.write("workflow MCP server: WORKFLOW_URL is not set\n");
  process.exit(1);
}

const DEFAULT_WAIT_SEC = 45;
const MAX_WAIT_SEC = 55;

const server = new McpServer(
  { name: WORKFLOW_SERVER_NAME, version: "1.0.0" },
  {
    instructions:
      "Run multi-step workflows where every step is a real thread on this server, in this thread's project. run_workflow takes a declarative definition — steps (or named phases of steps) with dependsOn ordering and a prompt each; run_script takes an orchestration script for work whose shape is only known as it runs. Runs start in the background and report back as a <task-notification>, so do not poll; list_workflows shows saved ones runnable by name, and pause/resume/cancel act on a runId.",
  },
);

const BACKGROUND = `The run starts in the BACKGROUND and the call returns at once with its runId. Do not poll and do not call wait_workflow to wait it out: when the run ends, its outcome arrives in this thread as a <task-notification> message carrying the runId, status and result, and you continue from there. Meanwhile do other work, or end your turn if there is none. Passing waitSec only blocks the call that long; the run still tells you when it ends unless that wait already returned it ended.`;

const RULES = `A workflow is a set of named steps. Each step runs its prompt in a NEW thread on this server — same project, same profile, agent and model as this thread — and its final reply is the step's output. Steps whose \`dependsOn\` are all complete run in parallel (up to maxParallel, default ${LIMITS.defaultParallel}); a chain of dependsOn is a pipeline. At most ${LIMITS.maxSteps} steps.
Write it either way: \`steps\` is one flat list ordered by dependsOn; \`phases\` is that list grouped into up to ${LIMITS.maxPhases} named stages (\`[{name, steps:[…]}]\`) that run one after another — a phase begins only when every step of the phase before it has completed, and its own steps run side by side. Prefer phases when the work has stages ("research" then "implement" then "verify"): the stages are named for the reader, and within them you only need dependsOn for ordering *inside* a phase.
Templates: a prompt may contain {{inputs.NAME}} and {{steps.STEP.output}} (STEP must be in that step's dependsOn, or — with phases — in any earlier phase). When a step declares \`output: {schema}\` its reply must contain exactly one \`\`\`json fence matching that JSON Schema; then {{steps.STEP.output.path.to.field}} reads into it (arrays by index). A reply that does not validate gets one repair turn, then the step fails.
Steps run with your permission mode and cannot start workflows themselves. A step takes a few seconds to start. A step that fails skips everything depending on it; siblings already running finish.
A run can be paused (pause_workflow): no further step starts, steps whose runtime can hold do so at their next step boundary (a step on a runtime that cannot runs to its end), and the clocks stop; resume_workflow carries on exactly where it stood. Nothing is thrown away, which is what makes it a pause and not a cancel.
${BACKGROUND}`;

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    /* The engine answers within the wait budget; a loopback that hangs past it
       (the server dying mid-poll) must fail the tool call rather than sit until
       the runtime's own MCP timeout does it less politely. */
    signal: AbortSignal.timeout((MAX_WAIT_SEC + 5) * 1000),
  });
  const body = (await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }))) as Record<string, unknown>;
  if (!res.ok) {
    const error = body.error;
    throw new Error(typeof error === "string" ? error : JSON.stringify(error ?? body));
  }
  return body;
}

const summarize = (run: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(run, null, 2) }] });
const failed = (error: unknown) => ({
  content: [{ type: "text" as const, text: `workflow error: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});
const clampWait = (sec: number | undefined) => Math.max(1, Math.min(MAX_WAIT_SEC, Math.floor(sec ?? DEFAULT_WAIT_SEC)));
/** A start with no waitSec is a background run (wait=0). */
const startWait = (sec: number | undefined) => (sec === undefined ? 0 : clampWait(sec));

server.registerTool(
  "run_workflow",
  {
    title: "Run a workflow",
    description: `Start a multi-step, multi-thread workflow in the background.\n${RULES}`,
    inputSchema: {
      definition: z.object(WorkflowDefinitionShape).describe("The workflow: its steps (or phases of steps), their dependencies and prompts."),
      inputs: z.record(z.string(), z.unknown()).optional().describe("Values for {{inputs.NAME}} references."),
      waitSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ definition, inputs, waitSec }) => {
    try {
      return summarize(
        await call(`/runs?wait=${startWait(waitSec)}`, { method: "POST", body: JSON.stringify({ definition, inputs: inputs ?? {} }) }),
      );
    } catch (error) {
      return failed(error);
    }
  },
);

const SCRIPT_RULES = `The script is JavaScript. It runs on this server and orchestrates agents; it is NOT where the work happens — every \`agent()\` call runs its prompt in a NEW thread on this server (same project, profile, agent and model as this thread) and resolves with that agent's final reply.

Begin with a pure literal \`export const meta = { name, description, phases }\` — no variables, calls or interpolation, because the run is named and its stages drawn before it runs. Then the body, where top-level \`await\` and a top-level \`return\` both work; what you return is the run's result.

  export const meta = { name: 'audit', description: 'Audit each subsystem', phases: [{ title: 'Read' }, { title: 'Verify' }] }
  phase('Read')
  const found = await parallel(AREAS.map((a) => () => agent(\`Audit \${a}\`, { label: 'read:' + a, schema: FINDINGS })))
  phase('Verify')
  return await pipeline(found.filter(Boolean).flatMap((f) => f.findings),
    (f) => agent(\`Try to refute: \${f.title}\`, { label: 'verify:' + f.title, schema: VERDICT }))

API — agent(prompt, {label, phase, schema, model, effort, isolation, agentType}) spawns one agent; with \`schema\` (a JSON Schema) its reply must be one \`\`\`json fence matching it, gets one repair turn, and agent() resolves with the parsed object. \`isolation: 'worktree'\` gives the agent a git worktree of its own — EXPENSIVE, use it only when parallel agents edit files and would collide. \`agentType\` names a saved prompt (its @handle without the @) whose text leads the agent's prompt — the custom-subagent equivalent here. workflow(nameOrRef, args) runs a saved workflow (by meta.name) or {scriptPath} inline and returns its result; it shares this run's agent cap, cancel and budget, and one level only. parallel(thunks) awaits all and is a BARRIER — a thunk that throws becomes null, so \`.filter(Boolean)\`. pipeline(items, ...stages) runs each item through every stage independently with NO barrier between them; each stage gets (previous, item, index). Prefer pipeline: a barrier makes every fast item wait for the slowest. phase(title) names the stage the following agents belong to; inside pipeline/parallel prefer agent's own {phase} so stages do not race the global one. log(message) narrates to the reader. \`args\` is what you passed in. \`budget\` is {total, spent(), remaining()}. meta may carry \`whenToUse\`, shown by list_workflows.

Limits: ${SCRIPT_LIMITS.maxAgents} agents per run, ${SCRIPT_LIMITS.maxItems} items per parallel/pipeline call, ${LIMITS.maxParallel} agents running at once (the rest queue). Date.now(), new Date() and Math.random() all throw — a run that reads a clock cannot be replayed; pass a timestamp through \`args\` and vary prompts by index. There is no filesystem, no network and no require: the agents you spawn do that work, not the script.
To run a SAVED workflow pass \`name\` instead of \`script\` (list_workflows shows them; save_workflow keeps a run's script). To RELAUNCH a stopped, failed or edited run pass \`resumeFromRunId\` — with no \`script\`/\`args\` the earlier ones are reused — and every agent() call identical to one that completed returns its saved result without spawning; only new, changed or failed calls run.
Agent outputs are in \`steps[].output\`, and the script's own return value in \`result\`.
${BACKGROUND}`;

server.registerTool(
  "run_script",
  {
    title: "Run a workflow script",
    description: `Orchestrate many agents from a script — for work whose shape is only known as it runs: fanning out over a list a first agent discovered, looping until a search goes dry, or having agents check each other's findings. For a pipeline you can write down in full up front, run_workflow is simpler.\n${SCRIPT_RULES}`,
    inputSchema: {
      script: z.string().min(1).optional().describe("The orchestration script: `export const meta = {…}` then the body."),
      name: z.string().min(1).optional().describe("Run a saved workflow by its meta.name instead of passing a script."),
      resumeFromRunId: z.string().min(1).optional().describe("Relaunch an earlier script run, reusing every completed agent whose call is unchanged."),
      args: z.unknown().optional().describe("Passed to the script as the `args` global. Give real JSON, not a JSON string."),
      tokenBudget: z.number().int().positive().optional().describe("Output-token ceiling for the whole run, readable as `budget`. Agents past it are refused."),
      waitSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ script, name, resumeFromRunId, args, tokenBudget, waitSec }) => {
    try {
      return summarize(
        await call(`/scripts?wait=${startWait(waitSec)}`, {
          method: "POST",
          body: JSON.stringify({ script, name, resumeFromRunId, args, tokenBudget }),
        }),
      );
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "list_workflows",
  {
    title: "List saved workflows",
    description:
      "Saved workflow scripts this thread can run by name with run_script({name}): the project's .claude/workflows/ and the personal ~/.claude/workflows/ (the project one wins a name clash). Each has a name, description and, when its author gave one, whenToUse.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return summarize(await call("/saved"));
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
      "Save a script run's script as a reusable workflow named by its meta.name — into the project's .claude/workflows/ (shared with everyone who clones the repo) or the personal ~/.claude/workflows/. Overwrites a saved workflow of the same name. Save only when the user asks to keep it.",
    inputSchema: {
      runId: z.string().min(1),
      scope: z.enum(["project", "personal"]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ runId, scope }) => {
    try {
      return summarize(await call("/saved", { method: "POST", body: JSON.stringify({ runId, scope }) }));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "wait_workflow",
  {
    title: "Wait for a workflow",
    description: `Block up to timeoutSec (default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}) on a running workflow and return it as it stands. Rarely needed: a background run tells this thread when it ends. Use it only when your next step cannot happen without the result and nothing else is worth doing meanwhile.`,
    inputSchema: { runId: z.string().min(1), timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ runId, timeoutSec }) => {
    try {
      return summarize(await call(`/runs/${encodeURIComponent(runId)}?wait=${clampWait(timeoutSec)}`));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "workflow_status",
  {
    title: "Workflow status",
    description: "The current state of a workflow run, without waiting.",
    inputSchema: { runId: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ runId }) => {
    try {
      return summarize(await call(`/runs/${encodeURIComponent(runId)}`));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "cancel_workflow",
  {
    title: "Cancel a workflow",
    description: "Stop a running workflow: running steps are interrupted, pending ones never start.",
    inputSchema: { runId: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ runId }) => {
    try {
      return summarize(await call(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" }));
    } catch (error) {
      return failed(error);
    }
  },
);

for (const verb of ["pause", "resume"] as const) {
  server.registerTool(
    `${verb}_workflow`,
    {
      title: verb === "pause" ? "Pause a workflow" : "Resume a workflow",
      description:
        verb === "pause"
          ? "Hold a running workflow: no further step starts, pausable steps hold at their next step boundary, and the clocks stop. Nothing is lost — resume_workflow continues it."
          : "Continue a paused workflow exactly where it stood.",
      inputSchema: { runId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ runId }) => {
      try {
        return summarize(await call(`/runs/${encodeURIComponent(runId)}/${verb}`, { method: "POST", body: "{}" }));
      } catch (error) {
        return failed(error);
      }
    },
  );
}

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => process.stderr.write("workflow MCP server running\n"))
  .catch((err) => {
    process.stderr.write(`workflow MCP server failed: ${String(err)}\n`);
    process.exit(1);
  });
