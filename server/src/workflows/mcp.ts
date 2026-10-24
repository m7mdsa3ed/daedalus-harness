/*
 * The `workflow` MCP server (stdio), v2.
 *
 * Spawned by the agent — claude-code, codex or opencode — as a regular stdio
 * MCP server the harness declared on `session/new`. It is a thin client: the
 * engine (workflows/engine.ts) lives in the server process, and the only thing
 * this process is handed is `WORKFLOW_URL`, the loopback address that names the
 * calling thread (`/wf/<key>/<sessionId>`, routed by workflows/routes.ts).
 * Nothing here knows about the database, the journal or the session manager,
 * which is also why it may import `graph.ts` (zod only) and `types.ts` (types
 * and constants) and nothing heavier.
 *
 * Every tool answers within its own wait budget and never longer: an agent
 * runtime's MCP tool timeout is its own (codex defaults to 60s; Claude Code's
 * is a hard wall clock) and a pipeline is longer than any of them — so
 * `run_workflow` / `run_script` start the run in the background and return it
 * as it stands, `wait_workflow` picks it up again, and the finished run tells
 * the thread itself as a <task-notification>.
 *
 * The tool descriptions below are the agent's whole manual for the dialect;
 * the option names in them are the ones `sandbox.ts` validates (it rejects an
 * unknown option by name), so change the two together.
 *
 * Written to be invoked directly as the MCP server executable:
 *   node dist/workflows/mcp.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BudgetsSchema, LIMITS, WorkflowDefinitionShape } from "./graph.js";
import { ENGINE_LIMITS, SCRIPT_LIMITS, WORKFLOW_SERVER_NAME } from "./types.js";

const url = process.env.WORKFLOW_URL;
if (!url) {
  process.stderr.write("workflow MCP server: WORKFLOW_URL is not set\n");
  process.exit(1);
}

const DEFAULT_WAIT_SEC = 45;
const MAX_WAIT_SEC = 55;

const server = new McpServer(
  { name: WORKFLOW_SERVER_NAME, version: "2.0.0" },
  {
    instructions:
      "Run multi-step workflows where every step is a real thread on this server, in this thread's project. run_workflow takes a declarative definition — steps (or named phases of steps) with dependsOn ordering and a prompt each; run_script takes an orchestration script for work whose shape is only known as it runs. Runs are durable (they survive a server restart), start in the background and report back as a <task-notification>, so do not poll; list_workflows shows saved ones runnable by name, list_runs shows this thread's recent runs, and pause/resume/cancel/signal act on a runId. approve() gates are answered by the user in the app only.",
  },
);

const BACKGROUND = `The run starts in the BACKGROUND and the call returns at once with its runId. Do not poll and do not call wait_workflow to wait it out: when the run ends, its outcome arrives in this thread as a <task-notification> message carrying the runId (task-id), status (completed, failed, cancelled or budget_exceeded), the result, any failures and a usage summary, and you continue from there. Meanwhile do other work, or end your turn if there is none. Passing waitSec only blocks the call that long (max ${MAX_WAIT_SEC}); the run still tells you when it ends unless that wait already returned it ended.`;

const DURABLE = `Runs are DURABLE. Every step, gate and state change is journaled as it happens; if the server restarts the run is resumed, not failed. On resume the script is replayed from the top and every call identical to one that already completed answers from the journal — a completed step is never run twice and costs nothing. A step that was in flight at the restart follows its \`onRestart\` (set per step, or for the whole run): "resume" (the default) continues that step's own conversation in the same thread, "rerun" starts it again from its prompt in a fresh thread, "fail" fails the step. Resuming a conversation can repeat a tool side effect that ran but was not journaled; use "rerun" or "fail" for a step where that matters. Gates resume too: an open approval is asked again, a sleep keeps its original wake time, a waitFor waits again. Budgets and clocks continue from what was already spent.`;

const BUDGETS = `Budgets (\`budgets\`: {tokens, costUsd, agents, wallSec}) are enforced by the engine, not by the honour system: tokens = output tokens across all agents of the run, costUsd = estimated spend, agents = agents the run may start in its lifetime, wallSec = wall-clock seconds with paused time excluded. Hitting one stops NEW agents; the run ends as status budget_exceeded and keeps its partial result (the notification says which budget and the spend). Set them for open-ended fan-out. Scripts can read progress through the \`budget\` global.`;

const FLOW = `Flow control: \`priority\` (-100..100, higher runs first when the shared agent pool is contended), \`concurrencyKey\` (runs sharing a key share one concurrency pool — e.g. one writer per repo). At most ${ENGINE_LIMITS.runsPerParent} runs may be live per thread, ${ENGINE_LIMITS.liveChildren} step threads run at once across the whole server (the rest queue), and a run runs at most ${ENGINE_LIMITS.defaultConcurrency} steps at once by default (max ${ENGINE_LIMITS.maxConcurrency}). A step times out after ${ENGINE_LIMITS.stepTimeoutSec.default / 60} minutes unless it sets timeoutSec (max ${ENGINE_LIMITS.stepTimeoutSec.max / 3600} h); a whole run fails after ${ENGINE_LIMITS.totalTimeoutSec.default / 3600} h of running time (paused time excluded; max ${ENGINE_LIMITS.totalTimeoutSec.max / 3600} h).`;

const PAUSE = `A run can be paused (pause_workflow): no further step starts, steps whose runtime can hold do so at their next step boundary (a step on a runtime that cannot runs to its end), and every clock stops — step timeouts, retry backoffs, approval timeouts, the wall budget. resume_workflow carries on exactly where it stood. Nothing is thrown away, which is what makes it a pause and not a cancel. A restart while paused leaves the run paused.`;

const RULES = `A workflow is a set of named steps. Each step runs its prompt in a NEW thread on this server — same project, profile, agent and model as this thread unless the step says otherwise — and its final reply is the step's output. Steps whose \`dependsOn\` are all complete run in parallel (up to maxParallel, default ${LIMITS.defaultParallel}); a chain of dependsOn is a pipeline. At most ${LIMITS.maxSteps} steps. Approval gates (\`approve()\` in a script) are answered by the user in the app only: no tool lets you answer one, and you must not try to.
Write it either way: \`steps\` is one flat list ordered by dependsOn; \`phases\` is that list grouped into up to ${LIMITS.maxPhases} named stages (\`[{name, steps:[…]}]\`) that run one after another — a phase begins only when every step of the phase before it has completed, and its own steps run side by side. Prefer phases when the work has stages ("research" then "implement" then "verify"): within them you only need dependsOn for ordering *inside* a phase. Give steps OR phases, never both.
Step fields: name (letter then up to 39 letters/digits/_/-), title (optional, what the step reads as in the run's card), prompt, dependsOn, and optionally:
  model, effort — override the model / reasoning effort for this step;
  profile, agent — run this step on another (profile, agent) pair, by id or name (list_agents on the agents server shows them);
  agentType — a library slash command (name without the /) whose body leads the prompt;
  isolation: "worktree" — a git worktree of its own; EXPENSIVE, use only when parallel steps edit files and would collide;
  retry: {max 0-5, backoffSec, fallbackModel} — extra attempts after a failure on the SAME thread, with backoffSec*2^(n-1) seconds between them (default 2); fallbackModel is used from the second attempt on;
  tools: {allow:[…], deny:[…]} — tool names the step may / may not use. This is advisory: it is stated to the step in its prompt, not enforced by the runtime;
  timeoutSec — this step's own time limit; onRestart: "resume" | "rerun" | "fail" — what to do with this step if the server restarts while it runs;
  output: "text" (default) or {schema} — a JSON Schema; the reply must contain exactly one \`\`\`json fence matching it, gets one repair turn, then the step fails;
  when: {ref, equals | notEquals | truthy} — run only if the referenced value (\`steps.NAME.output.path\` or \`inputs.KEY\`) holds; otherwise the step is skipped with a null output and its dependents still run;
  forEach: {ref, as, concurrency} — ref names an array; the step runs once per element (concurrency items at once) and its output is the array of per-item outputs, null where an item failed (the step fails only if every item does).
Definition fields: name, description, steps | phases, maxParallel (1-${LIMITS.maxParallel}, default ${LIMITS.defaultParallel}), totalTimeoutSec, budgets, priority, concurrencyKey, onRestart (the default for every step), inputs (JSON Schema for the run's inputs).
Templates: a prompt may contain {{inputs.NAME}} and {{steps.STEP.output}} (STEP must be in that step's dependsOn, or — with phases — in any earlier phase). When a step declares \`output: {schema}\`, {{steps.STEP.output.path.to.field}} reads into it (arrays by index). Inside a forEach step {{item}} (or {{<as>}}) is the element, {{item.field}} reads into it, and {{index}} is its position. A reference to something that does not exist fails the step before its prompt is sent. A \`when\`/\`forEach\` ref is written the same way without braces.
Steps run with your permission mode and cannot start workflows themselves. A step takes a few seconds to start. A step that fails skips everything depending on it; siblings already running finish.
${BUDGETS}
${FLOW}
${DURABLE}
${PAUSE}
${BACKGROUND}`;

const SCRIPT_RULES = `The script is JavaScript. It runs on this server and orchestrates agents; it is NOT where the work happens — every \`agent()\` call runs its prompt in a NEW thread on this server (same project, profile, agent and model as this thread unless options say otherwise) and resolves with that agent's final reply.

Begin with a pure literal \`export const meta = { name, description, phases, inputs?, whenToUse? }\` — no variables, calls or interpolation, because the run is named and its stages drawn before it runs. \`phases\` is [{title, detail?}] (up to ${SCRIPT_LIMITS.maxPhases}); \`inputs\` is a JSON Schema for \`args\` — it validates the start and builds the Run form for a person; \`whenToUse\` is shown by list_workflows. Then the body, where top-level \`await\` and a top-level \`return\` both work; what you return is the run's result.

  export const meta = { name: 'audit', description: 'Audit each subsystem', phases: [{ title: 'Read' }, { title: 'Verify' }] }
  phase('Read')
  const found = await parallel(AREAS.map((a) => () => agent(\`Audit \${a}\`, { label: 'read:' + a, schema: FINDINGS })))
  phase('Verify')
  return await pipeline(found.filter(Boolean).flatMap((f) => f.findings),
    (f) => agent(\`Try to refute: \${f.title}\`, { label: 'verify:' + f.title, schema: VERDICT }))

GLOBALS: agent parallel pipeline phase log args budget workflow map vote refine route race approve sleep until waitFor sh artifact state (plus console.log = log). An UNKNOWN OPTION NAME THROWS, naming the valid ones.

agent(prompt, opts) — one agent. opts: label (names its row; default agent-N), title (what the row reads as: a short phrase like 'Audit the auth routes'; default the label made readable, else the prompt's first sentence), phase, schema, model, effort, isolation, projectId, agentType, profile, agent, system, retry, tools, timeoutSec, onRestart, resumeSession, concurrencyKey, priority.
  schema: a JSON Schema; the reply must be one \`\`\`json fence matching it, gets one repair turn, and agent() resolves with the parsed object.
  model, effort: override for this agent. profile, agent: another (profile, agent) pair by id or name — this replaces ask_agent inside a script. system: extra system instruction. projectId: run in another project.
  isolation: 'worktree' — a git worktree of its own; EXPENSIVE, only when parallel agents edit files and would collide.
  agentType: a library slash command (name without the /) whose body leads the prompt.
  retry: {max 0-10, backoffSec 0-3600 (default 2), fallbackModel} or just a number (max) — extra attempts after a failure on the SAME thread, backoffSec*2^(n-1) between them; fallbackModel from the second attempt on.
  tools: {allow:[…], deny:[…]} — advisory, stated in the agent's prompt, not enforced by the runtime.
  timeoutSec: this agent's time limit. onRestart: 'resume' | 'rerun' | 'fail' (see DURABLE below). resumeSession: a child thread id to CONTINUE instead of spawning (this replaces continue_agent). concurrencyKey: agents with the same key never run at once, across runs. priority: higher goes first when the pool is contended.
workflow(nameOrRef, args) runs a saved workflow (by meta.name) or {scriptPath} inline and returns its result; it shares this run's agent cap, cancel and budget, and nests one level only.
parallel(thunks) awaits all and is a BARRIER — a thunk that throws becomes null, so \`.filter(Boolean)\`.
pipeline(items, ...stages) runs each item through every stage independently with NO barrier between stages; each stage gets (previous, item, index); a stage that throws drops that item to null. Prefer pipeline over parallel-then-parallel: a barrier makes every fast item wait for the slowest.
map(items, fn, {concurrency}) bounded fan-out (default 5 at once); fn(item, index, items); results in input order, null where one failed.
vote(n, make, {judge, judgePrompt}) runs make(i) n times in parallel; the winner is judge(candidates) (a function) if given, else a built-in judge agent if judgePrompt (a string) is given, else the majority by equal JSON. Returns {winner, winnerIndex, candidates, votes}.
refine(make, check, {maxRounds}) evaluator-optimizer: make(round, feedback) then check(candidate, round) -> {ok, feedback?} (or a boolean); stops at the first ok or after maxRounds (default ${SCRIPT_LIMITS.defaultRounds}, max 50). Returns {value, rounds, ok}; rounds are 0-based.
route(classify, branches) classifies once (classify is a function or a label; it answers a string or {label}) and runs branches[label](label); a 'default' branch catches the rest, no match throws.
race(thunks) starts every thunk; the first to succeed wins and the rest are abandoned.
approve(text, {options, timeoutSec}) parks a question in the user's inbox and on this thread and waits; resolves with the chosen option, or null when timeoutSec passes. options default to ['approve','reject'] (1-10 distinct strings, each up to 80 chars). Use it before anything irreversible. It is a human gate: the user answers it in the app (their inbox / the run card) and nowhere else — there is no tool for you to answer it, and you must not try to work around that.
sleep(seconds) and until(isoTimestamp) are durable timers: the run holds no agent while it waits and the timer survives a restart (max 30 days).
waitFor(name, {timeoutSec}) waits for an external event delivered by signal_workflow(runId, name, value) (or a webhook/route) and resolves with its value, or null on timeout. A signal that arrives before anyone waits is buffered for the next waitFor of that name. name matches /^[\\w.-]{1,80}$/.
sh(cmd, {cwd, timeoutSec}) runs a shell command in the project's directory with NO model and no tokens: resolves {exitCode, stdout, stderr} (output capped at 64 KB each; timeoutSec default 120). Refused when the thread is in a read-only/plan permission mode or its autonomy policy denies commands. Every command is journaled.
artifact(name, data) writes a file under the run's directory (a string as is, anything else as JSON) and links it from the run card; name matches /^[\\w.-]{1,80}$/.
state.get(path) / state.set(path, value) is a small JSON store persisted in the journal and shown on the run card; path matches /^[\\w.-]{1,200}$/; pass null to clear (undefined is refused). It replays like everything else, so read-modify-write is safe.
phase(title) names the stage the following agents belong to; inside pipeline/parallel prefer agent's own {phase} so stages do not race the global one. log(message) narrates to the reader.
args is what you passed in. budget is {total, spent(), remaining()} for output tokens (total is null when there is no target, remaining() is then a huge number), with budget.tokens, budget.costUsd and budget.agents each {total, spent(), remaining()}.

DETERMINISM: the script is REPLAYED from the top on every resume, so it must do the same thing every time given the same args and the same answers. Date.now(), new Date() (no argument), Date() and Math.random() all THROW; pass a timestamp through \`args\` and vary prompts by index, not by chance. Do not branch on anything but args, agent results, signal values, state and sh output. Calls are identified by a hash of their prompt and options plus how many identical calls came before, so an edited prompt is a NEW call (re-run) and an unchanged one is served from the journal. There is no filesystem, no network, no require, no timers: agents and sh do that work, not the script.

Limits: ${SCRIPT_LIMITS.maxAgents} agents per run, ${SCRIPT_LIMITS.maxItems} items per parallel/pipeline/map call, source up to ${SCRIPT_LIMITS.sourceBytes / 1024} KB, ${ENGINE_LIMITS.defaultConcurrency} agents of the run at once by default.
To run a SAVED workflow pass \`name\` instead of \`script\` (list_workflows shows them; save_workflow keeps a run's script or one you give). To RELAUNCH a stopped, failed or edited run pass \`resumeFromRunId\` — with no \`script\`/\`args\` the earlier ones are reused — and every agent() call identical to one that completed returns its saved result without spawning; only new, changed or failed calls run.
Agent outputs are in \`steps[].output\`, and the script's own return value in \`result\`. A step in the view may be awaiting_approval, sleeping, waiting_signal or retrying; \`gates\` lists open approvals (key, text, options), timers and signal waits.
${BUDGETS}
${FLOW}
${DURABLE}
${PAUSE}
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

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const runId = z.string().min(1).describe("The run's id (the task-id of its <task-notification>).");
const waitSecField = z.number().int().min(1).max(MAX_WAIT_SEC).optional();
const budgetsField = BudgetsSchema.optional().describe("Run limits: tokens (output), costUsd, agents, wallSec. Hitting one stops new agents and ends the run as budget_exceeded with its partial result.");
const priorityField = z.number().int().min(-100).max(100).optional().describe("Higher runs first when the shared agent pool is contended. Default 0.");
const keyField = z.string().min(1).max(80).optional().describe("Runs sharing a key share one concurrency pool.");
const restartField = z
  .enum(["resume", "rerun", "fail"])
  .optional()
  .describe("What to do with a step in flight when the server restarts: resume its conversation (default), rerun it from its prompt, or fail it.");

server.registerTool(
  "run_workflow",
  {
    title: "Run a workflow",
    description: `Start a multi-step, multi-thread workflow in the background.\n${RULES}`,
    inputSchema: {
      definition: z.object(WorkflowDefinitionShape).describe("The workflow: its steps (or phases of steps), their dependencies and prompts."),
      inputs: z.record(z.string(), z.unknown()).optional().describe("Values for {{inputs.NAME}} references."),
      budgets: budgetsField,
      priority: priorityField,
      concurrencyKey: keyField,
      onRestart: restartField,
      waitSec: waitSecField,
    },
    annotations: WRITE,
  },
  async ({ definition, inputs, budgets, priority, concurrencyKey, onRestart, waitSec }) => {
    try {
      return summarize(
        await call(`/runs?wait=${startWait(waitSec)}`, {
          method: "POST",
          body: JSON.stringify({ definition, inputs: inputs ?? {}, budgets, priority, concurrencyKey, onRestart }),
        }),
      );
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "run_script",
  {
    title: "Run a workflow script",
    description: `Orchestrate many agents from a script — for work whose shape is only known as it runs: fanning out over a list a first agent discovered, looping until a search goes dry, having agents check each other's findings, waiting for a person's approval or an external signal. For a pipeline you can write down in full up front, run_workflow is simpler.\n${SCRIPT_RULES}`,
    inputSchema: {
      script: z.string().min(1).optional().describe("The orchestration script: `export const meta = {…}` then the body."),
      name: z.string().min(1).optional().describe("Run a saved workflow by its meta.name instead of passing a script."),
      resumeFromRunId: z.string().min(1).optional().describe("Relaunch an earlier script run, reusing every completed agent whose call is unchanged."),
      args: z.unknown().optional().describe("Passed to the script as the `args` global. Give real JSON, not a JSON string."),
      budgets: budgetsField,
      tokenBudget: z.number().int().positive().optional().describe("Alias for budgets.tokens: the output-token ceiling for the whole run, readable as `budget`. Agents past it are refused."),
      priority: priorityField,
      concurrencyKey: keyField,
      onRestart: restartField,
      waitSec: waitSecField,
    },
    annotations: WRITE,
  },
  async ({ script, name, resumeFromRunId, args, budgets, tokenBudget, priority, concurrencyKey, onRestart, waitSec }) => {
    try {
      // `tokenBudget` is the v1 spelling of budgets.tokens; the explicit field wins.
      const merged = tokenBudget !== undefined || budgets ? { ...(tokenBudget !== undefined ? { tokens: tokenBudget } : {}), ...budgets } : undefined;
      return summarize(
        await call(`/scripts?wait=${startWait(waitSec)}`, {
          method: "POST",
          body: JSON.stringify({ script, name, resumeFromRunId, args, budgets: merged, priority, concurrencyKey, onRestart }),
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
      "Saved workflow scripts this thread can run by name with run_script({name}): the project's and the personal library (the project one wins a name clash), mirrored to .claude/workflows/ so Claude Code sees the same files. Each has a name, description, scope, version, the JSON Schema of its inputs (what `args` it takes) and, when its author gave one, whenToUse.",
    inputSchema: {},
    annotations: READ,
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
      "Save a script as a reusable workflow named by its meta.name — into the project library (mirrored to the project's .claude/workflows/, shared with everyone who clones the repo) or the personal one (~/.claude/workflows/). Give runId to keep the script of a run of this thread, or script to save source directly. Overwrites a saved workflow of the same name. Save only when the user asks to keep it.",
    inputSchema: {
      runId: z.string().min(1).optional().describe("A run of this thread whose script to save."),
      script: z.string().min(1).optional().describe("Script source to save directly (`export const meta = {…}` then the body)."),
      scope: z.enum(["project", "personal"]).optional(),
    },
    annotations: IDEMPOTENT,
  },
  async ({ runId, script, scope }) => {
    try {
      if ((runId === undefined) === (script === undefined)) throw new Error("give either runId or script, not both and not neither");
      return summarize(await call("/saved", { method: "POST", body: JSON.stringify({ runId, script, scope }) }));
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
      "Delete a saved workflow by name (and its mirrored .claude/workflows/ file). Pass scope when the same name exists in both libraries; otherwise the one run_script({name}) would pick is deleted. Delete only when the user asks.",
    inputSchema: { name: z.string().min(1), scope: z.enum(["project", "personal"]).optional() },
    annotations: DESTRUCTIVE,
  },
  async ({ name, scope }) => {
    try {
      const query = scope ? `?scope=${scope}` : "";
      return summarize(await call(`/saved/${encodeURIComponent(name)}${query}`, { method: "DELETE" }));
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
    inputSchema: { runId, timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional() },
    annotations: READ,
  },
  async ({ runId: id, timeoutSec }) => {
    try {
      return summarize(await call(`/runs/${encodeURIComponent(id)}?wait=${clampWait(timeoutSec)}`));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "workflow_status",
  {
    title: "Workflow status",
    description:
      "The current state of a workflow run, without waiting: status, steps (with outputs and errors), open gates (approvals, timers, signal waits), state, artifacts, logs, usage against budgets, and the result once it has one.",
    inputSchema: { runId },
    annotations: READ,
  },
  async ({ runId: id }) => {
    try {
      return summarize(await call(`/runs/${encodeURIComponent(id)}`));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "list_runs",
  {
    title: "List recent runs",
    description:
      "This thread's recent workflow runs, newest first, without their steps: id, name, status, error, times and what started each. Use it to find a runId you lost (after a compaction, say) or to see what is still going; workflow_status reads one in full.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("How many to list (default 20).") },
    annotations: READ,
  },
  async ({ limit }) => {
    try {
      return summarize(await call(`/runs?limit=${limit ?? 20}`));
    } catch (error) {
      return failed(error);
    }
  },
);

server.registerTool(
  "cancel_workflow",
  {
    title: "Cancel a workflow",
    description: "Stop a running workflow: running steps are interrupted, pending ones never start. The run ends as cancelled and keeps what it had.",
    inputSchema: { runId },
    annotations: DESTRUCTIVE,
  },
  async ({ runId: id }) => {
    try {
      return summarize(await call(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }));
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
      inputSchema: { runId },
      annotations: IDEMPOTENT,
    },
    async ({ runId: id }) => {
      try {
        return summarize(await call(`/runs/${encodeURIComponent(id)}/${verb}`, { method: "POST", body: "{}" }));
      } catch (error) {
        return failed(error);
      }
    },
  );
}

server.registerTool(
  "signal_workflow",
  {
    title: "Signal a workflow",
    description:
      "Deliver an external event to a run: it resolves the oldest open `waitFor(name)` of that run with `value` (any JSON), or — when nobody is waiting yet — is kept for the next `waitFor(name)`. Use it to release a script that waits for something outside it (another thread finishing, the user saying go). Fails if the run is over.",
    inputSchema: {
      runId,
      name: z.string().regex(/^[\w.-]{1,80}$/).describe("The signal name the script passes to waitFor."),
      value: z.unknown().optional().describe("Any JSON; what waitFor resolves with. Default null."),
    },
    annotations: WRITE,
  },
  async ({ runId: id, name, value }) => {
    try {
      return summarize(await call(`/runs/${encodeURIComponent(id)}/signal`, { method: "POST", body: JSON.stringify({ name, value: value ?? null }) }));
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
