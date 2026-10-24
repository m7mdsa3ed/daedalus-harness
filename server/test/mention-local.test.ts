// Self-check for the local mention kinds (src/mentions/resolvers/{kb,run,term,file-range}.ts
// and local-search.ts): a knowledge entry by unique id prefix and only inside its own
// project, a workflow run's status and step outcomes, a routine run, the output of a `!`
// command (last, or by id) with its tail kept when long, line ranges numbered and bounded,
// and the search lists. Run: pnpm test:mention-local
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });

const { db, schema } = await import("../src/db/index.js");
const { expandMentions } = await import("../src/mentions/index.js");
const { searchLocal } = await import("../src/mentions/local-search.js");
const { SessionJournal } = await import("../src/session-journal.js");
type ThreadEvent = import("../src/protocol.js").ThreadEvent;

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "mention-local-"));
writeFileSync(join(dir, "a.ts"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));

await db.insert(schema.projects).values([
  { id: "p1", name: "One", cwd: dir },
  { id: "p2", name: "Two", cwd: dir },
]);
const scope = { projectId: "p1", cwd: dir, sessionId: "s1" };
const expand = (text: string, extra: object = {}) => expandMentions(text, { ...scope, ...extra });

const now = Date.now();
await db.insert(schema.knowledge).values([
  { id: "aaaa1111-0000-0000-0000-000000000001", projectId: "p1", title: "Deploy notes", content: "ssh in, then pm2 restart", tags: ["ops"], createdAt: now, updatedAt: now },
  { id: "aaaa2222-0000-0000-0000-000000000002", projectId: "p1", title: "Other", content: "x", tags: [], createdAt: now, updatedAt: now - 1000 },
  { id: "bbbb1111-0000-0000-0000-000000000003", projectId: "p2", title: "Secret of two", content: "elsewhere", tags: [], createdAt: now, updatedAt: now },
]);

await db.insert(schema.sessions).values({
  id: "s1", profileId: "p", projectId: "p1", agentId: "claude-code", model: "m", effort: "", title: "T",
  createdAt: now, lastActivityAt: now, deletedAt: null,
});
const journal = new SessionJournal();
const owner = { id: "s1", eventCount: 0 };
const shell = (shellId: string, command: string, output: string, exitCode: number): ThreadEvent =>
  ({ ev: "update", update: { sessionUpdate: "_daedalus/shell", shellId, status: "done", command, output, exitCode } }) as unknown as ThreadEvent;
journal.append(owner, shell("11111111-aaaa", "pnpm test", "ok\n".repeat(10), 0));
journal.append(owner, shell("22222222-bbbb", "pnpm build", `${"noise\n".repeat(2000)}ERROR: it broke\n`, 1));
await journal.flush();

await db.insert(schema.wfRuns).values({
  id: "cccc3333-0000-0000-0000-000000000004", parentSessionId: "s1", projectId: "p1", name: "ship it",
  spec: {}, status: "failed", error: "step b failed", result: { done: false }, createdAt: now, endedAt: now + 5,
});
await db.insert(schema.wfEvents).values([
  { runId: "cccc3333-0000-0000-0000-000000000004", seq: 1, at: now, key: "a", kind: "step_completed", payload: { kind: "step_completed", name: "a", output: "A is fine" } },
  { runId: "cccc3333-0000-0000-0000-000000000004", seq: 2, at: now, key: "b", kind: "step_failed", payload: { kind: "step_failed", name: "b", error: "boom" } },
]);

console.log("mention-local");

await test("a knowledge entry is read by its id prefix", async () => {
  const out = await expand("@kb:aaaa1111");
  assert.match(out.text, /Deploy notes/);
  assert.match(out.text, /Tags: ops/);
  assert.match(out.text, /pm2 restart/);
});

await test("a prefix two entries share, or another project's entry, answers nothing", async () => {
  assert.equal((await expand("@kb:aaaa")).text, "");
  assert.equal((await expand("@kb:bbbb1111")).text, "");
  assert.ok((await expand("@kb:bbbb1111")).claimed.has("kb:bbbb1111"));
});

await test("a workflow run reads its status, error, steps and result", async () => {
  const out = await expand("@run:cccc3333");
  assert.match(out.text, /Workflow run "ship it"/);
  assert.match(out.text, /Status: failed/);
  assert.match(out.text, /a: completed — A is fine/);
  assert.match(out.text, /b: FAILED — boom/);
  assert.match(out.text, /"done": false/);
});

await test("@term:last is the newest run, with the tail of a long output", async () => {
  const out = await expand("@term:last", { budget: 2000 });
  assert.match(out.text, /\$ pnpm build/);
  assert.match(out.text, /\(exit 1\)/);
  assert.match(out.text, /ERROR: it broke/);
  assert.match(out.text, /earlier output omitted/);
});

await test("@term:<id> picks one run by prefix", async () => {
  const out = await expand("@term:11111111");
  assert.match(out.text, /\$ pnpm test/);
  assert.doesNotMatch(out.text, /pnpm build/);
});

await test("a line range is numbered and bounded", async () => {
  const out = await expand("see @a.ts:10-12 and @a.ts:49-99");
  assert.match(out.text, /a\.ts lines 10-12 of 50/);
  assert.match(out.text, /10\| line 10\n11\| line 11\n12\| line 12/);
  assert.match(out.text, /lines 49-50 of 50/);
  assert.ok(out.claimed.has("file:a.ts:10-12"));
});

await test("a single line, a missing file, a binary file and a range past the end answer nothing wrong", async () => {
  assert.match((await expand("@a.ts:7")).text, /7\| line 7/);
  assert.equal((await expand("@nope.ts:1-2")).text, "");
  assert.equal((await expand("@bin.dat:1-2")).text, "");
  assert.equal((await expand("@a.ts:60-70")).text, "");
  assert.equal((await expand("@a.ts:9-3")).text, "", "a backwards range is not a range");
});

await test("search lists entries, runs and commands", async () => {
  assert.deepEqual((await searchLocal("p1", "s1", "kb", "deploy")).map((m) => m.ref), ["aaaa1111"]);
  assert.equal((await searchLocal("p1", "s1", "kb", "")).length, 2, "the other project's entry is not listed");
  assert.equal((await searchLocal("p1", "s1", "run", "ship"))[0]?.ref, "cccc3333");
  const term = await searchLocal("p1", "s1", "term", "");
  assert.equal(term[0]?.ref, "last");
  assert.ok(term.some((m) => m.label === "pnpm test" && m.description === "exit 0"));
});

rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`mention-local: ${failures.length} failed`);
  process.exit(1);
}
console.log(`mention-local: ${passed} ok`);
process.exit(0);
