// A server restart over DAEDALUS_SANDBOX=hosted, in one process: the first
// manager shuts down (detaching, not killing), a second boots and adopts.
// Asserts: the process is taken over with no second `initialize`, a prompt that
// finished while the server was "down" ends its turn via `adoptTurn`, the saved
// offset counts host LINES (the stub prints a blank and a non-JSON line), a dead
// host's row is dropped and a stray host is killed.
// Run: pnpm test:adopt-boot
import "./require-temp-data.js";
process.env.DAEDALUS_SANDBOX = "hosted";
process.env.DAEDALUS_AGENT_HOST_LINGER_MS = "60000";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadCommand, ThreadEvent } from "../src/protocol.js";

const dataDir = process.env.DAEDALUS_DATA_DIR!;
rmSync(dataDir, { recursive: true, force: true });
const cwd = join(dataDir, "ws");
mkdirSync(cwd, { recursive: true });
const logPath = join(dataDir, "stub.log");
const gatePath = join(dataDir, "gate");
writeFileSync(gatePath, "closed");
const countPath = join(dataDir, "lines");
writeFileSync(logPath, "");
writeFileSync(countPath, "0");
const stubPath = join(dataDir, "stub-agent.mjs");
// One-session ACP agent. Prints a blank line and a non-JSON line after
// `initialize`; a prompt "slow" waits for the gate file; every stdout line is counted.
writeFileSync(
  stubPath,
  `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [log, gate, count] = process.argv.slice(2);
let lines = 0;
const w = (s) => { process.stdout.write(s + "\\n"); writeFileSync(count, String(++lines)); };
const out = (m) => w(JSON.stringify(m));
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) return;
  appendFileSync(log, JSON.stringify({ method: msg.method, sessionId: msg.params?.sessionId ?? null }) + "\\n");
  switch (msg.method) {
    case "initialize":
      reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
      w("");
      return w("noise: not json");
    case "session/new": return reply(msg.id, { sessionId: "stub-" + process.pid });
    case "session/resume": case "session/load": return reply(msg.id, {});
    case "session/prompt": {
      const { sessionId, prompt } = msg.params;
      const text = prompt.find((b) => b.type === "text")?.text ?? "";
      const finish = () => {
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo:" + text } } } });
        reply(msg.id, { stopReason: "end_turn" });
      };
      if (text !== "slow") return finish();
      const t = setInterval(() => { if (readFileSync(gate, "utf8") === "open") { clearInterval(t); finish(); } }, 20);
      return;
    }
    default: return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no " + msg.method } });
  }
});
`,
);
writeJson(join(dataDir, "agents.json"), [
  { id: "stub", name: "Stub", command: process.execPath, args: [stubPath, logPath, gatePath, countPath], env: {} },
]);

const { SessionManager } = await import("../src/sessions.js");
const { agentProcesses, db } = await import("../src/db/index.js");
const { seedAgents } = await import("../src/registry.js");
const { sandbox } = await import("../src/sandbox/index.js");
const { adoptAgents } = await import("../src/adopt-boot.js");
const { loadProcessStates, saveProcessState } = await import("../src/adopt-state.js");

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
  of<K extends ThreadEvent["ev"]>(ev: K): Extract<ThreadEvent, { ev: K }>[] {
    return this.sent.map((l) => JSON.parse(l) as ThreadEvent).filter((e) => e.ev === ev) as Extract<ThreadEvent, { ev: K }>[];
  }
}
const { createProfile } = await import("../src/profiles.js");
const { createProject } = await import("../src/projects.js");
// Stored rows, not literals: boot adoption reads the thread's profile and project back from the database.
const profile: Profile = await createProfile({ name: "test", agents: { stub: {} }, baseUrl: "", apiKey: "k", models: [], defaultModel: "", smallModel: "", logoUrl: "" } as never);
const project = await createProject({ name: "ws", cwd, description: null } as never);
const send = (ws: MockWs, command: ThreadCommand) => ws.emit("message", Buffer.from(JSON.stringify(command)));
const waitFor = async (predicate: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 160 && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await predicate(), `timed out waiting for ${what}`);
};
const logged = () => readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { method: string; sessionId: string | null });

await seedAgents();
const first = new SessionManager({}, 60);
await first.ready;
const thread = await first.create(profile, "stub", project);
await thread.bridge!.ready;
const ws1 = new MockWs();
assert.equal(await first.attach(thread.id, ws1 as never), null);
send(ws1, { id: 1, cmd: "prompt", text: "hi" });
await waitFor(() => ws1.of("turn_ended").length === 1, "the first turn");
send(ws1, { id: 2, cmd: "prompt", text: "slow" });
await waitFor(() => logged().filter((e) => e.method === "session/prompt").length === 2, "the slow prompt to reach the agent");
const hostId = thread.proc!.id;

// ---- the server goes down: handles detached, rows kept ----
await first.shutdown();
let rows = await loadProcessStates();
const row = rows.find((r) => r.hostId === hostId)!;
assert.ok(row, "the row survives a durable shutdown");
assert.equal(row.offset, Number(readFileSync(countPath, "utf8")), "the saved offset counts host lines (blank and non-JSON ones included)");
assert.equal(row.prompts.length, 1, "the slow prompt is recorded as in flight");
assert.equal((await sandbox.list()).some((i) => i.id === hostId), true, "the host is still running");

// ---- while it is down, the prompt completes ----
writeFileSync(gatePath, "open");
await new Promise((r) => setTimeout(r, 300));

// ---- extra hosts: a stray (no row) and a dead row (no host) ----
const stray = await sandbox.spawn({ command: process.execPath, args: ["-e", "setInterval(()=>{},1e6)"], env: {}, cwd });
stray.detach();
await saveProcessState({ hostId: "deadbeef-dead", poolKey: null, agentId: "stub", initResult: row.initResult, nextRequestId: 0, offset: 0, prompts: [] });

// ---- the new server boots and adopts ----
const second = new SessionManager({}, 60);
await second.ready;
const adoption = await adoptAgents(sandbox, second);
assert.equal(adoption.adopted, 1);
// A client that reconnects the moment the server listens, before the thread is bound,
// must wait for the bind and then see a LIVE thread — not an archived one that flips
// live under it (the "error until reload" a restart used to show).
const early = new MockWs();
let earlyDone = false;
const earlyAttach = second.attach(thread.id, early as never).then((r) => { earlyDone = true; return r; });
await new Promise((r) => setTimeout(r, 200));
assert.equal(earlyDone, false, "a reader arriving before the bind waits for it");
await adoption.bind();
assert.equal(await earlyAttach, null);
assert.equal(early.of("attached")[0].archived, false, "…and is handed the live thread, not the archived one");
const live = (second as unknown as { sessions: Map<string, typeof thread> }).sessions.get(thread.id)!;
assert.equal(live.exited, false, "the thread is live on the adopted process");
assert.equal(live.proc!.id, hostId);
assert.equal(logged().filter((e) => e.method === "initialize").length, 1, "no second `initialize`");
assert.equal(logged().filter((e) => e.method === "session/new").length, 1, "no new session");
assert.ok(logged().some((e) => e.method === "session/resume" || e.method === "session/load"), "the session was resumed on the adopted process");
const ws2 = new MockWs();
assert.equal(await second.attach(thread.id, ws2 as never), null);
await waitFor(() => ws2.of("caught_up").length > 0, "the replay");
await waitFor(() => ws2.of("turn_ended").length === 2, "the turn that finished while down to end via adoptTurn");
assert.equal(ws2.of("turn_started").length, 2, "its turn_started was kept in the journal");
rows = await loadProcessStates();
assert.equal(rows.find((r) => r.hostId === "deadbeef-dead"), undefined, "a row with no host is dropped");
await waitFor(async () => !(await sandbox.list()).some((i) => i.id === stray.id), "a host with no row to be killed");
assert.equal(rows.find((r) => r.hostId === hostId)?.prompts.length, 0, "the orphan is settled");

// ---- the thread still works on the adopted process ----
send(ws2, { id: 1, cmd: "prompt", text: "again" });
await waitFor(() => ws2.of("turn_ended").length === 3, "a turn on the adopted process");
assert.equal(logged().filter((e) => e.method === "initialize").length, 1);

// ---- explicit retire still kills ----
second.retire(live);
await waitFor(async () => !(await sandbox.list()).some((i) => i.id === hostId), "the host to end after a retire");
await waitFor(async () => !(await db.select().from(agentProcesses).where(eq(agentProcesses.hostId, hostId))).length, "its row to go");

// ---- a bind that throws for one claim must not strand the next ----
{
  const { AcpPool } = await import("../src/acp-connection.js");
  const fakeId = "fake-claims-host";
  const state = { hostId: fakeId, poolKey: null, agentId: "stub", initResult: row.initResult, nextRequestId: 5, offset: 0, prompts: [
    { acpSessionId: "sA", requestId: 3, turnId: "tA" }, { acpSessionId: "sB", requestId: 4, turnId: "tB" } ] };
  await saveProcessState(state);
  const { PassThrough } = await import("node:stream");
  const h = Object.assign(new EventEmitter(), {
    id: fakeId, pid: 1, running: true, lossy: false, offset: 0, exited: new Promise(() => {}),
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {}, detach() {},
  });
  const fakeSb = { list: async () => [{ id: fakeId }], attach: async () => h, spawn: async () => h } as never;
  const released: string[] = [];
  const mgr = {
    claimForAdopt: (acpSessionId: string) => ({ sessionId: acpSessionId, acpSessionId, release: () => void released.push(acpSessionId) }),
    bindAdopted: async (_c: unknown, _conn: unknown, made: () => void) => {
      made();
      return { adoptTurn: () => { throw new Error("boom"); } };
    },
  };
  const r = await adoptAgents(fakeSb, mgr as never, new AcpPool());
  assert.equal(r.adopted, 1);
  await r.bind();
  assert.deepEqual([...new Set(released)].sort(), ["sA", "sB"], "every claim is released even when adoptTurn throws");
}

for (const i of await sandbox.list()) await (await sandbox.attach(i.id, 0)).kill();
rmSync(dataDir, { recursive: true, force: true });
console.log("adopt-boot: all assertions passed");
process.exit(0);
