// Self-check for how a native (Claude Code) dynamic workflow becomes rows:
// `nativeWorkflowRun` / `placeNativeWorkflows` in client/src/lib/transcript-rows.ts.
//
// It lives here because the client has no test runner of its own (`pnpm test`
// there is `tsc -b`) and this is the riskiest pure function in the feature —
// the one that turns a progress array the runtime restates on every beat into
// the phases, steps, states and costs a reader sees. It touches no DOM and no
// React, so a node runner is enough. Imported through a computed URL so the
// server's `tsc --noEmit` does not try to resolve the client's path aliases.
//
// The fixture is a real run, captured from the journal of a live workflow
// (two parallel `sleep` agents under a `Wait` phase, then one `sum` agent
// under `Sum`) rather than invented, so the field spellings are the runtime's.
// Run: pnpm test:native-workflow-rows
import assert from "node:assert/strict";

const { buildRows } = (await import(
  new URL("../../client/src/lib/transcript-rows.ts", import.meta.url).href
)) as { buildRows: (items: unknown[], groupTools: boolean, turnActive?: boolean) => any[] };
const { workflowAgentItems } = (await import(
  new URL("../../client/src/lib/tools.ts", import.meta.url).href
)) as { workflowAgentItems: (events: unknown[]) => any[] };

const launch = (id: string, taskId?: string) => ({
  kind: "tool", id, title: "Workflow", status: "completed",
  content: [], locations: [], startedAt: 1, at: 1,
  // What the Workflow tool actually answers with, which is where the run's own
  // id reaches the transcript (`extractBackgroundTask`).
  ...(taskId
    ? { meta: { claudeCode: { toolResponse: { status: "async_launched", taskId, transcriptDir: "/tmp/wf", runId: "wf_x" } } } }
    : {}),
});

const task = (over: Record<string, unknown> = {}) => ({
  kind: "async-task",
  id: "async-task:wo1zb0d22",
  taskId: "wo1zb0d22",
  name: "Two parallel sleep agents then a summary agent",
  taskType: "workflow",
  description: "Two parallel sleep agents then a summary agent",
  state: "completed",
  toolCallId: "toolu_launch",
  progress: [],
  usage: { totalTokens: 116300, toolUses: 10, durationMs: 26771 },
  startedAt: 1,
  at: 1,
  ...over,
});

const FINISHED = [
  { type: "workflow_phase", index: 1, title: "Wait" },
  { type: "workflow_phase", index: 2, title: "Sum" },
  { type: "workflow_agent", index: 1, label: "wait-1", phaseIndex: 1, phaseTitle: "Wait", agentId: "a1", state: "done", tokens: 40996, toolCalls: 5, lastToolName: "Bash", lastToolSummary: "echo waiting", resultPreview: "done", promptPreview: "Run sleep 25" },
  { type: "workflow_agent", index: 2, label: "wait-2", phaseIndex: 1, phaseTitle: "Wait", agentId: "a2", state: "done", tokens: 40629, toolCalls: 5, lastToolName: "Bash", resultPreview: "done" },
  { type: "workflow_agent", index: 3, label: "sum", phaseIndex: 2, phaseTitle: "Sum", agentId: "a3", state: "done", tokens: 34675, toolCalls: 0, resultPreview: "ok" },
];

const runOf = (rows: any[]) => rows.find((r) => r.kind === "workflow-group");
const stepsOf = (run: any) =>
  run.steps.map((s: any) => ({
    phase: s.head.workflow.phase?.name ?? null,
    step: s.head.workflow.step,
    state: s.head.state,
    active: s.active,
    tokens: s.head.usage?.totalTokens ?? 0,
  }));

// ---- a finished run: phases, steps, costs, and where the row sits ----
{
  const rows = buildRows([launch("toolu_launch"), task({ progress: FINISHED })], false, false);
  const run = runOf(rows);
  assert.ok(run, "a run with agents draws a workflow row");
  assert.deepEqual(
    run.plan,
    [{ name: "Wait", steps: ["wait-1", "wait-2"] }, { name: "Sum", steps: ["sum"] }],
    "the outline is the script's phases, each holding its own agents",
  );
  assert.deepEqual(stepsOf(run), [
    { phase: "Wait", step: "wait-1", state: "completed", active: false, tokens: 40996 },
    { phase: "Wait", step: "wait-2", state: "completed", active: false, tokens: 40629 },
    { phase: "Sum", step: "sum", state: "completed", active: false, tokens: 34675 },
  ]);
  // The run stands in place of the call that launched it, and that call is not
  // also drawn — one row per thing that happened.
  assert.equal(rows.length, 1, "the launch row is replaced, not accompanied");
  assert.ok(!rows.some((r) => r.kind === "tool"), "the launch tool row is gone");
  const first = run.steps[0].head;
  assert.equal(first.prompt, "Run sleep 25", "the brief the runtime previewed");
  assert.equal(first.report, "done", "and what it answered");
  assert.equal(first.activity, "echo waiting", "the tool it was on, for the run's live caption");
  assert.equal(first.workflow.total, 3, "the denominator is every agent, not just this phase");
}

// ---- mid-flight: only the runtime's own state decides liveness ----
{
  const live = [
    { type: "workflow_phase", index: 1, title: "Wait" },
    { type: "workflow_agent", index: 1, label: "wait-1", phaseIndex: 1, phaseTitle: "Wait", state: "done", tokens: 10 },
    { type: "workflow_agent", index: 2, label: "wait-2", phaseIndex: 1, phaseTitle: "Wait", state: "progress", tokens: 5 },
    { type: "workflow_agent", index: 3, label: "wait-3", phaseIndex: 1, phaseTitle: "Wait", state: "start" },
  ];
  // turnActive is false on purpose: a dynamic workflow outlives the turn that
  // launched it, so reading liveness off the turn would call a working run dead.
  const run = runOf(buildRows([launch("toolu_launch"), task({ state: "running", progress: live })], false, false));
  assert.deepEqual(
    run.steps.map((s: any) => [s.head.state, s.active]),
    [["completed", false], ["running", true], ["running", true]],
    "start and progress are live; done is not — with no turn open",
  );
  // A run the user killed leaves nothing shimmering, whatever its agents said.
  const killed = runOf(buildRows([launch("toolu_launch"), task({ state: "stopped", progress: live })], false, false));
  assert.deepEqual(killed.steps.map((s: any) => s.active), [false, false, false], "a settled run has no live steps");
}

// ---- failure and refusal are distinct endings ----
{
  const ended = [
    { type: "workflow_agent", index: 1, label: "a", state: "error", error: "boom" },
    { type: "workflow_agent", index: 2, label: "b", state: "blocked" },
  ];
  const run = runOf(buildRows([launch("toolu_launch"), task({ progress: ended })], false, false));
  assert.deepEqual(run.steps.map((s: any) => s.head.state), ["failed", "cancelled"]);
  assert.equal(run.steps[0].head.report, "boom", "a failed step reports why");
  assert.deepEqual(run.plan, [{ name: null, steps: ["a", "b"] }], "no phases is one unnamed phase, which draws no heading");
}

// ---- two agents a script labelled the same must stay two rows ----
{
  const dupes = [
    { type: "workflow_phase", index: 1, title: "Map" },
    { type: "workflow_agent", index: 1, label: "read", phaseIndex: 1, phaseTitle: "Map", state: "done" },
    { type: "workflow_agent", index: 2, label: "read", phaseIndex: 1, phaseTitle: "Map", state: "progress" },
    { type: "workflow_agent", index: 3, label: "solo", phaseIndex: 1, phaseTitle: "Map", state: "done" },
  ];
  const run = runOf(buildRows([launch("toolu_launch"), task({ state: "running", progress: dupes })], false, false));
  const names = run.steps.map((s: any) => s.head.workflow.step);
  assert.equal(new Set(names).size, 3, "every step is named uniquely or the outline collapses two into one");
  assert.deepEqual(names, ["read (1)", "read (2)", "solo"], "only the repeated name is disambiguated");
  assert.deepEqual(run.plan[0].steps, names, "and the outline names them the same way");
}

// ---- no agents: the old behaviour, untouched ----
{
  // An unpatched claude-agent-acp carries no `workflowProgress`, so there is
  // nothing to draw — and the launch keeps its row, and with it the journal
  // panel it has always had.
  const rows = buildRows([launch("toolu_launch"), task({ progress: [] })], false, false);
  assert.ok(!runOf(rows), "a run with no agents draws no workflow row");
  assert.deepEqual(rows.map((r) => r.kind), ["tool"], "and the launch row survives");
}

// ---- the launch is found by task id when no toolCallId ever arrives ----
{
  /* The adapter names the launching call only when it happens to hold one as it
     publishes; for some runs that is never on a frame we see. The tool result
     carries the runtime's task id from the instant the call returns, so the run
     still lands on its launch rather than being appended at the end. */
  const rows = buildRows(
    [launch("toolu_launch", "wo1zb0d22"), task({ toolCallId: undefined, progress: FINISHED })],
    false,
    false,
  );
  assert.deepEqual(rows.map((r) => r.kind), ["workflow-group"], "the run replaced its launch, not trailed it");
}

// ---- a launch matched both ways is still exactly one row ----
{
  const rows = buildRows(
    [launch("toolu_launch", "wo1zb0d22"), task({ toolCallId: "toolu_launch", progress: FINISHED })],
    false,
    false,
  );
  assert.equal(rows.length, 1, "matching on both keys must not duplicate the run");
  assert.equal(rows[0].kind, "workflow-group");
}

// ---- a run whose launch scrolled out of the window is not lost ----
{
  const rows = buildRows([task({ progress: FINISHED })], false, false);
  assert.ok(runOf(rows), "a run with no launch row on screen still draws");
}

// ---- a step is told where its own history is ----
{
  /* The transcript directory is named in the tool result and nowhere in the
     async-task stream, so a step can only learn it from its launch row. Both
     halves are needed: a run whose launch is off screen, or an agent the
     runtime has not named yet, draws without a rail rather than with a broken
     one. */
  const withAgentIds = FINISHED.map((e) =>
    e.type === "workflow_agent" ? { ...e, agentId: `a${e.index}` } : e,
  );
  const run = runOf(buildRows([launch("toolu_launch", "wo1zb0d22"), task({ progress: withAgentIds })], false, false));
  assert.deepEqual(
    run.steps.map((s: any) => s.head.transcript),
    [
      { dir: "/tmp/wf", agentId: "a1" },
      { dir: "/tmp/wf", agentId: "a2" },
      { dir: "/tmp/wf", agentId: "a3" },
    ],
    "each step points at its own file beside the run's journal",
  );
  const noLaunch = runOf(buildRows([task({ progress: withAgentIds })], false, false));
  assert.ok(
    noLaunch.steps.every((s: any) => s.head.transcript === undefined),
    "no launch row on screen means no directory, so no rail is claimed",
  );
  const unnamed = FINISHED.map(({ agentId: _drop, ...rest }: any) => rest);
  const noIds = runOf(buildRows([launch("toolu_launch", "wo1zb0d22"), task({ progress: unnamed })], false, false));
  assert.ok(
    noIds.steps.every((s: any) => s.head.transcript === undefined),
    "an agent the runtime has not named yet claims no rail either",
  );
}

// ---- an agent's file becomes ordinary transcript items ----
{
  const record = (type: string, content: unknown[]) => ({ type, message: { role: type, content } });
  const items = workflowAgentItems([
    record("assistant", [{ type: "text", text: "Reading the docs." }]),
    // A signature-only thinking block is what the CLI writes for a redacted
    // thought; a row that says nothing is worse than no row.
    record("assistant", [{ type: "thinking", thinking: "", signature: "abc" }]),
    record("assistant", [{ type: "thinking", thinking: "Where do the routes live?" }]),
    record("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    record("user", [{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }]),
    record("assistant", [{ type: "tool_use", id: "t2", name: "Read", input: { path: "x" } }]),
    record("user", [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "boom" }], is_error: true }]),
    // A call still open when the file was read stays open — an agent killed
    // mid-call leaves exactly that, and saying otherwise would be a guess.
    record("assistant", [{ type: "tool_use", id: "t3", name: "Grep", input: {} }]),
    // A result for a call this slice of the file never saw is not a row.
    record("user", [{ type: "tool_result", tool_use_id: "gone", content: "orphan" }]),
    { type: "attachment", nothing: true },
  ]);
  assert.deepEqual(
    items.map((i: any) => [i.kind, i.kind === "tool" ? `${i.title}:${i.status}` : i.text]),
    [
      ["agent", "Reading the docs."],
      ["thought", "Where do the routes live?"],
      ["tool", "Bash:completed"],
      ["tool", "Read:failed"],
      ["tool", "Grep:in_progress"],
    ],
  );
  assert.equal(items[2].rawOutput, "a\nb", "a string result is kept whole");
  assert.equal(items[3].rawOutput, "boom", "a block-list result keeps its text");
  assert.deepEqual(items[2].rawInput, { command: "ls" }, "the call's input is what identifies it");
  // And they are rows like any others, which is the point of converting at all.
  assert.deepEqual(buildRows(items, false, false).map((r: any) => r.kind), ["agent", "thought", "tool", "tool", "tool"]);
}

console.log("native-workflow-rows: ok");
