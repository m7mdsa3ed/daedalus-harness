// Self-check for the claude-agent-acp workflow-progress passthrough
// (scripts/patch-claude-acp.mjs):
//   - a `local_workflow` task announces itself as an async task at all;
//   - a progress beat carrying `workflow_progress` republishes it as
//     `workflowProgress` on `async_task_progress`, which is the ONLY live
//     source for a dynamic workflow's shape (see AsyncTaskProgress in
//     protocol.ts for why the journal and the snapshot are not);
//   - a beat without one still publishes, so an unpatched adapter degrades to
//     the run's totals rather than to nothing.
//
// Guards an upgrade: the adapter is a global install the harness does not
// pin, and `pnpm patch:acp` has to be re-run after every one of them. Skips
// (rather than fails) where the adapter is absent — CI without a global
// install is not a broken harness.
// Run: pnpm test:acp-workflow
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = "@agentclientprotocol/claude-agent-acp";

function adapterDir(): string | null {
  const require = createRequire(import.meta.url);
  try {
    return dirname(require.resolve(`${PACKAGE}/package.json`));
  } catch {
    /* a global install is not on this package's resolution path */
  }
  const roots = (process.env.NODE_PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const root of roots.filter(Boolean)) {
    const candidate = join(root, ...PACKAGE.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

const dir = adapterDir();
if (!dir) {
  console.log(`acp-workflow-progress: ${PACKAGE} is not installed — skipped.`);
  process.exit(0);
}

const { AsyncTaskRuntime } = (await import(
  pathToFileURL(join(dir, "dist", "async-tasks.js")).href
)) as { AsyncTaskRuntime: new (...args: unknown[]) => AsyncRuntime };

interface AsyncRuntime {
  taskStarted(message: Record<string, unknown>): Promise<void>;
  taskProgress(message: Record<string, unknown>): Promise<void>;
}

type Published = { update: Record<string, unknown> };

/** A runtime with the AIR capability claimed, collecting what it publishes. */
function runtime(): { runtime: AsyncRuntime; published: Published[] } {
  const published: Published[] = [];
  const instance = new AsyncTaskRuntime(true, "session-1", async (notification: Published) => {
    published.push(notification);
  });
  return { runtime: instance, published };
}

const PROGRESS = [
  { type: "workflow_phase", index: 1, title: "Map" },
  {
    type: "workflow_agent",
    index: 1,
    label: "read:server",
    phaseIndex: 1,
    phaseTitle: "Map",
    agentId: "a1",
    state: "progress",
    tokens: 1234,
    toolCalls: 7,
    lastToolName: "Bash",
  },
];

const started = {
  task_id: "wt1",
  task_type: "local_workflow",
  description: "Audit the repo",
  workflow_name: "daedalus-audit",
  tool_use_id: "toolu_1",
  is_backgrounded: true,
};

// ---- a workflow announces itself, named by its script's meta.name ----
{
  const { runtime: r, published } = runtime();
  await r.taskStarted(started);
  const spawn = published.find((p) => p.update.sessionUpdate === "async_task_spawned");
  assert.ok(spawn, "a backgrounded local_workflow must announce itself");
  assert.equal(spawn.update.asyncTaskId, "wt1");
  assert.equal(spawn.update.taskType, "workflow", "the adapter's friendly name for the type");
  assert.equal(spawn.update.name, "daedalus-audit", "the run reads by its script's name");
  assert.equal(spawn.update.toolCallId, "toolu_1", "the launch is what a run row stands in for");
  assert.equal(spawn.update.showInTranscript, true);
}

// ---- the passthrough itself ----
{
  const { runtime: r, published } = runtime();
  await r.taskStarted(started);
  await r.taskProgress({
    task_id: "wt1",
    description: "Audit the repo",
    usage: { total_tokens: 4242, tool_uses: 11, duration_ms: 9000 },
    last_tool_name: "Bash",
    workflow_progress: PROGRESS,
  });
  const beat = published.find((p) => p.update.sessionUpdate === "async_task_progress");
  assert.ok(beat, "a progress beat must be published");
  assert.deepEqual(
    beat.update.workflowProgress,
    PROGRESS,
    "workflow_progress must survive both hops verbatim — run `pnpm patch:acp`",
  );
  assert.equal(beat.update.lastToolName, "Bash");
  assert.ok(beat.update.usage, "the run's own totals ride the same beat");
}

// ---- a beat with no array still says what it can ----
{
  const { runtime: r, published } = runtime();
  await r.taskStarted(started);
  await r.taskProgress({
    task_id: "wt1",
    description: "Audit the repo",
    usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
  });
  const beat = published.find((p) => p.update.sessionUpdate === "async_task_progress");
  assert.ok(beat, "an unpatched-shaped beat must still publish");
  assert.equal(
    beat.update.workflowProgress,
    undefined,
    "and must not invent an empty shape, which would draw a run with no steps",
  );
}

console.log("acp-workflow-progress: ok");
