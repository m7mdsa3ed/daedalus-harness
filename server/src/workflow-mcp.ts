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

const server = new McpServer({ name: WORKFLOW_SERVER_NAME, version: "1.0.0" });

const RULES = `A workflow is a set of named steps. Each step runs its prompt in a NEW thread on this server — same project, same profile, agent and model as this thread — and its final reply is the step's output. Steps whose \`dependsOn\` are all complete run in parallel (up to maxParallel, default ${LIMITS.defaultParallel}); a chain of dependsOn is a pipeline. At most ${LIMITS.maxSteps} steps.
Write it either way: \`steps\` is one flat list ordered by dependsOn; \`phases\` is that list grouped into up to ${LIMITS.maxPhases} named stages (\`[{name, steps:[…]}]\`) that run one after another — a phase begins only when every step of the phase before it has completed, and its own steps run side by side. Prefer phases when the work has stages ("research" then "implement" then "verify"): the stages are named for the reader, and within them you only need dependsOn for ordering *inside* a phase.
Templates: a prompt may contain {{inputs.NAME}} and {{steps.STEP.output}} (STEP must be in that step's dependsOn, or — with phases — in any earlier phase). When a step declares \`output: {schema}\` its reply must contain exactly one \`\`\`json fence matching that JSON Schema; then {{steps.STEP.output.path.to.field}} reads into it (arrays by index). A reply that does not validate gets one repair turn, then the step fails.
Steps run with your permission mode and cannot start workflows themselves. A step takes a few seconds to start. A step that fails skips everything depending on it; siblings already running finish.
A run can be paused (pause_workflow): no further step starts, steps whose runtime can hold do so at their next step boundary (a step on a runtime that cannot runs to its end), and the clocks stop; resume_workflow carries on exactly where it stood. Nothing is thrown away, which is what makes it a pause and not a cancel.
Each call returns within its wait budget. If the returned status is "running" or "paused", call wait_workflow with the runId until it is completed, failed or cancelled. Step outputs are in \`steps[].output\`.`;

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

server.registerTool(
  "run_workflow",
  {
    title: "Run a workflow",
    description: `Start a multi-step, multi-thread workflow and wait up to waitSec (default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}) for it.\n${RULES}`,
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
        await call(`/runs?wait=${clampWait(waitSec)}`, { method: "POST", body: JSON.stringify({ definition, inputs: inputs ?? {} }) }),
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

API — agent(prompt, {label, phase, schema, model, effort}) spawns one agent; with \`schema\` (a JSON Schema) its reply must be one \`\`\`json fence matching it, gets one repair turn, and agent() resolves with the parsed object. parallel(thunks) awaits all and is a BARRIER — a thunk that throws becomes null, so \`.filter(Boolean)\`. pipeline(items, ...stages) runs each item through every stage independently with NO barrier between them; each stage gets (previous, item, index). Prefer pipeline: a barrier makes every fast item wait for the slowest. phase(title) names the stage the following agents belong to. log(message) narrates to the reader. \`args\` is what you passed in. \`budget\` is {total, spent(), remaining()}.

Limits: ${SCRIPT_LIMITS.maxAgents} agents per run, ${SCRIPT_LIMITS.maxItems} items per parallel/pipeline call, ${LIMITS.maxParallel} agents running at once (the rest queue). Date.now(), new Date() and Math.random() all throw — a run that reads a clock cannot be replayed; pass a timestamp through \`args\` and vary prompts by index. There is no filesystem, no network and no require: the agents you spawn do that work, not the script.
Each call returns within its wait budget; if the status is still "running", call wait_workflow with the runId. Agent outputs are in \`steps[].output\`, and the script's own return value in \`result\`.`;

server.registerTool(
  "run_script",
  {
    title: "Run a workflow script",
    description: `Orchestrate many agents from a script — for work whose shape is only known as it runs: fanning out over a list a first agent discovered, looping until a search goes dry, or having agents check each other's findings. For a pipeline you can write down in full up front, run_workflow is simpler.\n${SCRIPT_RULES}`,
    inputSchema: {
      script: z.string().min(1).describe("The orchestration script: `export const meta = {…}` then the body."),
      args: z.unknown().optional().describe("Passed to the script as the `args` global. Give real JSON, not a JSON string."),
      tokenBudget: z.number().int().positive().optional().describe("Output-token ceiling for the whole run, readable as `budget`. Agents past it are refused."),
      waitSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ script, args, tokenBudget, waitSec }) => {
    try {
      return summarize(
        await call(`/scripts?wait=${clampWait(waitSec)}`, {
          method: "POST",
          body: JSON.stringify({ script, args, tokenBudget }),
        }),
      );
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "wait_workflow",
  {
    title: "Wait for a workflow",
    description: `Wait up to timeoutSec (default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}) for a running workflow and return it as it stands. Call again while status is "running".`,
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
