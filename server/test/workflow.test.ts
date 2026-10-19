// Self-check for harness workflows (src/workflows.ts) against the fake agent:
//   - a pipeline with a parallel pair, templates over inputs and outputs
//   - JSON output extraction + validation, the one repair turn, then failure
//   - a failing step skips its dependents; siblings finish; the run fails
//   - cancel interrupts a parked step and retires its thread
//   - pause starts nothing, holds a pausable child and stops the clocks;
//     resume carries on; a paused run can still be cancelled
//   - every step is mirrored into the parent's log as RFD subagent events,
//     live and on replay; the child is a real session with parentSessionId
//   - a step's token usage reaches the parent as an update of its own, while
//     the child's turn events still do not
//   - the loopback key resolves the caller; a step may not start a workflow;
//     a step is never handed the workflow server
//   - the parent's process going away cancels its runs
//   - ask: another (profile, agent) pair answers as a plain subagent child;
//     pairs are listed, matched by name, refused when unknown or from a child
// Run: pnpm test:workflow
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
mkdirSync("/tmp/daedalus-test-workflow/ws", { recursive: true });
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: {},
  },
  {
    id: "fake2",
    name: "Fake Two",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: {},
  },
]);

const { SessionManager, mcpServersFor, workflowServer, agentsServer } = await import("../src/sessions.js");
const { WorkflowRunner, WorkflowError } = await import("../src/workflows.js");
const { mcpServers } = await import("../src/library.js");
const { getConfig } = await import("../src/config.js");
const { db, schema } = await import("../src/db/index.js");
const { eq } = await import("drizzle-orm");

class MockWs extends EventEmitter {
  sent: string[] = [];
  /** Open, as far as the socket router is concerned: it skips a replay whose
      peer has gone away, so a mock that never says it is open replays nothing. */
  readyState = 1;
  /** The callback is how the replay paces itself against a real socket (it is
      what `SessionSocket.sendFrame` awaits), so a mock that ignores it hangs
      the attach rather than failing it. */
  send(line: string, cb?: (error?: Error) => void) {
    this.sent.push(line);
    cb?.();
  }
  close() {
    this.emit("close");
  }
  get events(): ThreadEvent[] {
    return this.sent.flatMap((l) => {
      const e = JSON.parse(l) as ThreadEvent;
      return e.ev === "replay" ? e.events : [e];
    });
  }
  of<K extends ThreadEvent["ev"]>(ev: K): Extract<ThreadEvent, { ev: K }>[] {
    return this.events.filter((e) => e.ev === ev) as Extract<ThreadEvent, { ev: K }>[];
  }
}

const profile: Profile = {
  id: "p1",
  name: "test",
  agents: { fake: {} },
  baseUrl: "",
  apiKey: "",
  models: [],
  defaultModel: "",
  smallModel: "",
  logoUrl: "",
};
const project = { id: "w1", name: "test-ws", cwd: "/tmp/daedalus-test-workflow/ws", description: null };
await db.insert(schema.profiles)
  .values({ id: "p1", name: "test", agents: { fake: {} }, baseUrl: "", apiKey: "", models: [], defaultModel: "", smallModel: "", logoUrl: "" } as never)
  .onConflictDoNothing()
  ;
await db.insert(schema.profiles)
  .values({ id: "p2", name: "Other", agents: { fake2: {} }, baseUrl: "", apiKey: "", models: [{ id: "m2", label: "M2", reasoningEfforts: [] }], defaultModel: "m2", smallModel: "", logoUrl: "" } as never)
  .onConflictDoNothing();
await db.insert(schema.projects).values({ id: "w1", name: "test-ws", cwd: project.cwd, description: null, logoUrl: "" } as never).onConflictDoNothing();

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.stack : String(error)}`);
  }
}
const waitFor = async (predicate: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  for (let i = 0; i < ms / 50 && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await predicate(), `timed out waiting for ${what}`);
};

let runner: InstanceType<typeof WorkflowRunner>;
const manager = new SessionManager({ onProcessGone: (s) => runner?.cancelForParent(s.id, "process gone") }, 1);
runner = new WorkflowRunner(manager, { port: 4999 });
manager.setWorkflowRunner(runner);

const parent = await manager.create(profile, "fake", project);
await parent.bridge!.ready;
const ws = new MockWs();
assert.equal(await manager.attach(parent.id, ws as never), null);
const updatesOf = (w: MockWs, kind: string) => w.of("update").filter((e) => e.update.sessionUpdate === kind);

console.log("workflow");

await test("a pipeline with a parallel pair renders templates over inputs and outputs", async () => {
  const view = await runner.start(
    parent,
    {
      name: "pipe",
      steps: [
        { name: "a", prompt: "echo:A" },
        { name: "b", prompt: "echo:B" },
        { name: "c", prompt: "echo:{{steps.a.output}}+{{steps.b.output}}+{{inputs.x}}", dependsOn: ["a", "b"] },
      ],
    },
    { x: "x" },
  );
  assert.equal(view.status, "running");
  const done = await runner.wait(view.id, 20_000);
  assert.ok(done);
  assert.equal(done.status, "completed", done.error ?? "");
  const step = (n: string) => done.steps.find((s) => s.name === n)!;
  assert.equal(step("a").output, "A");
  assert.equal(step("c").output, "A+B+x");
  assert.ok(step("a").startedAt! < step("b").endedAt! && step("b").startedAt! < step("a").endedAt!, "a and b overlapped");
  assert.ok(step("c").startedAt! >= Math.max(step("a").endedAt!, step("b").endedAt!), "c waited for both");
  // The children are real, titled, linked threads — retired once they answered.
  for (const n of ["a", "b", "c"]) {
    const child = manager.get(step(n).sessionId!)!;
    assert.equal(child.parentSessionId, parent.id);
    assert.equal(child.title, `pipe · ${n}`);
    assert.equal(child.exited, true, "the step's process is retired");
    assert.ok(child.eventCount > 0, "the step kept its own log");
  }
  assert.ok(manager.list().find((s) => s.id === step("a").sessionId)?.parentSessionId === parent.id, "list() reports the link");
  // The row is the durable record.
  assert.equal((await runner.status(view.id))?.status, "completed");
});

await test("the run is mirrored into the parent's transcript, live and on replay", async () => {
  const spawns = updatesOf(ws, "subagent_spawned");
  assert.equal(spawns.length, 3);
  const childIds = spawns.map((e) => (e.update as { subagentSessionId: string }).subagentSessionId);
  assert.ok(childIds.every((id) => manager.get(id)), "the spawn names the child's harness session");
  assert.ok(spawns.every((e) => e.sessionId === undefined), "the spawn is the parent's own update");
  const forwarded = ws.of("update").filter((e) => e.sessionId && childIds.includes(e.sessionId));
  assert.ok(forwarded.some((e) => e.update.sessionUpdate === "agent_message_chunk"), "the child's prose is re-addressed to it");
  const states = updatesOf(ws, "subagent_state_update").map((e) => (e.update as { state: string }).state);
  assert.deepEqual(states, ["completed", "completed", "completed"]);
  // Journaled: a fresh attach sees the same three shapes again.
  const ws2 = new MockWs();
  assert.equal(await manager.attach(parent.id, ws2 as never, 0, true), null);
  await waitFor(() => ws2.of("caught_up").length === 1, "replay");
  assert.equal(updatesOf(ws2, "subagent_spawned").length, 3);
  assert.equal(updatesOf(ws2, "subagent_state_update").length, 3);
  assert.ok(ws2.of("update").some((e) => e.sessionId === childIds[0]), "forwarded updates replay with the child's id");
  assert.equal(ws2.of("turn_started").length, 0, "the children's turns are not the parent's turns");
});

await test("a step's token usage rides the parent's log, without its turn", async () => {
  const spent = updatesOf(ws, "_daedalus/subagent_usage");
  assert.equal(spent.length, 3, "one per step's settled turn");
  assert.ok(spent.every((e) => e.sessionId === undefined), "it is the parent's own update, like the spawn");
  const childIds = updatesOf(ws, "subagent_spawned").map(
    (e) => (e.update as { subagentSessionId: string }).subagentSessionId,
  );
  for (const e of spent) {
    const u = e.update as { subagentSessionId: string; usage: { totalTokens: number } };
    assert.ok(childIds.includes(u.subagentSessionId), "it names the step it is about");
    assert.ok(u.usage.totalTokens > 0, "the reading is the child's own turn_ended");
  }
  // Journaled with everything else, which is what makes a step's cost replay.
  const ws3 = new MockWs();
  assert.equal(await manager.attach(parent.id, ws3 as never, 0, true), null);
  await waitFor(() => ws3.of("caught_up").length === 1, "replay");
  assert.equal(updatesOf(ws3, "_daedalus/subagent_usage").length, 3);
  assert.equal(ws3.of("turn_ended").length, 0, "the children's turn events still never reach the parent");
});

await test("phases are a barrier, and every spawn carries the outline", async () => {
  const view = await runner.start(parent, {
    name: "phased",
    phases: [
      { name: "research", steps: [{ name: "a", prompt: "echo:A" }, { name: "b", prompt: "echo:B" }] },
      // Reads "a" with no dependsOn of its own: the barrier is the guarantee.
      { name: "write", steps: [{ name: "c", prompt: "echo:{{steps.a.output}}!" }] },
    ],
  });
  const done = (await runner.wait(view.id, 20_000))!;
  assert.equal(done.status, "completed", done.error ?? "");
  const step = (n: string) => done.steps.find((s) => s.name === n)!;
  assert.equal(step("c").output, "A!");
  assert.deepEqual(done.steps.map((s) => s.phase), ["research", "research", "write"]);
  assert.ok(step("c").startedAt! >= Math.max(step("a").endedAt!, step("b").endedAt!), "the phase waited for both");
  const stamps = updatesOf(ws, "subagent_spawned")
    .map((e) => (e.update as { _meta?: { daedalus?: { workflow?: { runId: string; phase?: { name: string }; plan?: unknown } } } })._meta?.daedalus?.workflow)
    .filter((w) => w?.runId === view.id);
  assert.equal(stamps.length, 3);
  assert.deepEqual(stamps.map((w) => w!.phase?.name), ["research", "research", "write"]);
  for (const w of stamps) {
    assert.deepEqual(w!.plan, [
      { name: "research", steps: ["a", "b"] },
      { name: "write", steps: ["c"] },
    ]);
  }
});

await test("a flat definition's outline is one unnamed phase", async () => {
  const view = await runner.start(parent, { name: "flat", steps: [{ name: "only", prompt: "echo:x" }] });
  const done = (await runner.wait(view.id, 20_000))!;
  assert.equal(done.status, "completed", done.error ?? "");
  assert.equal(done.steps[0].phase, null);
  const stamp = updatesOf(ws, "subagent_spawned")
    .map((e) => (e.update as { _meta?: { daedalus?: { workflow?: { runId: string; plan?: unknown } } } })._meta?.daedalus?.workflow)
    .find((w) => w?.runId === view.id);
  assert.deepEqual(stamp!.plan, [{ name: null, steps: ["only"] }]);
});

await test("a JSON step validates, repairs once, and fails on the second miss", async () => {
  const schemaSpec = { type: "object", required: ["findings"], properties: { findings: { type: "array" } } };
  const ok = await runner.start(parent, {
    name: "json",
    steps: [
      { name: "j", prompt: 'echo:Here you go:\n```json\n{"findings":["one"]}\n```', output: { schema: schemaSpec } },
      { name: "use", prompt: "echo:{{steps.j.output.findings.0}}", dependsOn: ["j"] },
    ],
  });
  const done = (await runner.wait(ok.id, 20_000))!;
  assert.equal(done.status, "completed", done.error ?? "");
  assert.deepEqual(done.steps[0].output, { findings: ["one"] });
  assert.equal(done.steps[1].output, "one");

  const bad = await runner.start(parent, { name: "json-bad", steps: [{ name: "j", prompt: 'echo:{"nope":1}', output: { schema: schemaSpec } }] });
  const failed = (await runner.wait(bad.id, 20_000))!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps[0].status, "failed");
  assert.equal(failed.steps[0].attempt, 2, "one repair turn was tried");
  assert.match(failed.steps[0].error ?? "", /output schema/);
});

await test("a failing step skips its dependents while its sibling finishes", async () => {
  const view = await runner.start(parent, {
    name: "partial",
    steps: [
      { name: "bad", prompt: "please fail" },
      { name: "ok", prompt: "echo:fine" },
      { name: "after", prompt: "echo:{{steps.bad.output}}", dependsOn: ["bad"] },
    ],
  });
  const done = (await runner.wait(view.id, 20_000))!;
  assert.equal(done.status, "failed");
  const step = (n: string) => done.steps.find((s) => s.name === n)!;
  assert.equal(step("bad").status, "failed");
  assert.match(step("bad").error ?? "", /Internal error/);
  assert.equal(step("after").status, "skipped");
  assert.equal(step("ok").status, "completed");
  assert.equal(step("ok").output, "fine");
});

await test("cancel interrupts a parked step and retires its thread", async () => {
  const view = await runner.start(parent, { name: "park", steps: [{ name: "ask", prompt: "needs permission" }] });
  await waitFor(async () => (await runner.status(view.id))?.steps[0].sessionId != null && manager.get((await runner.status(view.id))!.steps[0].sessionId!)?.bridge?.promptActive === true, "the step's turn to park");
  const childId = (await runner.status(view.id))!.steps[0].sessionId!;
  assert.equal(runner.cancel(view.id), true);
  const done = (await runner.wait(view.id, 5_000))!;
  assert.equal(done.status, "cancelled");
  await waitFor(() => manager.get(childId)?.exited === true, "the child to retire");
  await waitFor(() => updatesOf(ws, "subagent_state_update").some((e) => (e.update as { subagentSessionId: string; state: string }).subagentSessionId === childId && (e.update as { state: string }).state === "cancelled"), "the cancelled state on the parent");
  assert.equal(runner.cancel(view.id), false, "a finished run cannot be cancelled again");
});

await test("pause holds the run, resume carries it on", async () => {
  const view = await runner.start(parent, {
    name: "hold",
    steps: [
      { name: "a", prompt: "needs permission" },
      { name: "b", prompt: "echo:B", dependsOn: ["a"] },
    ],
  });
  const stepOf = async (n: string) => ((await runner.status(view.id))!).steps.find((s) => s.name === n)!;
  await waitFor(async () => (await stepOf("a")).sessionId != null && manager.get((await stepOf("a")).sessionId!)?.bridge?.promptActive === true, "a to park");
  const child = manager.get((await stepOf("a")).sessionId!)!;
  assert.equal(runner.resume(view.id), false, "a running run is not resumed");
  assert.equal(runner.pause(view.id), true);
  assert.equal(runner.pause(view.id), false, "a held run is not paused twice");
  assert.equal((await runner.status(view.id))!.status, "paused");
  // The stamp names the thread the run belongs to, and the hold is said on it.
  const spawn = updatesOf(ws, "subagent_spawned").find((e) => (e.update as { subagentSessionId: string }).subagentSessionId === child.id)!;
  assert.equal(((spawn.update as unknown as { _meta: { daedalus: { workflow: { sessionId: string } } } })._meta.daedalus.workflow.sessionId), parent.id);
  const states = () => updatesOf(ws, "_daedalus/workflow_state").map((e) => e.update as { runId: string; paused: boolean }).filter((u) => u.runId === view.id);
  await waitFor(() => states().some((u) => u.paused), "the hold on the parent");
  // The running child's own runtime was asked to hold (the fake agent takes the pair).
  await waitFor(() => child.bridge?.paused === true, "the child to be paused");
  // Its question is answered; the step completes — and its dependent does not start.
  const pending = child.bridge!.pendingEvents()[0] as { requestId: string; request: { options: { optionId: string }[] } };
  child.bridge!.answer(pending.requestId, { outcome: { outcome: "selected", optionId: pending.request.options[0].optionId } });
  await waitFor(async () => (await stepOf("a")).status === "completed", "a to complete under the hold");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await stepOf("b")).status, "pending", "b did not start while paused");
  assert.equal((await runner.status(view.id))!.status, "paused");
  assert.equal(await runner.statusFor("someone-else", view.id), null, "a run is only its thread's");
  assert.equal((await runner.statusFor(parent.id, view.id))?.id, view.id);
  assert.equal(runner.resume(view.id), true);
  const done = (await runner.wait(view.id, 20_000))!;
  assert.equal(done.status, "completed", done.error ?? "");
  assert.equal(done.steps.find((s) => s.name === "b")!.output, "B");
  assert.ok(states().some((u) => !u.paused), "the release on the parent");
});

await test("a paused run can be cancelled and a step's clock stands still while held", async () => {
  const view = await runner.start(parent, { name: "hold-cancel", steps: [{ name: "ask", prompt: "needs permission", timeoutSec: 1 }] });
  await waitFor(async () => (await runner.status(view.id))?.steps[0].sessionId != null && manager.get((await runner.status(view.id))!.steps[0].sessionId!)?.bridge?.promptActive === true, "the step's turn to park");
  const childId = (await runner.status(view.id))!.steps[0].sessionId!;
  assert.equal(runner.pause(view.id), true);
  // Past the step's own timeout: a clock that kept running would have failed it.
  await new Promise((r) => setTimeout(r, 1_300));
  assert.equal((await runner.status(view.id))!.status, "paused");
  assert.equal((await runner.status(view.id))!.steps[0].status, "running");
  assert.equal(runner.cancel(view.id), true);
  const done = (await runner.wait(view.id, 5_000))!;
  assert.equal(done.status, "cancelled");
  await waitFor(() => manager.get(childId)?.exited === true, "the child to retire");
  assert.equal(runner.resume(view.id), false, "a finished run cannot be resumed");
});

await test("the loopback key resolves the caller and a step may not start a workflow", async () => {
  const url = runner.urlFor(parent);
  const [, key, sid] = /\/wf\/([0-9a-f]+)\/([^/]+)$/.exec(url)!;
  assert.equal(sid, parent.id);
  assert.equal(runner.resolveCaller(key, parent.id), parent);
  assert.equal(runner.resolveCaller("0".repeat(key.length), parent.id), null);
  assert.equal(runner.resolveCaller(key, "nope"), null);
  const child = await manager.create(profile, "fake", project, undefined, undefined, undefined, undefined, undefined, { parentSessionId: parent.id, title: "step" });
  await child.bridge!.ready;
  await assert.rejects(async () => runner.start(child, { name: "x", steps: [{ name: "a", prompt: "echo:x" }] }), (e: unknown) => e instanceof WorkflowError && e.status === 409);
  manager.retire(child);
});

await test("a step is never handed the workflow server", async () => {
  await mcpServers.ensureBuiltin("workflow");
  const links = { mcpServerIds: ["builtin:workflow"] };
  const { servers: top } = await mcpServersFor(links, project, getConfig(), workflowServer(parent, runner));
  assert.equal(top.length, 1);
  assert.equal(top[0].name, "workflow");
  assert.ok((top[0] as { env: { name: string; value: string }[] }).env.some((e) => e.name === "WORKFLOW_URL" && e.value.endsWith(`/${parent.id}`)));
  assert.equal((await mcpServersFor(links, project, getConfig(), null)).servers.length, 0);
});

await test("bad definitions are refused before anything spawns", async () => {
  await assert.rejects(async () => runner.start(parent, { name: "x", steps: [] }), /invalid workflow/);
  await assert.rejects(async () => runner.start(parent, { name: "x", steps: [{ name: "a", prompt: "{{inputs.q}}" }] }), /inputs that were not given: q/);
  await assert.rejects(async () => runner.start(parent, { name: "x", steps: [{ name: "a", prompt: "x", dependsOn: ["zz"] }] }), /invalid workflow/);
});

await test("the parent's process going away cancels its runs", async () => {
  const view = await runner.start(parent, { name: "orphan", steps: [{ name: "ask", prompt: "needs permission" }] });
  await waitFor(async () => (await runner.status(view.id))?.steps[0].sessionId != null, "the step to spawn");
  manager.retire(parent);
  const done = (await runner.wait(view.id, 5_000))!;
  assert.equal(done.status, "cancelled");
  assert.match(done.error ?? "", /process gone/);
});

await test("recoverAtBoot closes what the last process left running", async () => {
  await db.insert(schema.workflowRuns)
    .values({
      id: "stale", parentSessionId: parent.id, name: "stale", definition: {}, inputs: {}, status: "running", error: null,
      steps: [{ name: "s", status: "running", sessionId: "gone", attempt: 1, output: null, error: null, startedAt: 1, endedAt: null }],
      createdAt: 1, endedAt: null,
    })
    ;
  /* The disconnect this test is about, and the only one it may count: earlier
     tests leave runs of their own interrupted (a cancelled one retires its
     child rather than finishing it), and `recoverAtBoot` closes every such row
     in the database — so a bare `before + 1` measures the whole file, not this
     run. The row below is the one this test inserted. */
  const before = ((await manager.journal(parent.id))!).events
    .filter((e) => e.ev === "update" && e.update.sessionUpdate === "subagent_state_update").length;
  await new WorkflowRunner(manager, { port: 4999 }).recoverAtBoot();
  const row = (await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, "stale")))[0]!;
  assert.equal(row.status, "failed");
  assert.equal(row.steps[0].status, "failed");
  // The parent is retired but its log is not: the disconnect is journaled.
  const after = ((await manager.journal(parent.id))!).events
    .filter((e) => e.ev === "update" && e.update.sessionUpdate === "subagent_state_update" && e.update.subagentSessionId === "gone").length;
  assert.equal(after, 1, "the stale step's own disconnect is journaled once");
});

// ── scripts ───────────────────────────────────────────────────────────────
// The other engine: the shape of the run is decided by running it. Everything
// below is what a declarative definition cannot express.

await test("a script fans out over what a first agent found, as real threads on one card", async () => {
  const view = await runner.startScript(
    parent,
    { script: `export const meta = {
       name: 'fanout',
       description: 'Read a list, then one agent per item',
       phases: [{ title: 'Scout' }, { title: 'Read' }],
     }
     phase('Scout')
     const listed = await agent('echo:alpha,beta,gamma', { label: 'scout' })
     const items = listed.split(',')
     log('fanning out over ' + items.length)
     phase('Read')
     const read = await parallel(items.map((it) => () => agent('echo:' + it, { label: 'read:' + it })))
     return { items, read }` },
  );
  assert.equal(view.status, "running");
  const done = await runner.wait(view.id, 30_000);
  assert.ok(done);
  assert.equal(done.status, "completed", done.error ?? "");
  assert.deepEqual(
    done.steps.map((s) => s.name),
    ["scout", "read-alpha", "read-beta", "read-gamma"],
    "one step per agent, in call order, named by its label",
  );
  assert.deepEqual(done.steps.map((s) => s.status), ["completed", "completed", "completed", "completed"]);
  assert.deepEqual(done.steps.map((s) => s.phase), ["Scout", "Read", "Read", "Read"]);
  assert.equal(done.steps.find((s) => s.name === "read-beta")!.output, "beta");
  /* Every agent is a real child thread, exactly as a declarative step is —
     which is the whole reason the script runs here rather than in the model's
     own context. */
  for (const step of done.steps) {
    const child = manager.get(step.sessionId!)!;
    assert.equal(child.parentSessionId, parent.id);
    assert.equal(child.title, `fanout · ${step.name}`);
    assert.equal(child.exited, true);
  }
  // And the card is drawn from the very RFD events the declarative engine emits.
  const wf = (e: { update: unknown }) =>
    (e.update as { _meta?: { daedalus?: { workflow?: { runId: string; plan: { name: string; steps: string[] }[] } } } })._meta?.daedalus
      ?.workflow;
  const spawns = updatesOf(ws, "subagent_spawned").filter((e) => wf(e)?.runId === view.id);
  assert.equal(spawns.length, 4, "every agent announced itself on the parent");
  assert.deepEqual(
    wf(spawns[3])!.plan,
    [{ name: "Scout", steps: ["scout"] }, { name: "Read", steps: ["read-alpha", "read-beta", "read-gamma"] }],
    "the outline grows with the run, so the card shows the stages the script declared",
  );
});

await test("a script parses schema output, and a failed agent is a null inside parallel", async () => {
  const view = await runner.startScript(
    parent,
    { script: `export const meta = { name: 'mixed', description: 'schema and failure' }
     const ok = await agent('echo:take it:\\n\\u0060\\u0060\\u0060json\\n{"n":1}\\n\\u0060\\u0060\\u0060', {
       label: 'good',
       schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
     })
     const both = await parallel([
       () => agent('echo:fine', { label: 'fine' }),
       () => agent('please fail', { label: 'doomed' }),
     ])
     return { n: ok.n, both }` },
  );
  const done = await runner.wait(view.id, 30_000);
  assert.ok(done);
  assert.equal(done.status, "completed", done.error ?? "");
  assert.deepEqual(done.steps.find((s) => s.name === "good")!.output, { n: 1 }, "a schema step resolves as the parsed object");
  assert.equal(done.steps.find((s) => s.name === "doomed")!.status, "failed");
  assert.deepEqual(
    done.result,
    { n: 1, both: ["fine", null] },
    "a thrown agent is null so the script's own filter works, and the run still completes",
  );
});

await test("an unguarded agent failure fails the run; cancel stops one mid-flight", async () => {
  const bad = await runner.startScript(
    parent,
    { script: `export const meta = { name: 'boom', description: 'unguarded failure' }
     await agent('please fail', { label: 'only' })
     return 'unreachable'` },
  );
  const failed = await runner.wait(bad.id, 30_000);
  assert.equal(failed?.status, "failed", "a bare await that throws fails the run");

  const long = await runner.startScript(
    parent,
    { script: `export const meta = { name: 'slow', description: 'parks' }
     await agent('needs permission', { label: 'parked' })` },
  );
  await waitFor(async () => ((await runner.status(long.id))?.steps ?? []).some((s) => s.status === "running"), "the script's agent to start");
  assert.equal(runner.cancel(long.id, "by hand"), true);
  const stopped = await runner.wait(long.id, 20_000);
  assert.equal(stopped?.status, "cancelled");
  /* The run's waiters fire the moment it is cancelled; a step already in flight
     closes itself a beat later, when its own wait loses the race to the abort.
     So the settling is awaited rather than assumed — the same order the
     declarative engine's cancel has. */
  await waitFor(
    async () => ((await runner.status(long.id))?.steps ?? []).every((s) => s.status !== "running"),
    "the script's agent to close itself",
  );
  const settled = (await runner.status(long.id))!;
  assert.deepEqual((await settled).steps.map((s) => s.status), ["cancelled"], "cancelling the run cancels its agents");
  await waitFor(() => manager.get(settled.steps[0].sessionId!)?.exited === true, "the agent's thread to retire");
});

await test("a script is refused what it may not do", async () => {
  await assert.rejects(
    async () => runner.startScript(parent, { script: "const meta = { name: 'x', description: 'y' }" }),
    (e: unknown) => e instanceof WorkflowError,
    "meta must be exported",
  );
  await assert.rejects(
    async () => runner.startScript(parent, { script: "export const meta = { name: computed(), description: 'y' }" }),
    (e: unknown) => e instanceof WorkflowError,
    "meta must be a literal, or the run could not be named before it runs",
  );
  const child = await manager.create(profile, "fake", project, undefined, undefined, undefined, undefined, undefined, {
    parentSessionId: parent.id,
  });
  await assert.rejects(
    async () => runner.startScript(child, { script: "export const meta = { name: 'x', description: 'y' }" }),
    (e: unknown) => e instanceof WorkflowError && e.status === 409,
    "a step may not start a workflow, whichever engine it would use",
  );
  await manager.retire(child);
  // The clock ban is the sandbox's, but it has to reach the run's own error.
  const clock = await runner.startScript(parent, { script: "export const meta = { name: 'clock', description: 'reads a clock' }\nreturn Date.now()" });
  const done = await runner.wait(clock.id, 20_000);
  assert.equal(done?.status, "failed");
  assert.match(done!.error ?? "", /unreplayable/);
});

await test("a relaunch reuses every unchanged agent; a background run tells its parent", async () => {
  const script = `export const meta = { name: 'again', description: 'resume' }
    const a = await agent('echo:one', { label: 'one' })
    const b = await agent('echo:' + (args?.second ?? 'two'), { label: 'two' })
    return [a, b]`;
  const first = await runner.wait((await runner.startScript(parent, { script })).id, 30_000);
  assert.equal(first?.status, "completed", first?.error ?? "");
  const again = await runner.wait((await runner.startScript(parent, { resumeFromRunId: first!.id, args: { second: "three" } })).id, 30_000);
  assert.equal(again?.status, "completed", again?.error ?? "");
  assert.deepEqual(again!.result, ["one", "three"]);
  assert.equal(again!.steps[0].sessionId, first!.steps[0].sessionId, "an unchanged call answers from the run it resumes");
  assert.notEqual(again!.steps[1].sessionId, first!.steps[1].sessionId, "a changed one runs again");

  /* Not waited on — which is what makes it a background run: its end is a
     message on the parent, and that message is the parent's next turn. */
  const bg = await runner.startScript(parent, { script, notify: true });
  await waitFor(
    () => ws.of("turn_started").some((e) => e.text.includes(`<task-id>${bg.id}</task-id>`) && e.text.includes("<status>completed</status>")),
    "the background run's notification to start a turn on its parent",
    30_000,
  );
});

await test("a wait that times out does not opt out of the notification; the row ends completed", async () => {
  const short = await runner.startScript(parent, {
    script: "export const meta = { name: 'short', description: 'outlives its wait' }\nreturn await agent('echo:late', { label: 'late' })",
    notify: true,
  });
  const early = await runner.wait(short.id, 1);
  assert.equal(early?.status, "running", "the wait gave up before the run ended");
  await waitFor(
    () => ws.of("turn_started").some((e) => e.text.includes(`<task-id>${short.id}</task-id>`)),
    "the notification after a timed-out wait",
    30_000,
  );
  const { eq } = await import("drizzle-orm");
  await waitFor(async () => {
    const row = (await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, short.id)))[0];
    return row?.status === "completed";
  }, "the stored row to say completed, not an older 'running'");
});

await test("a background declarative run with phases tells its parent too", async () => {
  const bg = await runner.start(parent, {
    name: "phased",
    phases: [{ name: "contract", steps: [{ name: "spec", prompt: "echo:S" }] }, { name: "build", steps: [{ name: "impl", prompt: "echo:I" }] }],
  }, {}, true);
  await waitFor(
    () => ws.of("turn_started").some((e) => e.text.includes(`<task-id>${bg.id}</task-id>`)),
    "the declarative run's notification",
    30_000,
  );
});

console.log("ask");

await test("pairs lists every profile × agent it declares, and marks the caller's", async () => {
  const pairs = await runner.pairs(parent);
  const other = pairs.find((p) => p.profileId === "p2");
  assert.ok(other, "the second profile is listed");
  assert.equal(other.agentId, "fake2");
  assert.equal(other.installed, true);
  assert.deepEqual(other.models, ["m2"]);
  assert.equal(other.current, false);
  assert.equal(pairs.find((p) => p.profileId === "p1" && p.agentId === "fake")?.current, true);
});

await test("ask runs another pair as a plain subagent child and answers its reply", async () => {
  const before = updatesOf(ws, "subagent_spawned").length;
  const view = await runner.ask(parent, { profile: "other", agent: "Fake Two", prompt: "echo:hello" });
  const done = await runner.wait(view.id, 20_000);
  assert.equal(done?.status, "completed", done?.error ?? "");
  assert.equal(done!.steps[0].output, "hello");
  const child = manager.get(done!.steps[0].sessionId!)!;
  assert.equal(child.parentSessionId, parent.id);
  assert.equal(child.agentId, "fake2", "the child runs the named agent");
  assert.equal(child.profileId, "p2", "on the named profile");
  assert.equal(child.model, "m2", "on that profile's default model, not the parent's");
  const spawn = updatesOf(ws, "subagent_spawned").slice(before)[0]!.update as {
    name: string;
    _meta?: { daedalus?: { ask?: unknown; workflow?: unknown } };
  };
  assert.equal(spawn.name, "Fake Two · Other", "with no description the pair names the row");
  assert.equal(spawn._meta?.daedalus?.workflow, undefined, "no workflow meta: it draws as a plain subagent");
  assert.deepEqual(
    spawn._meta?.daedalus?.ask,
    { agent: "Fake Two", profile: "Other", agentId: "fake2", profileId: "p2" },
    "the row is told which pair answered",
  );
});

await test("an ask's description names the child thread and its row", async () => {
  const before = updatesOf(ws, "subagent_spawned").length;
  const view = await runner.ask(parent, { profile: "p2", agent: "fake2", prompt: "echo:hi", description: "  Audit the auth flow  " });
  const done = await runner.wait(view.id, 20_000);
  assert.equal(done?.status, "completed", done?.error ?? "");
  assert.equal(manager.get(done!.steps[0].sessionId!)!.title, "Ask · Audit the auth flow", "the child is titled by the errand");
  const spawn = updatesOf(ws, "subagent_spawned").slice(before)[0]!.update as { name: string };
  assert.equal(spawn.name, "Audit the auth flow", "and so is the row it draws as");
});

await test("ask refuses an unknown pair, and a child may not ask", async () => {
  await assert.rejects(async () => runner.ask(parent, { profile: "other", agent: "fake", prompt: "x" }), (e: unknown) => e instanceof WorkflowError && e.status === 404);
  const child = await manager.create(profile, "fake", project, undefined, undefined, undefined, undefined, undefined, { parentSessionId: parent.id, title: "step" });
  await child.bridge!.ready;
  await assert.rejects(async () => runner.ask(child, { profile: "other", agent: "fake2", prompt: "x" }), (e: unknown) => e instanceof WorkflowError && e.status === 409);
  manager.retire(child);
});

await test("ask needs a profile, and the thread's choice per agent outranks the model's", async () => {
  await assert.rejects(async () => runner.ask(parent, { prompt: "x" }), (e: unknown) => e instanceof WorkflowError && e.status === 409);
  await assert.rejects(async () => manager.setAskProfiles(parent.id, { fake2: { profileId: "nope" } }), /cannot run/);
  await assert.rejects(async () => manager.setAskProfiles(parent.id, { fake2: { profileId: "p2", model: "nope" } }), /no model/);
  const pair = (await runner.pairs(parent)).find((p) => p.profileId === "p2" && p.agentId === "fake2")!;
  const model = pair.models[0]!;
  await manager.setAskProfiles(parent.id, { [pair.agentId]: { profileId: pair.profileId, model } });
  // Naming the agent, naming nothing, and naming another profile all land on the person's choice.
  for (const input of [{ agent: "fake2", prompt: "echo:HI" }, { prompt: "echo:HI" }, { profile: "p1", agent: "fake2", prompt: "echo:HI" }]) {
    const done = await runner.wait((await runner.ask(parent, input)).id, 20_000);
    const child = manager.get(done!.steps[0].sessionId!)!;
    assert.deepEqual([child.profileId, child.agentId, child.model], [pair.profileId, pair.agentId, model]);
  }
  assert.deepEqual(await manager.setAskProfiles(parent.id, {}), {});
});

await test("asks are capped apart from workflows", async () => {
  const asks = await Promise.all([0, 1].map(() => runner.ask(parent, { profile: "p2", agent: "fake2", prompt: "needs permission" })));
  const wf = await runner.start(parent, { name: "beside", steps: [{ name: "a", prompt: "echo:A" }] });
  assert.equal((await runner.wait(wf.id, 20_000))?.status, "completed", "a workflow still starts beside two asks");
  for (const a of asks) runner.cancel(a.id);
});

await test("an ask's child has its permissions granted, and a question it parks is the parent's", async () => {
  const done = await runner.wait((await runner.ask(parent, { profile: "p2", agent: "fake2", prompt: "needs permission" })).id, 20_000);
  assert.equal(done?.status, "completed", "no one had to approve the asked agent's tool call");
  // What no policy can answer parks on the child and is drawn on the parent.
  const view = await runner.ask(parent, { profile: "p2", agent: "fake2", prompt: "perm-noallow" });
  await waitFor(async () => (await runner.status(view.id))?.steps[0].sessionId != null, "the ask's child");
  const childId = (await runner.status(view.id))!.steps[0].sessionId!;
  await waitFor(() => ws.of("permission").some((e) => e.from?.sessionId === childId), "the child's request on the parent");
  const asked = ws.of("permission").find((e) => e.from?.sessionId === childId)!;
  assert.ok(asked.requestId.startsWith(`${childId}:`), "a namespaced id the parent's socket can route");
  assert.ok(manager.childPendingEvents(parent.id).some((e) => "requestId" in e && e.requestId === asked.requestId), "and handed to a peer that attaches now");
  assert.ok(manager.answerChild(parent.id, asked.requestId, { outcome: { outcome: "selected", optionId: "reject" } }));
  await waitFor(() => ws.of("request_answered").some((e) => e.requestId === asked.requestId), "the answer said on the parent");
  assert.ok(!manager.childPendingEvents(parent.id).some((e) => "requestId" in e && e.requestId === asked.requestId));
  assert.equal(manager.answerChild(parent.id, asked.requestId, {}), null, "a second answer loses");
  runner.cancel(view.id);
});

await test("the agents builtin resolves to the agents server, and to nothing for a child", async () => {
  await mcpServers.ensureBuiltin("agents");
  const links = { mcpServerIds: ["builtin:agents"] };
  const { servers } = await mcpServersFor(links, project, getConfig(), null, agentsServer(parent, runner));
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "agents");
  assert.ok((servers[0] as { env: { name: string; value: string }[] }).env.some((e) => e.name === "AGENTS_URL" && e.value.endsWith(`/${parent.id}`)));
  assert.equal((await mcpServersFor(links, project, getConfig(), null, null)).servers.length, 0);
});

for (const s of manager.list()) if (!s.exited) manager.retire(manager.get(s.id)!);
manager.shutdown();
console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
