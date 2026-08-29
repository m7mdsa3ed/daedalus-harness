// Minimal ACP-ish agent: answers requests, streams one update per prompt,
// and exercises modes / config options / usage so the client UI can be tested.
import { createInterface } from "node:readline";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// `category` is what tells the client which selector is the model and which is
// the reasoning level, so those two get promoted out of the generic "Agent
// options" list. The third option deliberately carries no category: unknown and
// missing categories must still render, and this is what proves it.
let configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fast",
    options: [
      { value: "fast", name: "Fast" },
      { value: "smart", name: "Smart" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low effort" },
      { value: "medium", name: "Medium effort" },
      { value: "high", name: "High effort" },
    ],
  },
  {
    id: "verbose",
    name: "Verbose logging",
    type: "boolean",
    currentValue: false,
  },
];

/* What the client claimed at initialize. Compaction updates are the one thing
   here an agent is forbidden to send unquestioned — the spec says only when the
   client advertised `session.compaction` — so this is stored and honoured
   rather than assumed, which is what makes the capability itself testable. */
let clientCapabilities = {};

/** Permission request id -> the prompt id whose turn is waiting on it. */
const parkedTurns = new Map();
let permCounter = 0;

const tool = (id, title, kind, status, extra = {}) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title,
  kind,
  status,
  ...extra,
});
const text = (t) => [{ type: "content", content: { type: "text", text: t } }];

function promptUpdates() {
  const plan = (a, b) => ({
    sessionUpdate: "plan",
    entries: [
      { content: "Read the transcript components", status: a, priority: "high" },
      { content: "Redesign the step rows", status: b, priority: "high" },
      { content: "Screenshot the result", status: "pending", priority: "medium" },
    ],
  });
  return [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The rail geometry is the risky part.\nMeasure it against the row's own line box." } },
    plan("in_progress", "pending"),
    tool("t1", "ls -la", "execute", "in_progress"),
    { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: text("file-a.txt\nfile-b.txt") },
    tool("t2", "src/lib/store.ts", "read", "completed", {
      locations: [{ path: "src/lib/store.ts", line: 87 }],
      content: text(Array.from({ length: 12 }, (_, i) => `${i + 1} | line of file`).join("\n")),
    }),
    tool("t3", '"applySessionUpdate"', "search", "completed", {
      locations: [
        { path: "src/lib/store.ts", line: 87 },
        { path: "src/components/thread-view.tsx", line: 12 },
      ],
    }),
    tool("t4", "src/index.css", "edit", "completed", {
      content: [
        {
          type: "diff",
          path: "src/index.css",
          oldText: ".harness-rail-top { top: -2px; height: 6px; }",
          newText: ".harness-rail-top { top: -2px; height: 10px; }\n.harness-rail-bottom { top: 20px; bottom: -2px; }",
        },
      ],
    }),
    tool("t5", "pnpm exec tsc -b --force", "execute", "failed", {
      content: text("error TS2322: Type 'string' is not assignable to type 'number'."),
    }),
    plan("completed", "in_progress"),
    tool("t6", "https://example.com/spec", "fetch", "pending"),
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Rail lines up. Here's what changed:\n\n- node centre pinned to the row's line box\n- kind demoted to a right-hand column" } },
  ];
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    clientCapabilities = msg.params?.clientCapabilities ?? {};
    out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  }
  else if (msg.method === "session/new")
    out({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "acp-123",
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Always ask" },
            { id: "acceptEdits", name: "Accept edits" },
            { id: "bypassPermissions", name: "Bypass" },
          ],
        },
        configOptions,
      },
    });
  else if (msg.method === "session/load") {
    /* A session this agent has no record of. Real agents answer exactly like
       this — codex says "no rollout found for thread id …" — and it is the
       failure that used to cost a thread its history, because the client's
       fallback `session/new` overwrote the id it had just failed to load. */
    if (msg.params?.sessionId !== "acp-123") {
      out({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: "Internal error",
          data: { details: `no rollout found for thread id ${msg.params?.sessionId}` },
        },
      });
      return;
    }
    // Replay a tiny conversation, then answer — mirrors ACP loadSession.
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-123", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello fake agent" } } },
    });
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-123", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    });
    out({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Always ask" }, { id: "acceptEdits", name: "Accept edits" }] },
        configOptions,
      },
    });
  } else if (msg.method === "session/set_config_option") {
    configOptions = configOptions.map((o) =>
      o.id === msg.params.configId ? { ...o, currentValue: msg.params.value } : o
    );
    out({ jsonrpc: "2.0", id: msg.id, result: { configOptions } });
  } else if (msg.method === "session/prompt") {
    const asked = (msg.params.prompt ?? []).map((b) => b.text ?? "").join(" ");
    // A prompt mentioning "permission" parks the turn on a permission request,
    // so both the UI and the multi-peer arbitration have something to exercise.
    if (asked.includes("permission")) {
      const permId = `perm-${++permCounter}`;
      parkedTurns.set(permId, msg.id);
      out({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId: "acp-123",
          toolCall: { toolCallId: `t-${permId}`, title: "rm -rf ./build", kind: "execute" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    // A prompt mentioning "fail" answers with a bare JSON-RPC internal error
    // after printing a stack to stderr — exactly the shape that used to reach
    // the UI as an unexplained "RequestError: Internal error". The server
    // splices the stderr into the error's `data`, and the client renders it.
    if (asked.includes("fail")) {
      process.stderr.write("Error: the model provider returned 529\n    at Agent.prompt (agent.js:42:11)\n");
      // Give the stderr pipe a tick to land before the answer overtakes it.
      setTimeout(() => {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } });
      }, 20);
      return;
    }
    // A prompt mentioning "crash" kills the agent mid-turn: nothing ever
    // answers, which is what failPendingRequests exists to clean up.
    if (asked.includes("crash")) {
      process.stderr.write("Fatal: agent died holding the turn\n");
      setTimeout(() => process.exit(3), 20);
      return;
    }
    /* A prompt mentioning "compact" runs a context compaction: the in_progress
       upsert, the summary streamed as chunks, then a terminal update carrying
       neither `summary` nor `error` — the shape that proves the client patches
       instead of replacing, since treating the omission as empty would wipe the
       summary it just streamed. Silent when the client never claimed the
       capability, exactly as the spec requires. */
    if (asked.includes("compact")) {
      if (clientCapabilities.session?.compaction) {
        const send = (update) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-123", update } });
        send({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" });
        for (const line of ["Rewrote the transcript step rows.", "Left the rail geometry alone."]) {
          send({
            sessionUpdate: "compaction_summary_chunk",
            compactionId: "c1",
            content: { type: "text", text: line },
          });
        }
        send({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
      }
      out({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn", usage: { totalTokens: 40 } },
      });
      return;
    }
    // One of every step kind, in order — this is what the transcript UI is
    // developed against, so every branch of the step row has a live sample.
    for (const update of promptUpdates()) {
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-123", update } });
    }
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-123", update: { sessionUpdate: "usage_update", used: 12_000, size: 200_000 } },
    });
    out({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 10_500, inputTokens: 1000, outputTokens: 500, cachedReadTokens: 9000 },
      },
    });
  } else if (msg.method === undefined && parkedTurns.has(msg.id)) {
    // The answer to a permission request — finish the turn it was blocking.
    const promptId = parkedTurns.get(msg.id);
    parkedTurns.delete(msg.id);
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-123",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission: ${JSON.stringify(msg.result?.outcome ?? msg.error)}` } },
      },
    });
    out({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn", usage: { totalTokens: 10 } } });
  } else if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
});
