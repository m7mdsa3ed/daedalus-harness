#!/usr/bin/env node
/**
 * Smoke test for native (Claude Code) dynamic-workflow rendering, against a
 * RUNNING harness.
 *
 * Creates a thread on the Default Claude Code profile in the DaedalusHarness
 * project, asks it to run a tiny two-phase workflow, and prints every
 * async-task update the thread's WebSocket delivers. A healthy run prints one
 * `async_task_spawned` with `taskType: "workflow"`, a stream of
 * `async_task_progress` lines whose `agents` list moves from start → progress
 * → done under named phases, and a terminal `async_task_state_update`.
 *
 * Printing nothing means the beats never left the server. The two things that
 * have caused that, both fixed and both regression-tested, are the adapter
 * dropping `workflow_progress` (`pnpm patch:acp`, `test:acp-workflow`) and the
 * SDK's closed update union swallowing the frames (SUBAGENT_UPDATE_KINDS in
 * acp-bridge.ts, `test:bridge`).
 *
 * Costs one small Claude Code turn. Run from server/:
 *   node scripts/smoke-native-workflow.mjs
 */
import { readFileSync } from "node:fs";

const BASE = process.env.HARNESS_URL ?? "http://127.0.0.1:4001";
const PROJECT = process.env.HARNESS_PROJECT ?? "2c9d1d3e-0851-4f58-9ea7-bec6985f85d8";
const token = JSON.parse(readFileSync(new URL("../data/config.json", import.meta.url), "utf8")).token;
const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

const created = await fetch(`${BASE}/api/sessions`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    profileId: "default:claude-code",
    agentId: "claude-code",
    projectId: PROJECT,
    title: "native workflow render check",
  }),
});
if (!created.ok) {
  console.error("could not create a thread:", created.status, await created.text());
  process.exit(1);
}
const { id } = await created.json();
console.log("thread", id, `— ${BASE.replace(/:\d+$/, ":4000")}/t/${id}`);

const PROMPT =
  "Use the Workflow tool right now (do not ask, do not do it yourself) to run a workflow " +
  "named render-check with two phases. Phase 'Wait' runs 2 agents in parallel; each agent " +
  "must run the Bash command 'sleep 25' and then reply with the single word done. Phase " +
  "'Sum' runs one agent that replies with the single word ok. Return the joined results.";

const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${token}&sessionId=${id}&cursor=0&batch=1`);
const counts = {};
/* Only the WORKFLOW's own lifecycle ends the watch. Its agents background their
   shell commands, and every one of those is an async task too — keying on "any
   task settled" cut the watch off seconds after the run began. */
let workflowTaskId = null;
let settled = false;
let turnEnded = false;
let sentAt = 0;

const since = () => `${((Date.now() - sentAt) / 1000).toFixed(0)}s`;
const finish = (why) => {
  console.log(`\n${why}`);
  console.log("update kinds:", counts);
  if (!workflowTaskId) console.log("\nNO WORKFLOW TASK SEEN — see this file's header for the two known causes.");
  ws.close();
  process.exit(workflowTaskId ? 0 : 1);
};
const timer = setTimeout(() => finish("gave up waiting (4 min)"), 240_000);
timer.unref?.();

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ id: 1, cmd: "prompt", text: PROMPT }));
  sentAt = Date.now();
  console.log("prompt sent\n");
});

ws.addEventListener("message", (event) => {
  let batch;
  try {
    batch = JSON.parse(String(event.data));
  } catch {
    return;
  }
  for (const message of Array.isArray(batch) ? batch : [batch]) {
    if ((message.ev ?? message.type) === "turn_ended") turnEnded = true;
    const update = message.update;
    if (!update) continue;
    const kind = update.sessionUpdate;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (!kind?.startsWith("async_task")) continue;

    if (kind === "async_task_spawned") {
      if (update.taskType === "workflow" && !workflowTaskId) workflowTaskId = update.asyncTaskId;
      console.log(since(), kind, JSON.stringify({ name: update.name, taskType: update.taskType, toolCallId: update.toolCallId }));
      continue;
    }
    // Everything below is about the workflow itself; its agents' shell tasks
    // would otherwise drown the run they belong to.
    if (update.asyncTaskId !== workflowTaskId) continue;

    if (kind === "async_task_progress") {
      const entries = update.workflowProgress ?? [];
      console.log(since(), kind, JSON.stringify({
        usage: update.usage,
        phases: entries.filter((e) => e.type === "workflow_phase").map((e) => e.title),
        agents: entries.filter((e) => e.type === "workflow_agent").map((e) => `${e.label}:${e.state}`),
      }));
    } else {
      console.log(since(), kind, JSON.stringify({ state: update.state, summary: (update.summary ?? "").slice(0, 80) }));
      if (["completed", "failed", "stopped"].includes(update.state)) settled = true;
    }
    if (settled && turnEnded) setTimeout(() => finish("workflow settled and the turn ended"), 1500);
  }
});

ws.addEventListener("error", (event) => console.log("ws error", event.message ?? event.type));
