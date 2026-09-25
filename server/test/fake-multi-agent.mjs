#!/usr/bin/env node
// A minimal ACP agent that runs many sessions in one process — the shape
// `AgentDef.sharedProcess` is for. Every request is appended to the log file
// named by argv[2] (with this process's pid), so a test can see which process
// answered what, and which `_meta` each session was handed.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.argv[2];
const log = (entry) => appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const sessions = new Set();
let next = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) return;
  log({ method: msg.method, sessionId: msg.params?.sessionId ?? null, meta: msg.params?._meta ?? null });
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
      });
    case "session/new": {
      const sessionId = `multi-${process.pid}-${++next}`;
      sessions.add(sessionId);
      return reply(msg.id, { sessionId });
    }
    case "session/resume":
    case "session/load":
      sessions.add(msg.params.sessionId);
      return reply(msg.id, {});
    case "session/close":
      sessions.delete(msg.params.sessionId);
      return reply(msg.id, {});
    case "session/prompt": {
      const { sessionId, prompt } = msg.params;
      const text = prompt.find((b) => b.type === "text")?.text ?? "";
      if (text === "crash") process.exit(3);
      out({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo:${text}` } } },
      });
      return reply(msg.id, { stopReason: "end_turn" });
    }
    default:
      return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
  }
});
