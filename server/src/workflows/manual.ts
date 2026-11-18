/*
 * The agent's manual for the workflow dialect, in words.
 *
 * These strings used to live in `workflows/mcp.ts`, the `workflow` MCP server.
 * That server is gone — its tools moved under the one `agents` server, whose
 * `agent` tool takes `steps`, `script` or `name` (docs/plans/agent-tool.md) — and
 * the text came with them, because it is the only manual a model gets for the
 * dialect and every option name in it is one `sandbox.ts` validates.
 *
 * Kept beside the validator rather than inline in `agents-mcp.ts`: the option
 * names below and the ones `sandbox.ts` rejects an unknown value of are the same
 * list, and they should be read side by side.
 *
 * The tool names are the NEW ones (`agent`, `agent_status`, `agent_message`,
 * `agent_control`) — one tool family, whatever shape the run is.
 */
import { LIMITS } from "./graph.js";
import { ENGINE_LIMITS, SCRIPT_LIMITS } from "./types.js";

const BACKGROUND = `The run starts in the BACKGROUND. Do not poll it: when it ends, its outcome arrives in this thread as a <task-notification> carrying the id (task-id), status (completed, failed, cancelled or budget_exceeded), the result, any failures and a usage summary, and you continue from there. Meanwhile do other work, or end your turn if there is none. waitSec only blocks the CALL that long; the run still tells you when it ends unless that wait already returned it ended.`;

const DURABLE = `Runs are DURABLE. Every step, gate and state change is journaled as it happens; if the server restarts the run is resumed, not failed. On resume the script is replayed from the top and every call identical to one that already completed answers from the journal — a completed step is never run twice and costs nothing. A step that was in flight at the restart follows its \`onRestart\` (set per step, or for the whole run): "resume" (the default) continues that step's own conversation in the same thread, "rerun" starts it again from its prompt in a fresh thread, "fail" fails the step. Resuming a conversation can repeat a tool side effect that ran but was not journaled; use "rerun" or "fail" for a step where that matters. Gates resume too: an open approval is asked again, a sleep keeps its original wake time, a waitFor waits again. Budgets and clocks continue from what was already spent.`;

const BUDGETS = `Budgets (\`budgets\`: {tokens, costUsd, agents, wallSec}) are enforced by the engine, not by the honour system: tokens = output tokens across all agents of the run, costUsd = estimated spend, agents = agents the run may start in its lifetime, wallSec = wall-clock seconds with paused time excluded. Hitting one stops NEW agents; the run ends as status budget_exceeded and keeps its partial result (the notification says which budget and the spend). Set them for open-ended fan-out. Scripts can read progress through the \`budget\` global.`;

const FLOW = `Flow control: \`priority\` (-100..100, higher runs first when the shared agent pool is contended), \`concurrencyKey\` (runs sharing a key share one concurrency pool — e.g. one writer per repo). At most ${ENGINE_LIMITS.runsPerParent} workflow runs may be live per thread — counted apart from its ${ENGINE_LIMITS.asksPerParent} one-step runs on another pair and its ${ENGINE_LIMITS.subagentsPerParent} on its own, so a fan-out of errands never takes a workflow's slot — ${ENGINE_LIMITS.liveChildren} step threads run at once across the whole server (the rest queue), and a run runs at most ${ENGINE_LIMITS.defaultConcurrency} steps at once by default (max ${ENGINE_LIMITS.maxConcurrency}). A step has no time limit unless it sets timeoutSec (max ${ENGINE_LIMITS.stepTimeoutSec.max / 3600} h), and a run has none unless it sets totalTimeoutSec or \`budgets.wallSec\` (max ${ENGINE_LIMITS.totalTimeoutSec.max / 3600} h, running time only); neither is ever applied by default.`;

const PAUSE = `A run can be paused (agent_control with action "pause"): no further step starts, steps whose runtime can hold do so at their next step boundary (a step on a runtime that cannot runs to its end), and every clock stops — step timeouts, retry backoffs, approval timeouts, the wall budget. "resume" carries on exactly where it stood. Nothing is thrown away, which is what makes it a pause and not a cancel. A restart while paused leaves the run paused.`;

/** The steps dialect: one flat list ordered by `dependsOn`, or the same list
    grouped into named phases that run one after another. */
export const STEP_RULES = `A workflow is a set of named steps. Each step runs its prompt in a NEW thread on this server — same project, profile, agent and model as this thread unless the step says otherwise — and its final reply is the step's output. Steps whose \`dependsOn\` are all complete run in parallel (up to maxParallel, default ${LIMITS.defaultParallel}); a chain of dependsOn is a pipeline. At most ${LIMITS.maxSteps} steps. Approval gates (\`approve()\` in a script) are answered by the user in the app only: no tool lets you answer one, and you must not try to.
Write it either way: \`steps\` is one flat list ordered by dependsOn; \`phases\` is that list grouped into up to ${LIMITS.maxPhases} named stages (\`[{name, steps:[…]}]\`) that run one after another — a phase begins only when every step of the phase before it has completed, and its own steps run side by side. Prefer phases when the work has stages ("research" then "implement" then "verify"): within them you only need dependsOn for ordering *inside* a phase. Give steps OR phases, never both.
Step fields: name (letter then up to 39 letters/digits/_/-), title (optional, what the step reads as in the run's card), prompt, dependsOn, and optionally:
  model, effort — override the model / reasoning effort for this step;
  profile, agent — run this step on another (profile, agent) pair, by id or name (agent_list shows them);
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

/** The script dialect: a deterministic program whose `agent()` calls become the
    run's steps. */
export const SCRIPT_RULES = `The script is JavaScript. It runs on this server and orchestrates agents; it is NOT where the work happens — every \`agent()\` call runs its prompt in a NEW thread on this server (same project, profile, agent and model as this thread unless options say otherwise) and resolves with that agent's final reply.

Begin with a pure literal \`export const meta = { name, description, phases, inputs?, whenToUse? }\` — no variables, calls or interpolation, because the run is named and its stages drawn before it runs. \`phases\` is [{title, detail?}] (up to ${SCRIPT_LIMITS.maxPhases}); \`inputs\` is a JSON Schema for \`args\` — it validates the start and builds the Run form for a person; \`whenToUse\` is shown by the library listing. Then the body, where top-level \`await\` and a top-level \`return\` both work; what you return is the run's result.

  export const meta = { name: 'audit', description: 'Audit each subsystem', phases: [{ title: 'Read' }, { title: 'Verify' }] }
  phase('Read')
  const found = await parallel(AREAS.map((a) => () => agent(\`Audit \${a}\`, { label: 'read:' + a, schema: FINDINGS })))
  phase('Verify')
  return await pipeline(found.filter(Boolean).flatMap((f) => f.findings),
    (f) => agent(\`Try to refute: \${f.title}\`, { label: 'verify:' + f.title, schema: VERDICT }))

GLOBALS: agent parallel pipeline phase log args budget workflow map vote refine route race approve sleep until waitFor sh artifact state (plus console.log = log). An UNKNOWN OPTION NAME THROWS, naming the valid ones.

agent(prompt, opts) — one agent. opts: label (names its row; default agent-N), title (what the row reads as: a short phrase like 'Audit the auth routes'; default the label made readable, else the prompt's first sentence), phase, schema, model, effort, isolation, projectId, agentType, profile, agent, system, retry, tools, timeoutSec, onRestart, resumeSession, concurrencyKey, priority.
  schema: a JSON Schema; the reply must be one \`\`\`json fence matching it, gets one repair turn, and agent() resolves with the parsed object.
  model, effort: override for this agent. profile, agent: another (profile, agent) pair by id or name — this is how a script hands work to another agent.
  system: extra system instruction. projectId: run in another project.
  isolation: 'worktree' — a git worktree of its own; EXPENSIVE, only when parallel agents edit files and would collide.
  agentType: a library slash command (name without the /) whose body leads the prompt.
  retry: {max 0-10, backoffSec 0-3600 (default 2), fallbackModel} or just a number (max) — extra attempts after a failure on the SAME thread, backoffSec*2^(n-1) between them; fallbackModel from the second attempt on.
  tools: {allow:[…], deny:[…]} — advisory, stated in the agent's prompt, not enforced by the runtime.
  timeoutSec: this agent's time limit. onRestart: 'resume' | 'rerun' | 'fail' (see DURABLE below). resumeSession: a child thread id to CONTINUE instead of spawning — this is how a stopped run is picked back up. concurrencyKey: agents with the same key never run at once, across runs. priority: higher goes first when the pool is contended.
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
waitFor(name, {timeoutSec}) waits for an external event delivered by agent_control with action "signal" (or a webhook/route) and resolves with its value, or null on timeout. A signal that arrives before anyone waits is buffered for the next waitFor of that name. name matches /^[\\w.-]{1,80}$/.
sh(cmd, {cwd, timeoutSec}) runs a shell command in the project's directory with NO model and no tokens: resolves {exitCode, stdout, stderr} (output capped at 64 KB each; timeoutSec default 120). Refused when the thread is in a read-only/plan permission mode or its autonomy policy denies commands. Every command is journaled.
artifact(name, data) writes a file under the run's directory (a string as is, anything else as JSON) and links it from the run card; name matches /^[\\w.-]{1,80}$/.
state.get(path) / state.set(path, value) is a small JSON store persisted in the journal and shown on the run card; path matches /^[\\w.-]{1,200}$/; pass null to clear (undefined is refused). It replays like everything else, so read-modify-write is safe.
phase(title) names the stage the following agents belong to; inside pipeline/parallel prefer agent's own {phase} so stages do not race the global one. log(message) narrates to the reader.
args is what you passed in. budget is {total, spent(), remaining()} for output tokens (total is null when there is no target, remaining() is then a huge number), with budget.tokens, budget.costUsd and budget.agents each {total, spent(), remaining()}.

DETERMINISM: the script is REPLAYED from the top on every resume, so it must do the same thing every time given the same args and the same answers. Date.now(), new Date() (no argument), Date() and Math.random() all THROW; pass a timestamp through \`args\` and vary prompts by index, not by chance. Do not branch on anything but args, agent results, signal values, state and sh output. Calls are identified by a hash of their prompt and options plus how many identical calls came before, so an edited prompt is a NEW call (re-run) and an unchanged one is served from the journal. There is no filesystem, no network, no require, no timers: agents and sh do that work, not the script.

Limits: ${SCRIPT_LIMITS.maxAgents} agents per run, ${SCRIPT_LIMITS.maxItems} items per parallel/pipeline/map call, source up to ${SCRIPT_LIMITS.sourceBytes / 1024} KB, ${ENGINE_LIMITS.defaultConcurrency} agents of the run at once by default.

Agent outputs are in \`steps[].output\`, and the script's own return value in \`result\`. A step in the view may be awaiting_approval, sleeping, waiting_signal or retrying; \`gates\` lists open approvals (key, text, options), timers and signal waits.
${BUDGETS}
${FLOW}
${DURABLE}
${PAUSE}
${BACKGROUND}`;

/** The line both dialects end with: which shape to reach for. */
export const WHICH_SHAPE = `WHICH SHAPE: write \`steps\` when the whole plan can be written down before starting — the graph is checked before anything spawns (cycles, duplicate names, unknown reads and the step limit are refused up front, naming the offending step), so a mistake costs nothing. Write \`script\` when the shape depends on what an earlier step finds: fanning out over a list it discovered, looping until a search goes dry, having agents check each other. A script fails mid-run, after the children it already ran have spent their tokens. A list an earlier step produces does not by itself need a script: give that step \`output: {schema}\` returning the array and fan out over it with \`forEach\`.

SPLITTING THE WORK — the run is only as fast as its longest chain, so:
- Split by independent AREA (a directory, a subsystem, a file set, a question), not by role. Two steps that read the same files to do halves of one job are one step; five steps that each own a disjoint part run five times faster than one.
- Keep the graph WIDE and SHALLOW: no dependsOn that is not a real data need, and no phase barrier where one dependency would do (see STEPS). Prefer pipeline() to parallel()-then-parallel() in a script for the same reason.
- Size maxParallel to the widest layer of the graph (default ${ENGINE_LIMITS.defaultConcurrency}, max ${ENGINE_LIMITS.maxConcurrency}); a fan-out of eight areas at the default runs in two waves. Set \`budgets\` (agents, tokens or costUsd) on any open-ended fan-out.
- Every step sees ONLY its own prompt: give it the goal, the exact files or area it owns, what it must NOT touch, and the shape of its answer. A step whose output another step reads declares \`output: {schema}\` (\`schema\` in a script) so the reader gets fields, not prose.
- Parallel steps that EDIT files must not overlap: give each a disjoint file set, or \`isolation: "worktree"\` when they cannot be kept apart. Read-only steps (research, audit, review) never need isolation.
- End with one step that depends on the parallel ones to merge, check or verify their outputs, rather than trusting each branch's own report. Put a model-free check (build, tests) in \`sh()\` in a script — it costs no tokens.
- Give cheap, mechanical branches (search, summarise, list) a faster \`model\` of their own and keep the strong one for the synthesis.`;
