// Self-check for `TaskTailer.agentTranscript` (src/tasks.ts): the read behind
// a native workflow step's rail.
//
// The file is on the machine the agent runs on, named by a path the client got
// out of a tool-call frame, so the whole safety of it is one rule — the path
// must contain a live thread's ACP session id as a real segment — plus a hard
// shape check on the agent id, which names a file. Both are asserted here
// alongside the happy path, because this route reads arbitrary absolute paths
// for a living.
// Run: pnpm test:task-agent
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDirError, TaskTailer, type SessionRef } from "../src/tasks.js";

const root = mkdtempSync(join(tmpdir(), "daedalus-agent-transcript-"));
const ACP = "acp-session-1";
const dir = join(root, "projects", ACP, "subagents", "workflows", "wf_1");
mkdirSync(dir, { recursive: true });

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
writeFileSync(
  join(dir, "agent-a1.jsonl"),
  line({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }) +
    "not json\n" +
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
);

const sessions: SessionRef[] = [{ id: "thread-1", acpSessionId: ACP, deletedAt: null }];
const tasks = new TaskTailer(() => {});

const rejects = async (fn: () => Promise<unknown>, status: number, what: string) => {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof TaskDirError, `${what}: expected a TaskDirError`);
    assert.equal(err.status, status, what);
    return true;
  });
};

// ---- the happy path: whole lines, in order, unread ----
{
  const { sessionId, events } = await tasks.agentTranscript(dir, "a1", sessions);
  assert.equal(sessionId, "thread-1", "the read is attributed to the owning thread");
  assert.equal(events.length, 2, "an unparseable line is skipped, not fatal");
  assert.equal((events[0] as any).type, "assistant");
  assert.equal((events[1] as any).type, "user", "order is the file's order");
}

// ---- the ownership rule ----
await rejects(() => tasks.agentTranscript(join(root, "elsewhere"), "a1", sessions), 403, "a path naming no thread");
await rejects(
  () => tasks.agentTranscript(dir, "a1", [{ id: "thread-1", acpSessionId: ACP, deletedAt: 1 }]),
  403,
  "a deleted thread owns nothing",
);
// `..` is resolved before the segments are read, so a path cannot claim a
// session id and then climb out of it.
await rejects(
  () => tasks.agentTranscript(join(dir, "..", "..", "..", "..", "elsewhere"), "a1", sessions),
  403,
  "a traversal out of the owning segment",
);
{
  // A symlink cannot smuggle the read somewhere else either: the canonical
  // path is re-checked after resolution.
  const escape = join(root, "elsewhere");
  mkdirSync(escape, { recursive: true });
  writeFileSync(join(escape, "agent-a1.jsonl"), line({ type: "assistant", message: { content: [] } }));
  const link = join(root, "projects", ACP, "link");
  symlinkSync(escape, link);
  await rejects(() => tasks.agentTranscript(link, "a1", sessions), 403, "a symlink out of the owning segment");
}

// ---- the agent id names a file, so it may not name a path ----
for (const bad of ["../secrets", "a/b", "", "a".repeat(65), "a b"]) {
  await rejects(() => tasks.agentTranscript(dir, bad, sessions), 400, `agentId ${JSON.stringify(bad)}`);
}

// ---- missing things are 404, not 500 ----
await rejects(() => tasks.agentTranscript(dir, "nosuchagent", sessions), 404, "an agent with no file");
await rejects(
  () => tasks.agentTranscript(join(root, "projects", ACP, "gone"), "a1", sessions),
  404,
  "a directory that is not there",
);
await rejects(() => tasks.agentTranscript(42 as unknown as string, "a1", sessions), 400, "a non-path");

rmSync(root, { recursive: true, force: true });
console.log("task-agent-transcript: ok");
