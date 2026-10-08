// Self-check for routes/harness.ts — the loopback the `harness` MCP server
// drives. The key in the path is the credential and the session id after it is
// the only thread the call acts for; behind that, one generic proxy
// re-dispatches to the app's own `/api` route, so the MCP is the client's equal.
// Run: pnpm test:harness
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, tasks as tasksTable } from "../src/db/index.js";
import { ensureDefaultBoard } from "../src/boards.js";
import { libraryRoutes } from "../src/routes/library.js";
import { profileRoutes } from "../src/routes/profiles.js";
import { taskRoutes } from "../src/routes/tasks.js";
import { harnessRoutes } from "../src/routes/harness.js";
import type { WorkflowRunner } from "../src/workflows.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

const KEY = "test-key";
const SESSION = "sess-1";

/* The real routes the browser uses, mounted beside the harness loopback so the
   proxy forwards into them exactly as the running server would. The task and
   library routes only reach for `sessions` / `tasks` on routes this test does
   not call, so empty stubs stand in. */
const app = new Hono();
libraryRoutes(app, { sessions: {} as never });
profileRoutes(app, { sessions: {} as never });
taskRoutes(app, { sessions: {} as never, tasks: {} as never });
const runner = {
  resolveCaller: (key: string, sessionId: string) => (key === KEY && sessionId === SESSION ? { id: SESSION } : null),
} as unknown as WorkflowRunner;
harnessRoutes(app, { runner });

const base = `/hm/${KEY}/${SESSION}/api`;
const call = (path: string, init?: RequestInit) => app.request(`${base}${path}`, init);
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

await ensureDefaultBoard();
await db.delete(tasksTable);

console.log("harness loopback");

await test("an unknown key is not found, whatever the route", async () => {
  assert.equal((await app.request(`/hm/wrong/${SESSION}/api/tasks`)).status, 404);
  assert.equal((await app.request(`/hm/${KEY}/other/api/tasks`)).status, 404);
});

await test("a GET forwards to the real route", async () => {
  const res = await call("/boards");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { boards: unknown[]; statuses: unknown[] };
  assert.ok(body.boards.length >= 1, "at least the default board");
  assert.ok(body.statuses.length >= 1, "and its columns");
});

await test("a task is created, read back by its key, and updated", async () => {
  const created = await call("/tasks", json("POST", { title: "Ship everything", priority: "high" }));
  assert.equal(created.status, 201);
  const task = (await created.json()) as { id: string; number: number; boardId: string; priority: string };

  const boards = (await (await call("/boards")).json()) as { boards: { id: string; key: string }[] };
  const key = `${boards.boards.find((b) => b.id === task.boardId)!.key}-${task.number}`;
  const byKey = await call(`/tasks/by-key/${key}`);
  assert.equal(byKey.status, 200);
  assert.equal(((await byKey.json()) as { id: string }).id, task.id);

  const patched = await call(`/tasks/${task.id}`, json("PATCH", { title: "Shipped", priority: "lowest" }));
  assert.equal(patched.status, 200);
  const updated = (await patched.json()) as { title: string; priority: string };
  assert.equal(updated.title, "Shipped");
  assert.equal(updated.priority, "lowest");
});

await test("a comment lands on the task, and a bad body is a 400", async () => {
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.title, "Shipped"));
  assert.ok(task);
  assert.equal((await call(`/tasks/${task.id}/comments`, json("POST", { body: "done" }))).status, 201);
  const detail = (await (await call(`/tasks/${task.id}`)).json()) as { comments: { body: string }[] };
  assert.deepEqual(detail.comments.map((c) => c.body), ["done"]);

  assert.equal((await call("/tasks", json("POST", { title: "" }))).status, 400);
});

await test("the library forwards create, list and delete", async () => {
  const created = await call("/skills", json("POST", { name: "Harness test skill", path: "/tmp/skill" }));
  assert.equal(created.status, 201);
  const row = (await created.json()) as { id: string };
  const list = (await (await call("/skills")).json()) as { id: string }[];
  assert.ok(list.some((s) => s.id === row.id));
  assert.equal((await call(`/skills/${row.id}`, json("DELETE"))).status, 200);
});

await test("a profile is created and its credential never leaves the server", async () => {
  const created = await call("/profiles", json("POST", { name: "Harness test", agents: { daedalus: {} }, apiKey: "sk-secret" }));
  assert.equal(created.status, 201);
  const profile = (await created.json()) as Record<string, unknown>;
  assert.equal(profile.hasApiKey, true);
  assert.equal("apiKey" in profile, false);
});

console.log(`harness: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
