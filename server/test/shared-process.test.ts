// Threads of a runtime that takes env per session share one agent process
// (`AgentDef.sharedProcess`, `AcpConnection`, `AcpPool`): one `initialize`,
// every frame routed to the session it names, a retire that closes the session
// and leaves the process warm, a revive that resumes on it, and a crash that
// takes every session on it down.
// Run: pnpm test:shared-process
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

const dataDir = process.env.DAEDALUS_DATA_DIR!;
rmSync(dataDir, { recursive: true, force: true });
const cwd = join(dataDir, "ws");
mkdirSync(cwd, { recursive: true });
const logPath = join(dataDir, "multi.log");
writeJson(join(dataDir, "agents.json"), [
  {
    id: "multi",
    name: "Multi",
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-multi-agent.mjs"), logPath],
    env: { FAKE_KEY: "{apiKey}" },
  },
]);

const { SessionManager } = await import("../src/sessions.js");
const { agents, db } = await import("../src/db/index.js");
const { seedAgents } = await import("../src/registry.js");

class MockWs extends EventEmitter {
  sent: string[] = [];
  readyState = 1;
  send(line: string, cb?: (error?: Error) => void) {
    this.sent.push(line);
    cb?.();
  }
  close() {
    this.emit("close");
  }
  get events(): ThreadEvent[] {
    return this.sent.map((l) => JSON.parse(l) as ThreadEvent);
  }
  of<K extends ThreadEvent["ev"]>(ev: K): Extract<ThreadEvent, { ev: K }>[] {
    return this.events.filter((e) => e.ev === ev) as Extract<ThreadEvent, { ev: K }>[];
  }
  text(): string {
    return this.of("update")
      .map((e) => ((e.update as { content?: { text?: string } }).content?.text ?? ""))
      .join("");
  }
}

const profile: Profile = {
  id: "p1",
  name: "test",
  agents: { multi: {} },
  baseUrl: "",
  apiKey: "sk-shared",
  models: [],
  defaultModel: "",
  smallModel: "",
  logoUrl: "",
};
const project = { id: "w1", name: "ws", cwd, description: null };

const send = (ws: MockWs, command: ThreadCommand) => ws.emit("message", Buffer.from(JSON.stringify(command)));
const waitFor = async (predicate: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 100 && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await predicate(), `timed out waiting for ${what}`);
};
type Entry = { pid: number; method: string; sessionId: string | null; meta: { claudeCode?: { options?: { env?: Record<string, string> } } } | null };
const logged = (): Entry[] =>
  existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry) : [];

const manager = new SessionManager({}, 1);
await manager.ready;
await seedAgents();
await db.update(agents).set({ sharedProcess: "acp-meta" }).where(eq(agents.id, "multi"));

// --- two threads, one process ---
const a = await manager.create(profile, "multi", project);
const b = await manager.create(profile, "multi", project);
await a.bridge!.ready;
await b.bridge!.ready;
assert.equal(a.proc!.pid, b.proc!.pid, "two threads in one cwd share a process");
assert.equal(logged().filter((e) => e.method === "initialize").length, 1, "…which said `initialize` once");
const created = logged().filter((e) => e.method === "session/new");
assert.equal(created.length, 2, "one session per thread");
for (const entry of created) {
  assert.equal(entry.meta?.claudeCode?.options?.env?.FAKE_KEY, "sk-shared", "the thread's env rides its session");
}
assert.notEqual(a.bridge!.acpSessionId, b.bridge!.acpSessionId);

// --- frames go to the session they name ---
const wa = new MockWs();
const wb = new MockWs();
assert.equal(await manager.attach(a.id, wa as never), null);
assert.equal(await manager.attach(b.id, wb as never), null);
send(wa, { id: 1, cmd: "prompt", text: "for a" });
await waitFor(() => wa.of("turn_ended").length === 1, "a's turn");
send(wb, { id: 1, cmd: "prompt", text: "for b" });
await waitFor(() => wb.of("turn_ended").length === 1, "b's turn");
assert.match(wa.text(), /echo:for a/);
assert.doesNotMatch(wa.text(), /for b/, "a never hears b's session");
assert.match(wb.text(), /echo:for b/);
assert.doesNotMatch(wb.text(), /for a/, "b never hears a's session");
wa.close();

// --- a retire closes the session, not the process; a revive resumes on it ---
const pid = a.proc!.pid;
const aSession = a.bridge!.acpSessionId!;
const countBefore = a.eventCount;
manager.retire(a);
await waitFor(() => logged().some((e) => e.method === "session/close" && e.sessionId === aSession), "a's session/close");
assert.equal(b.exited, false, "b is still on the process");
await manager.respawn(a.id, profile, "multi", project);
assert.equal(a.proc!.pid, pid, "the revive is handed the same process");
assert.equal(logged().filter((e) => e.method === "initialize").length, 1, "…with no second `initialize`");
assert.ok(
  logged().some((e) => e.method === "session/resume" && e.sessionId === aSession),
  "…and resumes the conversation instead of replaying it",
);
assert.ok(a.eventCount >= countBefore, "the journal was kept");

// --- nobody on it: the process stays warm for the next thread ---
manager.retire(a);
manager.retire(b);
await new Promise((r) => setTimeout(r, 100));
const c = await manager.create(profile, "multi", project);
await c.bridge!.ready;
assert.equal(c.proc!.pid, pid, "a new thread gets the warm process");

// --- a crash takes every session on the process down ---
const d = await manager.create(profile, "multi", project);
await d.bridge!.ready;
const wc = new MockWs();
assert.equal(await manager.attach(c.id, wc as never), null);
send(wc, { id: 1, cmd: "prompt", text: "crash" });
await waitFor(() => c.exited && d.exited, "both sessions collapse with their process");
const e = await manager.create(profile, "multi", project);
await e.bridge!.ready;
assert.notEqual(e.proc!.pid, pid, "a dead process is never handed out again");

manager.shutdown();
console.log("shared-process: all assertions passed");
process.exit(0);
