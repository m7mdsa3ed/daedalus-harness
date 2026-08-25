// Minimal ACP-ish agent: answers requests, streams one update per prompt,
// and exercises modes / config options / usage so the client UI can be tested.
import { createInterface } from "node:readline";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let configOptions = [
  {
    id: "model",
    name: "Model",
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
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low effort" },
      { value: "medium", name: "Medium effort" },
      { value: "high", name: "High effort" },
    ],
  },
];

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
  if (msg.method === "initialize") out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
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
  } else if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
});
