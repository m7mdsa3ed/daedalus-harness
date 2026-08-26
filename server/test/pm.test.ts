// HTTP-level self-check for the PM module: drives the real routes through
// Hono's app.request() against a fresh database. pmRoutes is mounted on a bare
// Hono app here — importing src/index.ts would start the HTTP/WS servers, and
// auth is index.ts's middleware, not the module's.
// Run: pnpm test (DAEDALUS_DATA_DIR is set by the npm script — static imports
// are hoisted, so setting it here would be too late).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

// A clean data dir IS the seed: db/index.ts migrates at import.
rmSync(process.env.DAEDALUS_DATA_DIR!, { recursive: true, force: true });

const { Hono } = await import("hono");
const { pmRoutes } = await import("../src/pm/routes.js");
const { db, pmComments, pmSprints, pmTasks, pmTaskLabels } = await import("../src/db/index.js");
const { eq } = await import("drizzle-orm");

const app = new Hono();
app.route("/api", pmRoutes);

/* eslint-disable @typescript-eslint/no-explicit-any */
const api = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> => {
  const res = await app.request(`/api${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const ok = async (method: string, path: string, body?: unknown, expect = 200) => {
  const res = await api(method, path, body);
  assert.equal(res.status, expect, `${method} ${path} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

// --- board defaults on create ------------------------------------------------

const board = await ok("POST", "/boards", { name: "Main", keyPrefix: "dae" }, 201);
assert.equal(board.keyPrefix, "DAE", "prefix is uppercased");
assert.equal(board.nextKey, 1);
assert.equal(board.defaultView, "kanban");
assert.deepEqual(
  board.columns.map((c: any) => [c.name, c.category]),
  [["To do", "open"], ["In progress", "active"], ["Done", "done"]],
  "seeded columns",
);
assert.deepEqual(
  board.issueTypes.map((t: any) => [t.name, t.isEpic]),
  [["Task", false], ["Story", false], ["Bug", false], ["Epic", true]],
  "seeded issue types",
);
const [todo, , done] = board.columns;

// keyPrefix collision -> 400 (case-insensitive: it uppercases first).
assert.equal((await api("POST", "/boards", { name: "Clash", keyPrefix: "Dae" })).status, 400);

// --- key sequence ------------------------------------------------------------

const t1 = await ok("POST", `/boards/${board.id}/tasks`, { title: "first" }, 201);
const t2 = await ok("POST", `/boards/${board.id}/tasks`, { title: "second" }, 201);
const t3 = await ok("POST", `/boards/${board.id}/tasks`, { title: "third" }, 201);
assert.deepEqual([t1.key, t2.key, t3.key], ["DAE-1", "DAE-2", "DAE-3"]);
assert.deepEqual([t1.order, t2.order, t3.order], [0, 1000, 2000], "gap-1000 appends");

// --- move + rank renormalization --------------------------------------------

// Alternately squeezing t3 and t2 into index 1 halves the gap each time; once
// it closes to <=1 the column renormalizes to i*1000 and keeps going.
for (let i = 0; i < 12; i++) {
  const id = i % 2 === 0 ? t3.id : t2.id;
  await ok("POST", `/boards/${board.id}/tasks/${id}/move`, { columnId: todo.id, index: 1 });
}
const afterMoves = await ok("GET", `/boards/${board.id}/tasks`);
const col = afterMoves.tasks.filter((t: any) => t.columnId === todo.id);
assert.equal(col.length, 3);
const orders = col.map((t: any) => t.order);
assert.equal(new Set(orders).size, 3, "orders stay distinct after renormalization");
assert.deepEqual(orders, [...orders].sort((a: number, b: number) => a - b), "sorted by order");
assert.ok(Math.max(...orders) - Math.min(...orders) >= 2, "gaps were reopened");
assert.equal(col[0].id, t1.id, "t1 never moved off the head");

// --- custom-field validation -------------------------------------------------

const field = await ok(
  "POST",
  `/boards/${board.id}/custom-fields`,
  { name: "Env", type: "select", options: ["dev", "prod"] },
  201,
);
assert.equal(
  (await api("PATCH", `/boards/${board.id}/tasks/${t1.id}`, { customFieldValues: { [field.id]: "staging" } })).status,
  400,
  "value outside the select's options is rejected",
);
assert.equal(
  (await api("PATCH", `/boards/${board.id}/tasks/${t1.id}`, { customFieldValues: { nope: "x" } })).status,
  400,
  "unknown field id is rejected",
);
const patched = await ok("PATCH", `/boards/${board.id}/tasks/${t1.id}`, {
  customFieldValues: { [field.id]: "prod" },
});
assert.equal(patched.customFieldValues[field.id], "prod");
assert.equal((await api("POST", `/boards/${board.id}/custom-fields`, { name: "Bad", type: "select" })).status, 400, "select without options is rejected");

// --- bulk ops ----------------------------------------------------------------

const bulk = await ok("POST", `/boards/${board.id}/tasks/bulk`, {
  ids: [t2.id, t3.id],
  op: { type: "patch", patch: { priority: 4 } },
});
assert.equal(bulk.length, 2);
assert.ok(bulk.every((t: any) => t.priority === 4));
await ok("POST", `/boards/${board.id}/tasks/bulk`, { ids: [t3.id], op: { type: "archive" } });
const live = await ok("GET", `/boards/${board.id}/tasks`);
assert.ok(!live.tasks.some((t: any) => t.id === t3.id), "archived task leaves the default shelf");
const shelf = await ok("GET", `/boards/${board.id}/tasks?archived=1`);
assert.deepEqual(shelf.tasks.map((t: any) => t.id), [t3.id], "…and shows on the archived one");
await ok("POST", `/boards/${board.id}/tasks/bulk`, { ids: [t3.id], op: { type: "unarchive" } });

// --- column delete requires moveTasksTo and moves the tasks ------------------

assert.equal((await api("DELETE", `/boards/${board.id}/columns/${todo.id}`)).status, 400);
assert.equal(
  (await api("DELETE", `/boards/${board.id}/columns/${todo.id}?moveTasksTo=${todo.id}`)).status,
  400,
  "target must be a different column",
);
const spare = await ok("POST", `/boards/${board.id}/columns`, { name: "Doomed" }, 201);
await ok("POST", `/boards/${board.id}/tasks/${t2.id}/move`, { columnId: spare.id, index: 0 });
await ok("DELETE", `/boards/${board.id}/columns/${spare.id}?moveTasksTo=${todo.id}`);
const moved = await ok("GET", `/boards/${board.id}/tasks/${t2.id}`);
assert.equal(moved.columnId, todo.id, "tasks land in moveTasksTo, not the void");

// --- comments + activity pagination ------------------------------------------

for (const text of ["one", "two", "three"]) {
  await ok("POST", `/boards/${board.id}/tasks/${t1.id}/comments`, { author: "mo", bodyMd: text }, 201);
}
const page1 = await ok("GET", `/boards/${board.id}/tasks/${t1.id}/comments?limit=2`);
assert.equal(page1.total, 3);
assert.deepEqual(page1.comments.map((c: any) => c.bodyMd), ["one", "two"]);
const page2 = await ok("GET", `/boards/${board.id}/tasks/${t1.id}/comments?limit=2&offset=2`);
assert.deepEqual(page2.comments.map((c: any) => c.bodyMd), ["three"]);

const activity = await ok("GET", `/boards/${board.id}/tasks/${t1.id}/activity`);
assert.equal(activity[0].field, "created");
assert.equal(activity[0].seq, 1);
assert.ok(activity.length >= 2, "the customFieldValues patch was journaled");
const tail = await ok("GET", `/boards/${board.id}/tasks/${t1.id}/activity?after=1`);
assert.equal(tail[0].seq, 2, "?after= is a seq cursor");
assert.equal(tail.length, activity.length - 1);

// --- cascade cleanup: delete label -> join rows gone --------------------------

const label = await ok("POST", `/boards/${board.id}/labels`, { name: "urgent" }, 201);
await ok("PATCH", `/boards/${board.id}/tasks/${t1.id}`, { labelIds: [label.id] });
assert.deepEqual((await ok("GET", `/boards/${board.id}/tasks/${t1.id}`)).labelIds, [label.id]);
await ok("DELETE", `/boards/${board.id}/labels/${label.id}`);
assert.deepEqual(
  (await ok("GET", `/boards/${board.id}/tasks/${t1.id}`)).labelIds,
  [],
  "the join row went with the label",
);

// --- automations: A->B->A terminates ------------------------------------------

const abBoard = await ok("POST", "/boards", { name: "Loop", keyPrefix: "LOOP" }, 201);
await ok("PUT", `/boards/${abBoard.id}/automations/A`, {
  name: "A",
  when: { type: "field_changed", field: "priority" },
  then: [{ type: "set_due_date", dueDate: 111 }],
});
await ok("PUT", `/boards/${abBoard.id}/automations/B`, {
  name: "B",
  when: { type: "field_changed", field: "dueDate" },
  then: [{ type: "set_priority", priority: 3 }],
});
const loopTask = await ok("POST", `/boards/${abBoard.id}/tasks`, { title: "ping" }, 201);
await ok("PATCH", `/boards/${abBoard.id}/tasks/${loopTask.id}`, { priority: 1 });
const looped = await ok("GET", `/boards/${abBoard.id}/tasks/${loopTask.id}`);
assert.equal(looped.dueDate, 111, "A fired");
assert.equal(looped.priority, 3, "B fired");
// A is deduped on the chain, so priority stays 3 and this line was reached at all.

// --- automations: cascade depth cap -------------------------------------------

const capBoard = await ok("POST", "/boards", { name: "Deep", keyPrefix: "DEEP" }, 201);
const story = capBoard.issueTypes.find((t: any) => t.name === "Story");
const capLabel = await ok("POST", `/boards/${capBoard.id}/labels`, { name: "L" }, 201);
const chain: [string, object][] = [
  ["R1", { when: { type: "field_changed", field: "priority" }, then: [{ type: "set_due_date", dueDate: 5 }] }],
  ["R2", { when: { type: "field_changed", field: "dueDate" }, then: [{ type: "set_assignees", assignees: ["a"] }] }],
  ["R3", { when: { type: "field_changed", field: "assignees" }, then: [{ type: "set_type", typeId: story.id }] }],
  ["R4", { when: { type: "field_changed", field: "typeId" }, then: [{ type: "add_label", labelId: capLabel.id }] }],
  // tasks.ts journals label edits under the pseudo-field "labels".
  ["R5", { when: { type: "field_changed", field: "labels" }, then: [{ type: "archive" }] }],
];
for (const [id, rule] of chain) {
  await ok("PUT", `/boards/${capBoard.id}/automations/${id}`, { name: id, ...rule });
}
const capTask = await ok("POST", `/boards/${capBoard.id}/tasks`, { title: "deep" }, 201);
await ok("PATCH", `/boards/${capBoard.id}/tasks/${capTask.id}`, { priority: 2 });
const capped = await ok("GET", `/boards/${capBoard.id}/tasks/${capTask.id}`);
assert.equal(capped.dueDate, 5, "depth 1 applied");
assert.deepEqual(capped.assignees, ["a"], "depth 2 applied");
assert.equal(capped.typeId, story.id, "depth 3 applied");
assert.deepEqual(capped.labelIds, [capLabel.id], "depth 4 applied");
assert.equal(capped.archivedAt, null, "depth 5 is past MAX_CHAIN_DEPTH — dropped");

// Automation dry-run: evaluates without applying.
const dry = await ok("POST", `/boards/${capBoard.id}/automations/test`, {
  taskId: capTask.id,
  rule: {
    id: "dry",
    name: "dry",
    when: { type: "field_changed", field: "priority" },
    if: [{ field: "priority", op: "gte", value: 2 }],
    then: [{ type: "set_priority", priority: 0 }],
  },
});
assert.equal(dry.matched, true);
assert.deepEqual(dry.effects, [{ ruleId: "dry", patch: { priority: 0 } }]);
assert.equal(
  (await ok("GET", `/boards/${capBoard.id}/tasks/${capTask.id}`)).priority,
  2,
  "the dry-run applied nothing",
);

// --- recurrence spawn-on-complete ---------------------------------------------

const recBoard = await ok("POST", "/boards", { name: "Rec", keyPrefix: "REC" }, 201);
const recDone = recBoard.columns.find((c: any) => c.category === "done");
const due = Date.UTC(2026, 0, 15, 12);
const rec = await ok(
  "POST",
  `/boards/${recBoard.id}/tasks`,
  { title: "standup", dueDate: due, recurrence: { freq: "daily", interval: 2 } },
  201,
);
await ok("POST", `/boards/${recBoard.id}/tasks/${rec.id}/move`, { columnId: recDone.id, index: 0 });
const recTasks = (await ok("GET", `/boards/${recBoard.id}/tasks`)).tasks;
assert.equal(recTasks.length, 2, "completing spawned the clone");
const clone = recTasks.find((t: any) => t.id !== rec.id);
assert.equal(clone.title, "standup");
assert.equal(clone.recurrenceParentId, rec.id);
assert.equal(clone.completedAt, null, "the clone starts un-completed");
assert.equal(clone.key, "REC-2", "the clone gets its own key");
const expectedDue = (() => {
  const d = new Date(due);
  d.setDate(d.getDate() + 2);
  return d.getTime();
})();
assert.equal(clone.dueDate, expectedDue, "dates advance by the recurrence");

// --- sprints: start/complete snapshot + moveIncompleteTo ----------------------

const spBoard = await ok("POST", "/boards", { name: "Sprints", keyPrefix: "SP" }, 201);
const spDone = spBoard.columns.find((c: any) => c.category === "done");
const s1 = await ok(
  "POST",
  `/boards/${spBoard.id}/sprints`,
  { name: "S1", startDate: Date.UTC(2026, 0, 1), endDate: Date.UTC(2026, 0, 14) },
  201,
);
const s2 = await ok("POST", `/boards/${spBoard.id}/sprints`, { name: "S2" }, 201);
const sp1 = await ok("POST", `/boards/${spBoard.id}/tasks`, { title: "a", storyPoints: 3, sprintId: s1.id }, 201);
const sp2 = await ok("POST", `/boards/${spBoard.id}/tasks`, { title: "b", storyPoints: 5, sprintId: s1.id }, 201);
assert.equal((await api("POST", `/boards/${spBoard.id}/sprints/${s1.id}/complete`)).status, 400, "only an active sprint can complete");
const started = await ok("POST", `/boards/${spBoard.id}/sprints/${s1.id}/start`);
assert.equal(started.state, "active");
assert.equal((await api("POST", `/boards/${spBoard.id}/sprints/${s2.id}/start`)).status, 400, "one active sprint per board");
await ok("POST", `/boards/${spBoard.id}/tasks/${sp1.id}/move`, { columnId: spDone.id, index: 0 });
const completed = await ok("POST", `/boards/${spBoard.id}/sprints/${s1.id}/complete`, {
  moveIncompleteTo: s2.id,
});
assert.equal(completed.state, "completed");
assert.equal(completed.snapshot.committedPoints, 8);
assert.equal(completed.snapshot.completedPoints, 3);
assert.equal(completed.snapshot.committedTasks, 2);
assert.equal(completed.snapshot.completedTasks, 1);
assert.equal(
  (await ok("GET", `/boards/${spBoard.id}/tasks/${sp2.id}`)).sprintId,
  s2.id,
  "the incomplete task rolled into S2",
);
assert.equal(
  (await ok("GET", `/boards/${spBoard.id}/tasks/${sp1.id}`)).sprintId,
  s1.id,
  "the done task stays for the record",
);
const vel = await ok("GET", `/boards/${spBoard.id}/reports/velocity`);
assert.deepEqual(
  vel.map((v: any) => [v.sprintId, v.completedPoints, v.exact]),
  [[s1.id, 3, true]],
  "velocity reads the frozen snapshot",
);
const burn = await ok("GET", `/boards/${spBoard.id}/reports/burndown?sprintId=${s1.id}`);
assert.equal(burn.totalPoints, 3, "burndown scope is current membership");
assert.ok(burn.series.length > 0);

// --- sprint lifecycle guards (W3) --------------------------------------------

// Completing twice, and starting what is already finished, are both refused —
// the state machine is planned → active → completed, one way.
assert.equal(
  (await api("POST", `/boards/${spBoard.id}/sprints/${s1.id}/complete`)).status,
  400,
  "a completed sprint cannot complete again",
);
assert.equal(
  (await api("POST", `/boards/${spBoard.id}/sprints/${s1.id}/start`)).status,
  400,
  "a completed sprint cannot be restarted",
);

// moveIncompleteTo must name an OPEN sprint on THIS board.
const otherBoard = await ok("POST", "/boards", { name: "Other", keyPrefix: "OTH" }, 201);
const foreign = await ok("POST", `/boards/${otherBoard.id}/sprints`, { name: "Foreign" }, 201);
await ok("POST", `/boards/${spBoard.id}/sprints/${s2.id}/start`);
assert.equal(
  (await api("POST", `/boards/${spBoard.id}/sprints/${s2.id}/complete`, { moveIncompleteTo: foreign.id })).status,
  400,
  "a sprint on another board is not a rollover target",
);
assert.equal(
  (await api("POST", `/boards/${spBoard.id}/sprints/${s2.id}/complete`, { moveIncompleteTo: s1.id })).status,
  400,
  "a completed sprint is not a rollover target",
);
assert.equal(
  (await api("POST", `/boards/${spBoard.id}/sprints/${s2.id}/complete`, { moveIncompleteTo: s2.id })).status,
  400,
  "a sprint cannot roll into itself",
);
// Rolling into the backlog (no target) is the default and does complete.
const s2done = await ok("POST", `/boards/${spBoard.id}/sprints/${s2.id}/complete`);
assert.equal(s2done.state, "completed");
assert.equal(
  (await ok("GET", `/boards/${spBoard.id}/tasks/${sp2.id}`)).sprintId,
  null,
  "the incomplete task fell through to the backlog",
);

// A no-op PATCH must not blow up on an empty SET.
const spNoop = await ok("PATCH", `/boards/${spBoard.id}/sprints/${s2.id}`, {});
assert.equal(spNoop.id, s2.id);
assert.equal((await api("PATCH", `/boards/${spBoard.id}/sprints/${randomUUID()}`, { name: "x" })).status, 404);

// Velocity now spans two completed sprints, oldest first.
const vel2 = await ok("GET", `/boards/${spBoard.id}/reports/velocity`);
assert.deepEqual(vel2.map((v: any) => v.sprintId), [s1.id, s2.id], "chart order is oldest-completed first");
assert.deepEqual(
  vel2.map((v: any) => [v.committedPoints, v.completedPoints, v.committedTasks, v.completedTasks, v.exact]),
  [[8, 3, 2, 1, true], [5, 0, 1, 0, true]],
  "both read their frozen snapshots",
);
for (const v of vel2) {
  assert.equal(typeof v.name, "string");
  assert.equal(typeof v.completedAt, "number", "snapshot stamps the completion time");
}

// Snapshotless completed sprints (pre-snapshot rows) reconstruct from live task
// rows and say so — the documented exact/reconstructed flag.
db.update(pmSprints).set({ snapshot: null }).where(eq(pmSprints.id, s1.id)).run();
const velRebuilt = await ok("GET", `/boards/${spBoard.id}/reports/velocity`);
const rebuilt = velRebuilt.find((v: any) => v.sprintId === s1.id);
assert.equal(rebuilt.exact, false, "no snapshot -> reconstructed");
assert.equal(rebuilt.committedPoints, 3, "…from what is still in the sprint today");
assert.equal(rebuilt.completedPoints, 3);
assert.equal(rebuilt.completedAt, s1.endDate, "…stamped by the sprint window instead");

// --- agile: backlog, lanes, epics, burndown (W3) ------------------------------

const agBoard = await ok("POST", "/boards", { name: "Agile", keyPrefix: "AG" }, 201);
const agTodo = agBoard.columns.find((c: any) => c.category === "open");
const agDone = agBoard.columns.find((c: any) => c.category === "done");
const agEpicType = agBoard.issueTypes.find((t: any) => t.isEpic);
const sprintStart = Date.UTC(2026, 1, 2);
const sprintEnd = Date.UTC(2026, 1, 6); // 5 UTC days inclusive
const ags = await ok(
  "POST",
  `/boards/${agBoard.id}/sprints`,
  { name: "AG S1", goal: "ship it", startDate: sprintStart, endDate: sprintEnd },
  201,
);
const mkTask = (title: string, extra: object = {}) =>
  ok("POST", `/boards/${agBoard.id}/tasks`, { title, ...extra }, 201);

// Backlog semantics: sprintId null IS the backlog, and ?sprint=none is its query.
const b1 = await mkTask("backlog one", { storyPoints: 2 });
const b2 = await mkTask("backlog two", { storyPoints: 3 });
const b3 = await mkTask("backlog three");
assert.deepEqual([b1.sprintId, b2.sprintId, b3.sprintId], [null, null, null]);
assert.deepEqual([b1.backlogRank, b2.backlogRank, b3.backlogRank], [0, 1000, 2000], "the backlog is one gap-1000 lane");
const backlog = await ok("GET", `/boards/${agBoard.id}/tasks?sprint=none`);
assert.equal(backlog.total, 3);
assert.deepEqual(backlog.tasks.map((t: any) => t.id).sort(), [b1.id, b2.id, b3.id].sort());

// Moving between backlog and a sprint lane goes through move {sprintId}, and the
// task appends to the END of the lane it arrives in (its old rank is meaningless
// there).
const inSprint = await ok("POST", `/boards/${agBoard.id}/tasks/${b1.id}/move`, {
  columnId: agTodo.id,
  index: 0,
  sprintId: ags.id,
});
assert.equal(inSprint.sprintId, ags.id);
assert.equal(inSprint.backlogRank, 0, "first into an empty lane");
const inSprint2 = await ok("POST", `/boards/${agBoard.id}/tasks/${b2.id}/move`, {
  columnId: agTodo.id,
  index: 0,
  sprintId: ags.id,
});
assert.equal(inSprint2.backlogRank, 1000, "appends behind it, no rank collision");
assert.equal((await ok("GET", `/boards/${agBoard.id}/tasks?sprint=none`)).total, 1, "…and left the backlog");
assert.equal((await ok("GET", `/boards/${agBoard.id}/tasks?sprint=${ags.id}`)).total, 2);
// …and back out to the backlog again.
const outAgain = await ok("POST", `/boards/${agBoard.id}/tasks/${b2.id}/move`, {
  columnId: agTodo.id,
  index: 0,
  sprintId: null,
});
assert.equal(outAgain.sprintId, null);
assert.equal(outAgain.backlogRank, 3000, "back at the end of the backlog lane");
await ok("POST", `/boards/${agBoard.id}/tasks/${b2.id}/move`, {
  columnId: agTodo.id,
  index: 0,
  sprintId: ags.id,
});

// Bulk reorder ranks a sprint lane on backlogRank (not `order`, which is the
// kanban column's rank) — and the backlog lane is its own scope.
await ok("POST", `/boards/${agBoard.id}/reorder`, {
  scope: { kind: "sprint", sprintId: ags.id },
  orderedIds: [b2.id, b1.id],
});
const laneRanks = Object.fromEntries(
  (await ok("GET", `/boards/${agBoard.id}/tasks?sprint=${ags.id}`)).tasks.map((t: any) => [t.id, t.backlogRank]),
);
assert.deepEqual([laneRanks[b2.id], laneRanks[b1.id]], [0, 1000], "bulk ranks are i*1000 in the given order");
await ok("POST", `/boards/${agBoard.id}/reorder`, {
  scope: { kind: "backlog" },
  orderedIds: [b3.id],
});
assert.equal(
  (await ok("GET", `/boards/${agBoard.id}/tasks/${b3.id}`)).backlogRank,
  0,
  "the backlog scope only touches unsprinted tasks",
);
// A sprint-scoped reorder cannot reach a task in another lane.
await ok("POST", `/boards/${agBoard.id}/reorder`, {
  scope: { kind: "sprint", sprintId: ags.id },
  orderedIds: [b3.id],
});
assert.equal((await ok("GET", `/boards/${agBoard.id}/tasks/${b3.id}`)).backlogRank, 0, "…still untouched");

// Epic roll-up: an epic is a task, children point at it with epicId, and ?epic=
// is the roll-up query the progress bar sums over.
const epic = await mkTask("Checkout revamp", { typeId: agEpicType.id });
const c1 = await mkTask("child a", { epicId: epic.id, storyPoints: 5 });
const c2 = await mkTask("child b", { epicId: epic.id, storyPoints: 8 });
await ok("POST", `/boards/${agBoard.id}/tasks/${c1.id}/move`, { columnId: agDone.id, index: 0 });
const children = await ok("GET", `/boards/${agBoard.id}/tasks?epic=${epic.id}`);
assert.equal(children.total, 2, "the epic itself is not its own child");
assert.deepEqual(children.tasks.map((t: any) => t.id).sort(), [c1.id, c2.id].sort());
assert.equal(
  children.tasks.reduce((n: number, t: any) => n + (t.storyPoints ?? 0), 0),
  13,
  "story points roll up over the children",
);
assert.equal(
  children.tasks.filter((t: any) => t.completedAt !== null).reduce((n: number, t: any) => n + t.storyPoints, 0),
  5,
  "…and so does the done half",
);
assert.equal(
  (await api("PATCH", `/boards/${agBoard.id}/tasks/${epic.id}`, { epicId: epic.id })).status,
  400,
  "a task cannot be its own epic",
);

// Burndown over the sprint window: one point per UTC day, inclusive.
await ok("POST", `/boards/${agBoard.id}/tasks/${b1.id}/move`, { columnId: agDone.id, index: 0 });
const agBurn = await ok("GET", `/boards/${agBoard.id}/reports/burndown?sprintId=${ags.id}`);
assert.equal(agBurn.sprint.id, ags.id);
assert.equal(agBurn.sprint.goal, "ship it", "the sprint travels with the series");
assert.equal(agBurn.totalPoints, 5, "2 + 3 currently in the sprint");
assert.equal(agBurn.totalTasks, 2);
assert.equal(agBurn.series.length, 5, "Feb 2..6 inclusive is five daily buckets");
assert.deepEqual(
  agBurn.series.map((p: any) => p.date),
  [0, 1, 2, 3, 4].map((i) => sprintStart + i * 86_400_000),
  "buckets are UTC midnights, one day apart",
);
assert.equal(agBurn.series[0].ideal, 5, "the ideal line starts at the commitment");
assert.equal(agBurn.series.at(-1).ideal, 0, "…and lands on zero");
let prevRemaining = Infinity;
for (const p of agBurn.series) {
  assert.ok(p.remaining <= prevRemaining, "remaining never climbs");
  assert.equal(p.remaining, agBurn.totalPoints - p.completed, "remaining = committed - completed");
  prevRemaining = p.remaining;
}
// b1 completed today, i.e. after the window — it clamps onto the last bucket
// rather than falling out of the series.
assert.equal(agBurn.series[0].completed, 0);
assert.equal(agBurn.series.at(-1).completed, 2, "a late completion clamps to the final day");
assert.equal(
  (await api("GET", `/boards/${agBoard.id}/reports/burndown?sprintId=${randomUUID()}`)).status,
  404,
);
assert.equal((await api("GET", `/boards/${agBoard.id}/reports/burndown`)).status, 400, "sprintId is required");
// A sprint with no window still reports real totals and an empty series.
const undated = await ok("POST", `/boards/${agBoard.id}/sprints`, { name: "someday" }, 201);
const undatedBurn = await ok("GET", `/boards/${agBoard.id}/reports/burndown?sprintId=${undated.id}`);
assert.deepEqual(undatedBurn.series, []);
assert.equal(undatedBurn.totalPoints, 0);

// --- dashboard aggregates (W3) ------------------------------------------------

const dashBefore = await ok("GET", `/boards/${agBoard.id}/dashboard`);
assert.equal(dashBefore.totalTasks, 6, "3 backlog seeds + epic + 2 children");
assert.deepEqual(dashBefore.byCategory, { open: 4, active: 0, done: 2 });
assert.equal(dashBefore.pointsTotal, 18, "2 + 3 + 5 + 8");
assert.equal(dashBefore.pointsDone, 7, "b1 (2) + child a (5)");
assert.equal(dashBefore.overdue, 0);
assert.deepEqual(dashBefore.byAssignee, []);

// Assignee counts fan out over the json array, biggest first.
await ok("PATCH", `/boards/${agBoard.id}/tasks/${c2.id}`, { assignees: ["mo", "sam"] });
await ok("PATCH", `/boards/${agBoard.id}/tasks/${b3.id}`, { assignees: ["mo"] });
// Overdue = live, not done, due before now.
await ok("PATCH", `/boards/${agBoard.id}/tasks/${b3.id}`, { dueDate: Date.UTC(2020, 0, 1) });
await ok("PATCH", `/boards/${agBoard.id}/tasks/${c1.id}`, { dueDate: Date.UTC(2020, 0, 1) });
const dashMid = await ok("GET", `/boards/${agBoard.id}/dashboard`);
assert.deepEqual(dashMid.byAssignee, [
  { assignee: "mo", count: 2 },
  { assignee: "sam", count: 1 },
]);
assert.equal(dashMid.overdue, 1, "the done task's past due date is not overdue");

// Archiving and trashing take tasks out of every aggregate — the dashboard is
// live work only.
await ok("POST", `/boards/${agBoard.id}/tasks/${c2.id}/archive`);
await ok("DELETE", `/boards/${agBoard.id}/tasks/${b3.id}`);
const dashAfter = await ok("GET", `/boards/${agBoard.id}/dashboard`);
assert.equal(dashAfter.totalTasks, 4);
assert.deepEqual(dashAfter.byCategory, { open: 2, active: 0, done: 2 });
assert.equal(dashAfter.pointsTotal, 10, "child b's 8 archived away");
assert.equal(dashAfter.pointsDone, 7, "done points are untouched");
assert.equal(dashAfter.overdue, 0, "the trashed task stopped being overdue");
assert.deepEqual(dashAfter.byAssignee, [], "archived/trashed assignees drop out too");

// --- sprint rollover re-ranks into the target lane (W3) -----------------------

await ok("POST", `/boards/${agBoard.id}/sprints/${ags.id}/start`);
const ags2 = await ok("POST", `/boards/${agBoard.id}/sprints`, { name: "AG S2" }, 201);
const carry = await mkTask("already planned", { sprintId: ags2.id });
assert.equal(carry.backlogRank, 0, "first task in a fresh lane");
const agsDone = await ok("POST", `/boards/${agBoard.id}/sprints/${ags.id}/complete`, {
  moveIncompleteTo: ags2.id,
});
assert.deepEqual(
  [
    agsDone.snapshot.committedPoints,
    agsDone.snapshot.completedPoints,
    agsDone.snapshot.committedTasks,
    agsDone.snapshot.completedTasks,
  ],
  [5, 2, 2, 1],
  "the snapshot freezes committed-vs-done at the moment of completion",
);
const rolled = await ok("GET", `/boards/${agBoard.id}/tasks/${b2.id}`);
assert.equal(rolled.sprintId, ags2.id);
assert.equal(
  rolled.backlogRank,
  1000,
  "a rolled-over task appends behind the target lane, not on top of it",
);
assert.equal(
  (await ok("GET", `/boards/${agBoard.id}/tasks/${carry.id}`)).backlogRank,
  0,
  "…and the task already there keeps its position",
);

// --- search (cross-board) -----------------------------------------------------

const hits = await ok("GET", "/search?q=standup");
assert.ok(hits.some((h: any) => h.boardId === recBoard.id && h.title === "standup"));
assert.ok(!hits.some((h: any) => h.boardId === board.id), "no false hits");

// --- trash/restore + cascade cleanup on purge ---------------------------------

await ok("DELETE", `/boards/${board.id}/tasks/${t2.id}`);
assert.ok(!(await ok("GET", `/boards/${board.id}/tasks`)).tasks.some((t: any) => t.id === t2.id));
assert.ok((await ok("GET", `/boards/${board.id}/tasks?trashed=1`)).tasks.some((t: any) => t.id === t2.id));
await ok("POST", `/boards/${board.id}/tasks/${t2.id}/restore`);

// Purging the board takes its tasks, comments and label joins with it — the
// schema's cascades, observed through the db handle the routes use.
await ok("DELETE", `/boards/${board.id}?purge=1`);
assert.equal((await api("GET", `/boards/${board.id}`)).status, 404);
assert.equal((await api("GET", `/boards/${board.id}/tasks/${t1.id}`)).status, 404);
assert.equal(db.select().from(pmTasks).where(eq(pmTasks.boardId, board.id)).all().length, 0);
assert.equal(db.select().from(pmComments).where(eq(pmComments.taskId, t1.id)).all().length, 0);
assert.equal(db.select().from(pmTaskLabels).where(eq(pmTaskLabels.taskId, t1.id)).all().length, 0);
// …and its key prefix is free again.
await ok("POST", "/boards", { name: "Reborn", keyPrefix: "DAE" }, 201);

console.log("pm.test.ts OK");
process.exit(0);
