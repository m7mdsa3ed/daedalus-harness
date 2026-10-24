// The workflow engine against a REAL SessionManager, real Postgres and real child threads, with a
// scripted ACP agent standing in for the model. Everything else in test:workflow-* runs on fakes.
// Asserts: a script run spawns child threads that reply, parallel + schema output work, the journal
// and RunView agree, a second boot (a new SessionManager + engine over the same database) resumes a
// run mid-flight WITHOUT re-running the step that already completed, and approve() parks and resolves.
// Run: pnpm test:workflow-e2e
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../src/config.js";
import type { Profile } from "../src/profiles.js";

const dataDir = process.env.DAEDALUS_DATA_DIR!;
rmSync(dataDir, { recursive: true, force: true });
const cwd = join(dataDir, "ws");
mkdirSync(cwd, { recursive: true });
const logPath = join(dataDir, "stub.log");
const gatePath = join(dataDir, "gate");
writeFileSync(logPath, "");
writeFileSync(gatePath, "closed");
const stubPath = join(dataDir, "stub-agent.mjs");
// Replies "out:<first line of the prompt>"; "json:" prompts reply with a fenced JSON object;
// "hold:" prompts wait for the gate file, so a run can be caught mid-step.
writeFileSync(
  stubPath,
  `import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [log, gate] = process.argv.slice(2);
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) return;
  switch (msg.method) {
    case "initialize": return reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
    case "session/new": return reply(msg.id, { sessionId: "stub-" + process.pid + "-" + Math.random().toString(36).slice(2, 8) });
    case "session/resume": case "session/load": return reply(msg.id, {});
    case "session/prompt": {
      const { sessionId, prompt } = msg.params;
      const text = prompt.find((b) => b.type === "text")?.text ?? "";
      const first = text.split("\\n")[0];
      appendFileSync(log, JSON.stringify({ method: "prompt", first }) + "\\n");
      const finish = () => {
        const body = first.startsWith("json:") ? "\`\`\`json\\n" + JSON.stringify({ label: first.slice(5), n: first.length }) + "\\n\`\`\`" : "out:" + first;
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } } } });
        reply(msg.id, { stopReason: "end_turn" });
      };
      if (first.startsWith("hold:")) {
        const t = setInterval(() => { if (readFileSync(gate, "utf8") === "open") { clearInterval(t); finish(); } }, 20);
        return;
      }
      return finish();
    }
    default: return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no " + msg.method } });
  }
});
`,
);
writeJson(join(dataDir, "agents.json"), [
  { id: "stub", name: "Stub", command: process.execPath, args: [stubPath, logPath, gatePath], env: {} },
]);

const { SessionManager } = await import("../src/sessions.js");
const { seedAgents } = await import("../src/registry.js");
const { createProfile } = await import("../src/profiles.js");
const { createProject } = await import("../src/projects.js");
const { WorkflowEngine } = await import("../src/workflows/engine.js");
const { Journal } = await import("../src/workflows/journal.js");

const profile: Profile = await createProfile({ name: "test", agents: { stub: {} }, baseUrl: "", apiKey: "k", models: [], defaultModel: "", smallModel: "", logoUrl: "" } as never);
const project = await createProject({ name: "ws", cwd, description: null } as never);
await seedAgents();

const prompts = () =>
  readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { first: string }).first);
const waitFor = async (predicate: () => boolean | Promise<boolean>, what: string, tries = 300) => {
  for (let i = 0; i < tries && !(await predicate()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await predicate(), `timed out waiting for ${what}`);
};

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const manager = new SessionManager({}, 60);
await manager.ready;
const engine = new WorkflowEngine(manager, { port: 0 });
manager.setWorkflowRunner(engine);
const parent = await manager.create(profile, "stub", project);
await parent.bridge!.ready;

await test("a script run spawns real child threads and returns their replies", async () => {
  const view = await engine.start(parent, {
    script: `export const meta = { name: 'e2e-basic', description: 'basic', phases: [{ title: 'Go' }] }
phase('Go')
const a = await agent('alpha', { label: 'a' })
const [b, c] = await parallel([() => agent('beta', { label: 'b' }), () => agent('gamma', { label: 'c' })])
return { a, b, c }`,
    notify: false,
  });
  const done = await engine.wait(view.id, 30_000);
  assert.ok(done);
  assert.equal(done.status, "completed", done.error ?? "");
  assert.deepEqual(done.result, { a: "out:alpha", b: "out:beta", c: "out:gamma" });
  assert.equal(done.steps.length, 3);
  assert.ok(done.steps.every((s) => s.status === "completed" && s.sessionId), "every step has a child thread");
  // the children are real rows with parent_session_id, retired after their turn
  for (const s of done.steps) assert.equal(manager.get(s.sessionId!)?.parentSessionId, parent.id);
});

await test("a schema step returns parsed JSON and {{templates}} chain through a definition", async () => {
  const view = await engine.start(parent, {
    definition: {
      name: "e2e-graph",
      phases: [
        { name: "one", steps: [{ name: "first", prompt: "json:hello", output: { schema: { type: "object", properties: { label: { type: "string" }, n: { type: "number" } }, required: ["label", "n"] } } }] },
        { name: "two", steps: [{ name: "second", prompt: "echo {{steps.first.output.label}}" }] },
      ],
    },
    args: {},
  });
  const done = await engine.wait(view.id, 30_000);
  assert.ok(done);
  assert.equal(done.status, "completed", done.error ?? "");
  const first = done.steps.find((s) => s.name === "first")!;
  assert.deepEqual(first.output, { label: "hello", n: 10 });
  assert.equal(done.steps.find((s) => s.name === "second")!.output, "out:echo hello");
});

await test("the persisted journal folds to the same view the engine reports", async () => {
  const view = await engine.start(parent, {
    script: `export const meta = { name: 'e2e-journal', description: 'j' }
log('hello')
state.set('k', { b: 1, a: 2 })
const r = await agent('journaled', { label: 'j' })
return r`,
  });
  const done = await engine.wait(view.id, 30_000);
  assert.equal(done?.status, "completed");
  const folded = await new Journal().view(view.id);
  assert.ok(folded);
  assert.equal(folded.status, "completed");
  assert.equal(folded.steps.length, 1);
  assert.equal(folded.steps[0]!.output, "out:journaled");
  assert.deepEqual(folded.state, { k: { a: 2, b: 1 } });
  assert.ok(folded.logs.includes("hello"));
  assert.equal(folded.result, "out:journaled");
});

await test("a budget stops new agents and ends the run budget_exceeded with the partial result", async () => {
  const view = await engine.start(parent, {
    script: `export const meta = { name: 'e2e-budget', description: 'b' }
const out = []
for (let i = 0; i < 5; i++) out.push(await agent('step' + i, { label: 's' + i }))
return out`,
    budgets: { agents: 2 },
  });
  const done = await engine.wait(view.id, 30_000);
  assert.equal(done?.status, "budget_exceeded", done?.error ?? "");
  assert.equal(done.steps.filter((s) => s.status === "completed").length, 2);
});

await test("approve() parks on the parent and a user answer resolves it", async () => {
  const view = await engine.start(parent, {
    script: `export const meta = { name: 'e2e-approve', description: 'a' }
const choice = await approve('ship it?', { options: ['yes', 'no'] })
return choice`,
  });
  await waitFor(async () => ((await engine.status(view.id))?.gates ?? []).some((g) => g.kind === "approval" && g.status === "waiting"), "the approval to park");
  const gate = (await engine.status(view.id))!.gates.find((g) => g.kind === "approval")!;
  assert.equal(await engine.answerApproval(parent.id, view.id, gate.key, "yes", "user"), true);
  assert.equal(await engine.answerApproval(parent.id, view.id, gate.key, "no", "user"), false, "a second answer is refused");
  const done = await engine.wait(view.id, 30_000);
  assert.equal(done?.status, "completed", done?.error ?? "");
  assert.equal(done.result, "yes");
});

await test("a restart resumes a run mid-flight and does NOT re-run the completed step", async () => {
  writeFileSync(gatePath, "closed");
  const before = prompts().length;
  const view = await engine.start(parent, {
    script: `export const meta = { name: 'e2e-resume', description: 'r' }
const first = await agent('once-only', { label: 'first' })
const second = await agent('hold:second', { label: 'second' })
return { first, second }`,
  });
  // the first step completes; the second is held inside the agent
  await waitFor(() => prompts().slice(before).includes("hold:second"), "the second step to reach the agent");
  await waitFor(async () => ((await engine.status(view.id))?.steps ?? []).some((s) => s.name === "first" && s.status === "completed"), "the first step to complete");

  // ---- the server goes down mid-run: detach, do not finish ----
  await manager.shutdown();
  engine.shutdown();
  const row = await new Journal().header(view.id);
  assert.equal(row?.status, "running", "a shutdown must leave the run running so the next boot resumes it");

  // ---- the server comes back: a new manager + engine over the same database ----
  writeFileSync(gatePath, "open");
  const manager2 = new SessionManager({}, 60);
  await manager2.ready;
  const engine2 = new WorkflowEngine(manager2, { port: 0 });
  manager2.setWorkflowRunner(engine2);
  await engine2.recoverAtBoot({ resume: false });
  await engine2.resumeRecovered();
  const done = await engine2.wait(view.id, 40_000);
  assert.ok(done);
  assert.equal(done.status, "completed", done.error ?? "");
  const result = done.result as { first: string; second: string };
  assert.equal(result.first, "out:once-only", "the completed step is answered from the journal");
  // onRestart defaults to "resume": the in-flight step's thread is revived and told to carry on (the stub echoes it).
  assert.equal(result.second, "out:Continue where you left off and finish the task.");
  const sent = prompts().slice(before);
  assert.equal(sent.filter((p) => p === "once-only").length, 1, "the completed step must never be re-prompted");
  assert.equal(sent.filter((p) => p === "hold:second").length, 1, "the held prompt is not sent a second time on resume");
  const events = await new Journal().events(view.id);
  assert.ok(events.some((e) => e.payload.kind === "run_recovered"), "boot recovery is journaled");
  await manager2.shutdown();
  engine2.shutdown();
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
