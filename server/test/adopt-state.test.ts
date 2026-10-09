// Adopting an agent process the previous server left running: persisted state
// round-trips, `initialize` is not re-sent, request ids resume above the saved
// mark, and an answer to a prompt the SDK never made becomes an orphan.
// Run: pnpm test:adopt-state
import "./require-temp-data.js";
process.env.DAEDALUS_SANDBOX = "hosted"; // the ledger is only installed for a durable sandbox
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Handle } from "../src/sandbox/index.js";
const { AcpConnection, flushAllProcessStates } = await import("../src/acp-connection.js");
const { dropProcessState, loadProcessStates, saveProcessProgress, saveProcessState, WireLedger } = await import("../src/adopt-state.js");

class StubHandle extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 1;
  running = true;
  exited = new Promise<number | null>(() => {});
  sent: { id?: number; method?: string; params?: unknown }[] = [];
  constructor(readonly id: string) {
    super();
    this.stdin.on("data", (b: Buffer) => {
      for (const l of b.toString().split("\n").filter(Boolean)) this.sent.push(JSON.parse(l));
    });
  }
  kill() {}
  detach() {}
  say(m: object) {
    this.stdout.write(JSON.stringify(m) + "\n");
  }
}
const asHandle = (h: StubHandle) => h as unknown as Handle;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const INIT = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } };

test("state round-trips", async () => {
  await dropProcessState("h1");
  await saveProcessState({
    hostId: "h1", poolKey: "k", agentId: "a", initResult: INIT as never, nextRequestId: 5, offset: 9,
    prompts: [{ acpSessionId: "s", requestId: 4, turnId: "t" }],
  });
  await saveProcessProgress("h1", { nextRequestId: 8, offset: 20, prompts: [] });
  const row = (await loadProcessStates()).find((s) => s.hostId === "h1")!;
  assert.deepEqual([row.poolKey, row.agentId, row.nextRequestId, row.offset, row.prompts], ["k", "a", 8, 20, []]);
  assert.deepEqual(row.initResult, INIT);
  await dropProcessState("h1");
  assert.equal((await loadProcessStates()).some((s) => s.hostId === "h1"), false);
});

test("a fresh connection persists after initialize and tracks the in-flight prompt", async () => {
  const h = new StubHandle("fresh1");
  const conn = new AcpConnection("a", asHandle(h), false);
  await tick();
  assert.equal(h.sent[0]?.method, "initialize");
  h.say({ jsonrpc: "2.0", id: h.sent[0]!.id, result: INIT });
  await conn.initialized;
  await conn.flush();
  assert.equal((await loadProcessStates()).find((s) => s.hostId === "fresh1")?.nextRequestId, 1024); // the reservation, not the counter

  conn.ledger!.noteTurn("s1", "turn1");
  const p = conn.rpc.agent.request("session/prompt" as never, { sessionId: "s1", prompt: [] } as never);
  await tick();
  const mine = (await loadProcessStates()).find((s) => s.hostId === "fresh1")!;
  assert.deepEqual(mine.prompts, [{ acpSessionId: "s1", requestId: 1, turnId: "turn1" }]);
  h.say({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
  await p;
  await tick();
  assert.deepEqual((await loadProcessStates()).find((s) => s.hostId === "fresh1")!.prompts, []);
  h.emit("exit", 0, null);
  await tick(80);
  assert.equal((await loadProcessStates()).some((s) => s.hostId === "fresh1"), false);
});

test("adopt skips initialize, resumes ids above the mark and surfaces orphans", async () => {
  const h = new StubHandle("adopt1");
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...a) => void errors.push(a);
  try {
    const conn = AcpConnection.adopt(asHandle(h), {
      hostId: "adopt1", poolKey: null, agentId: "a", initResult: INIT as never, nextRequestId: 100, offset: 7,
      prompts: [{ acpSessionId: "s1", requestId: 97, turnId: "t9" }],
    });
    assert.deepEqual(await conn.initialized, INIT);
    const seen: unknown[] = [];
    conn.ledger!.watchOrphans((o) => seen.push(o));
    conn.open();
    h.say({ jsonrpc: "2.0", id: 97, result: { stopReason: "end_turn" } }); // the old server's prompt
    const req = conn.rpc.agent.request("session/close" as never, { sessionId: "s1" } as never);
    await tick();
    assert.equal(h.sent.some((m) => m.method === "initialize"), false);
    assert.equal(h.sent[0]!.id, 100); // never below the saved mark
    h.say({ jsonrpc: "2.0", id: 100, result: {} });
    await req; // the shifted id is translated back for the SDK
    assert.equal(seen.length, 1);
    assert.deepEqual((seen[0] as { turnId: string; reply: unknown }).reply, { result: { stopReason: "end_turn" } });
    assert.equal(conn.ledger!.offset, 9); // 7 + two frames
    assert.equal(conn.ledger!.nextRequestId, 101);
    assert.equal(errors.some((a) => String(a[0]).includes("unknown request")), false);
    h.emit("exit", 0, null);
  } finally {
    console.error = orig;
  }
});

test("offset never passes an undelivered frame, whatever follows it", async () => {
  const l = new WireLedger({ nextRequestId: 0, offset: 10, prompts: [] });
  const release = l.hold();
  const ls = l.lines();
  void ls.readable.pipeTo(new WritableStream());
  const lines = ls.writable.getWriter();
  const inbound = l.inbound();
  const w = inbound.writable.getWriter();
  void inbound.readable.getReader().read();
  await lines.write(Buffer.from('{"jsonrpc":"2.0","method":"x"}\n\nnot json\n'));
  void w.write({ jsonrpc: "2.0", method: "x" } as never); // held in the gate
  await tick();
  assert.equal(l.offset, 10);
  release();
  await tick();
  assert.equal(l.offset, 13);
});

test("a crash cannot let a successor reuse an id", async () => {
  const l = new WireLedger();
  const out = l.outbound();
  void out.readable.getReader().read();
  const w = out.writable.getWriter();
  for (let i = 0; i < 700; i++) void w.write({ jsonrpc: "2.0", id: i, method: "m" } as never);
  await tick();
  const saved = l.snapshot(); // the last write before a crash
  assert.ok(saved.nextRequestId >= 700);
  assert.ok(new WireLedger(saved).nextRequestId >= 700);
});

test("flush waits for a write already in flight", async () => {
  const h = new StubHandle("flush1");
  const conn = new AcpConnection("a", asHandle(h), false);
  await tick();
  h.say({ jsonrpc: "2.0", id: h.sent[0]!.id, result: INIT });
  await conn.initialized;
  await tick(); // the urgent write after initialize is now in flight or done
  conn.ledger!.onChange(true); // starts a write
  await flushAllProcessStates(); // nothing dirty by now, yet must not return before the write
  assert.equal((await loadProcessStates()).some((s) => s.hostId === "flush1"), true);
  h.emit("exit", 0, null);
  await tick(80);
});
