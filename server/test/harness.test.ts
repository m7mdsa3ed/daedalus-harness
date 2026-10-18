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
import { mcpServers } from "../src/library.js";
import { mcpServersFor, videoMissing, videoServer } from "../src/sessions.js";

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
// Stands in for POST /api/files: echoes the raw body and the headers that crossed.
app.post("/api/echo-upload", async (c) =>
  c.json({ filename: c.req.header("x-filename") ?? null, other: c.req.header("x-other") ?? null, bytes: (await c.req.arrayBuffer()).byteLength }),
);

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

await test("the proxy forwards x-filename for raw uploads, and no other caller header", async () => {
  const res = await call("/echo-upload", {
    method: "POST",
    headers: { "content-type": "video/mp4", "x-filename": encodeURIComponent("demo v1.mp4"), "x-other": "nope" },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  assert.deepEqual(await res.json(), { filename: "demo%20v1.mp4", other: null, bytes: 4 });
});

console.log("builtin:video");

const source = { harnessUrlFor: (s: { id: string }) => `http://127.0.0.1:1/hm/k/${s.id}` };
const project = { id: "p1" } as never;

await test("the row has the fixed id and is injected once", async () => {
  const a = await mcpServers.ensureBuiltin("video");
  const b = await mcpServers.ensureBuiltin("video");
  assert.equal(a.id, "builtin:video");
  assert.equal(b.id, a.id);
});

await test("a linked row resolves to video-mcp over the thread's loopback, with VIDEO_* passed through", async () => {
  process.env.VIDEO_TTS = "silent";
  process.env.ELEVENLABS_API_KEY = "el";
  process.env.UNRELATED_SECRET = "x";
  process.env.DAEDALUS_TOKEN = "bearer";
  process.env.OPENAI_API_KEY = "sk";
  process.env.XVIDEO_LOOKALIKE = "y";
  const server = videoServer({ id: SESSION }, source, process.argv[1]); // any file that exists
  const { servers } = await mcpServersFor({ mcpServerIds: ["builtin:video"] }, project, {} as never, null, null, null, null, server);
  if (videoMissing(process.argv[1])) {
    // No ffmpeg here: the feature degrades to "not advertised", which is the behaviour under test.
    assert.equal(server, null);
    assert.equal(servers.length, 0);
    return;
  }
  assert.ok(server);
  assert.equal(server.name, "video");
  assert.deepEqual(server.args, [process.argv[1]]);
  const env = Object.fromEntries(server.env.map((e) => [e.name, e.value]));
  assert.equal(env.HARNESS_URL, `http://127.0.0.1:1/hm/k/${SESSION}`);
  assert.equal(env.VIDEO_TTS, "silent");
  // The child gets the loopback URL and the provider passthrough, nothing else.
  assert.deepEqual(Object.keys(env).sort(), ["ELEVENLABS_API_KEY", "HARNESS_URL", "VIDEO_TTS"]);
  assert.deepEqual(servers.map((s) => s.name), ["video"]);
});

await test("not advertised when the dist is missing or ffmpeg is", async () => {
  assert.equal(videoServer({ id: SESSION }, source, "/nonexistent/video-mcp/dist/index.js"), null);
  const { servers } = await mcpServersFor({ mcpServerIds: ["builtin:video"] }, project, {} as never, null, null, null, null, null);
  assert.equal(servers.length, 0);
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.equal(videoServer({ id: SESSION }, source, process.argv[1]), null);
    assert.match(videoMissing(process.argv[1]) ?? "", /ffmpeg/);
  } finally {
    process.env.PATH = path;
  }
});

await test("a missing entry is logged once per process, not per spawn", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    for (let i = 0; i < 3; i++) videoServer({ id: SESSION }, source, "/nonexistent/once/index.js");
  } finally {
    console.log = log;
  }
  const mine = lines.filter((l) => l.includes("builtin:video"));
  assert.equal(mine.length, videoMissing("/nonexistent/once/index.js")?.includes("ffmpeg") ? 0 : 1);
  assert.ok(mine.every((l) => /missing|ffmpeg/.test(l)));
});

console.log(`harness: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
