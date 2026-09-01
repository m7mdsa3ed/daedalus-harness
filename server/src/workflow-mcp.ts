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
Each call returns within its wait budget. If the returned status is "running", call wait_workflow with the runId until it is completed, failed or cancelled. Step outputs are in \`steps[].output\`.`;

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

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => process.stderr.write("workflow MCP server running\n"))
  .catch((err) => {
    process.stderr.write(`workflow MCP server failed: ${String(err)}\n`);
    process.exit(1);
  });
