// Self-check for harness workflows (src/workflows.ts) against the fake agent:
//   - a pipeline with a parallel pair, templates over inputs and outputs
//   - JSON output extraction + validation, the one repair turn, then failure
//   - a failing step skips its dependents; siblings finish; the run fails
//   - cancel interrupts a parked step and retires its thread
//   - every step is mirrored into the parent's log as RFD subagent events,
//     live and on replay; the child is a real session with parentSessionId
//   - the loopback key resolves the caller; a step may not start a workflow;
//     a step is never handed the workflow server
//   - the parent's process going away cancels its runs
// Run: pnpm test:workflow
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";
import type { ThreadEvent } from "../src/protocol.js";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });
writeJson(join(process.env.DAEDALUS_DATA_DIR!, "agents.json"), [
  {
    id: "fake",
    name: "Fake",
    command: "node",
    args: [join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs")],
    env: {},
  },
]);

const { SessionManager, mcpServersFor, workflowServer } = await import("../src/sessions.js");
const { WorkflowRunner, WorkflowError } = await import("../src/workflows.js");
const { mcpServers } = await import("../src/library.js");
const { getConfig } = await import("../src/config.js");
const { db, schema } = await import("../src/db/index.js");
const { eq } = await import("drizzle-orm");

class MockWs extends EventEmitter {
  sent: string[] = [];
  send(line: string) {
    this.sent.push(line);
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
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
};
const project = { id: "w1", name: "test-ws", cwd: "/tmp/daedalus-test-workflow/ws", description: null };
db.insert(schema.profiles)
  .values({ id: "p1", name: "test", agents: { fake: {} }, baseUrl: "", apiKey: "", models: [], defaultModel: "", smallModel: "", logoUrl: "" } as never)
  .onConflictDoNothing()
  .run();
db.insert(schema.projects).values({ id: "w1", name: "test-ws", cwd: project.cwd, description: null, logoUrl: "" } as never).onConflictDoNothing().run();

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
const waitFor = async (predicate: () => boolean, what: string, ms = 10_000) => {
  for (let i = 0; i < ms / 50 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

let runner: InstanceType<typeof WorkflowRunner>;
const manager = new SessionManager({ onProcessGone: (s) => runner?.cancelForParent(s.id, "process gone") }, 1);
runner = new WorkflowRunner(manager, { port: 4999 });
manager.setWorkflowRunner(runner);

const parent = manager.create(profile, "fake", project);
await parent.bridge!.ready;
const ws = new MockWs();
assert.equal(manager.attach(parent.id, ws as never), null);
const updatesOf = (w: MockWs, kind: string) => w.of("update").filter((e) => e.update.sessionUpdate === kind);

console.log("workflow");

await test("a pipeline with a parallel pair renders templates over inputs and outputs", async () => {
  const view = runner.start(
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
  assert.equal(runner.status(view.id)?.status, "completed");
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
  assert.equal(manager.attach(parent.id, ws2 as never, 0, true), null);
  await waitFor(() => ws2.of("caught_up").length === 1, "replay");
  assert.equal(updatesOf(ws2, "subagent_spawned").length, 3);
  assert.equal(updatesOf(ws2, "subagent_state_update").length, 3);
  assert.ok(ws2.of("update").some((e) => e.sessionId === childIds[0]), "forwarded updates replay with the child's id");
  assert.equal(ws2.of("turn_started").length, 0, "the children's turns are not the parent's turns");
});

await test("phases are a barrier, and every spawn carries the outline", async () => {
  const view = runner.start(parent, {
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
  const view = runner.start(parent, { name: "flat", steps: [{ name: "only", prompt: "echo:x" }] });
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
  const ok = runner.start(parent, {
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

  const bad = runner.start(parent, { name: "json-bad", steps: [{ name: "j", prompt: 'echo:{"nope":1}', output: { schema: schemaSpec } }] });
  const failed = (await runner.wait(bad.id, 20_000))!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps[0].status, "failed");
  assert.equal(failed.steps[0].attempt, 2, "one repair turn was tried");
  assert.match(failed.steps[0].error ?? "", /output schema/);
});

await test("a failing step skips its dependents while its sibling finishes", async () => {
  const view = runner.start(parent, {
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
  const view = runner.start(parent, { name: "park", steps: [{ name: "ask", prompt: "needs permission" }] });
  await waitFor(() => runner.status(view.id)?.steps[0].sessionId != null && manager.get(runner.status(view.id)!.steps[0].sessionId!)?.bridge?.promptActive === true, "the step's turn to park");
  const childId = runner.status(view.id)!.steps[0].sessionId!;
  assert.equal(runner.cancel(view.id), true);
  const done = (await runner.wait(view.id, 5_000))!;
  assert.equal(done.status, "cancelled");
  await waitFor(() => manager.get(childId)?.exited === true, "the child to retire");
  await waitFor(() => updatesOf(ws, "subagent_state_update").some((e) => (e.update as { subagentSessionId: string; state: string }).subagentSessionId === childId && (e.update as { state: string }).state === "cancelled"), "the cancelled state on the parent");
  assert.equal(runner.cancel(view.id), false, "a finished run cannot be cancelled again");
});

await test("the loopback key resolves the caller and a step may not start a workflow", async () => {
  const url = runner.urlFor(parent);
  const [, key, sid] = /\/wf\/([0-9a-f]+)\/([^/]+)$/.exec(url)!;
  assert.equal(sid, parent.id);
  assert.equal(runner.resolveCaller(key, parent.id), parent);
  assert.equal(runner.resolveCaller("0".repeat(key.length), parent.id), null);
  assert.equal(runner.resolveCaller(key, "nope"), null);
  const child = manager.create(profile, "fake", project, undefined, undefined, undefined, undefined, undefined, { parentSessionId: parent.id, title: "step" });
  await child.bridge!.ready;
  assert.throws(() => runner.start(child, { name: "x", steps: [{ name: "a", prompt: "echo:x" }] }), (e: unknown) => e instanceof WorkflowError && e.status === 409);
  manager.retire(child);
});

await test("a step is never handed the workflow server", () => {
  mcpServers.ensureBuiltin("workflow");
  const links = { mcpServerIds: ["builtin:workflow"] };
  const top = mcpServersFor(links, project, getConfig(), workflowServer(parent, runner));
  assert.equal(top.length, 1);
  assert.equal(top[0].name, "workflow");
  assert.ok((top[0] as { env: { name: string; value: string }[] }).env.some((e) => e.name === "WORKFLOW_URL" && e.value.endsWith(`/${parent.id}`)));
  assert.equal(mcpServersFor(links, project, getConfig(), null).length, 0);
});

await test("bad definitions are refused before anything spawns", () => {
  assert.throws(() => runner.start(parent, { name: "x", steps: [] }), /invalid workflow/);
  assert.throws(() => runner.start(parent, { name: "x", steps: [{ name: "a", prompt: "{{inputs.q}}" }] }), /inputs that were not given: q/);
  assert.throws(() => runner.start(parent, { name: "x", steps: [{ name: "a", prompt: "x", dependsOn: ["zz"] }] }), /invalid workflow/);
});

await test("the parent's process going away cancels its runs", async () => {
  const view = runner.start(parent, { name: "orphan", steps: [{ name: "ask", prompt: "needs permission" }] });
  await waitFor(() => runner.status(view.id)?.steps[0].sessionId != null, "the step to spawn");
  manager.retire(parent);
  const done = (await runner.wait(view.id, 5_000))!;
  assert.equal(done.status, "cancelled");
  assert.match(done.error ?? "", /process gone/);
});

await test("recoverAtBoot closes what the last process left running", () => {
  db.insert(schema.workflowRuns)
    .values({
      id: "stale", parentSessionId: parent.id, name: "stale", definition: {}, inputs: {}, status: "running", error: null,
      steps: [{ name: "s", status: "running", sessionId: "gone", attempt: 1, output: null, error: null, startedAt: 1, endedAt: null }],
      createdAt: 1, endedAt: null,
    })
    .run();
  const before = updatesOf(ws, "subagent_state_update").length;
  new WorkflowRunner(manager, { port: 4999 }).recoverAtBoot();
  const row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, "stale")).get()!;
  assert.equal(row.status, "failed");
  assert.equal(row.steps[0].status, "failed");
  // The parent is retired but its log is not: the disconnect is journaled.
  assert.equal(manager.journal(parent.id)!.events.filter((e) => e.ev === "update" && e.update.sessionUpdate === "subagent_state_update").length, before + 1);
});

for (const s of manager.list()) if (!s.exited) manager.retire(manager.get(s.id)!);
manager.shutdown();
console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
