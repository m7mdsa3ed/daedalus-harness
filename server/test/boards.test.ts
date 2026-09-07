// Self-check for boards.ts + tasks-board.ts: a status is a row, so it can be
// added, renamed, reordered and deleted — and none of those may lose a task.
// Also covers the reorder contract the kanban depends on (position is the
// entry's own `order`, per column) and the placement rules a create/update
// resolves.
//
// Runs against a real (temp) database — importing db/index.js pushes the schema
// into whatever DAEDALUS_DATA_DIR points at. Run: pnpm test:boards
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { asc, eq } from "drizzle-orm";
import {
  boardStatuses as boardStatusesTable,
  boards as boardsTable,
  db,
  sprints as sprintsTable,
  taskActivity as taskActivityTable,
  taskComments as taskCommentsTable,
  taskLinks as taskLinksTable,
  tasks as tasksTable,
} from "../src/db/index.js";
import {
  BoardError,
  createBoard,
  createStatus,
  deleteBoard,
  deleteStatus,
  ensureDefaultBoard,
  listStatuses,
  reconcileTaskStatuses,
  reorderStatuses,
  updateStatus,
} from "../src/boards.js";
import {
  addComment,
  addLink,
  applyReorder,
  bulkUpdate,
  createTask,
  deleteTask,
  findTaskByKey,
  getTaskDetail,
  listTasks,
  updateTask,
} from "../src/tasks-board.js";
import {
  completeSprint,
  createSprint,
  getBoard,
  keyFromName,
  startSprint,
} from "../src/boards.js";

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

async function reset() {
  await db.delete(tasksTable);
  await db.delete(boardStatusesTable);
  await db.delete(boardsTable);
  await db.delete(sprintsTable);
  await db.delete(taskActivityTable);
  await db.delete(taskCommentsTable);
  await db.delete(taskLinksTable);
  await ensureDefaultBoard();
}

/** Ids of one column's tasks, in stored order. */
const column = async (boardId: string, statusId: string) =>
  (await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.statusId, statusId))
    .orderBy(asc(tasksTable.order))
    )
    .filter((t) => t.boardId === boardId)
    .map((t) => t.id);

const names = async (boardId: string) => (await listStatuses(boardId)).map((s) => s.name);

console.log("boards");

await test("the seed is the migration: the default board's ids are the legacy slugs", async () => {
  await reset();
  assert.deepEqual(
    (await listStatuses("default")).map((s) => s.id),
    ["todo", "in_progress", "blocked", "done"],
  );
  // A row written before boards existed already holds one of those in `status`.
  await db.insert(tasksTable)
    .values({ id: "legacy", title: "Old", statusId: "todo", createdAt: 1, updatedAt: 1 })
    ;
  assert.equal((await reconcileTaskStatuses()), 0, "a legacy task is already valid");
});

await test("ensureDefaultBoard is idempotent and never re-seeds a deleted column", async () => {
  await reset();
  await deleteStatus("blocked");
  await ensureDefaultBoard();
  assert.equal((await listStatuses("default")).length, 3, "the seed does not come back");
});

await test("a status can be added, renamed and reordered", async () => {
  await reset();
  const review = await createStatus("default", { name: "In review", color: "violet", order: 2 });
  assert.deepEqual((await names("default")), ["To do", "In progress", "In review", "Blocked", "Done"]);
  assert.deepEqual(
    (await listStatuses("default")).map((s) => s.order),
    [0, 1, 2, 3, 4],
    "order stays a dense run after an insert in the middle",
  );
  await updateStatus(review.id, { name: "Review" });
  assert.equal((await listStatuses("default"))[2]!.name, "Review");
  await reorderStatuses("default", ["done", review.id, "todo"]);
  assert.deepEqual((await names("default")), ["Done", "Review", "To do", "In progress", "Blocked"]);
});

await test("deleting a column moves its tasks; it never deletes them", async () => {
  await reset();
  await createTask({ title: "a", statusId: "blocked" });
  await createTask({ title: "b", statusId: "blocked" });
  await createTask({ title: "keep", statusId: "done" });
  await deleteStatus("blocked", "done");
  assert.equal((await listTasks()).length, 3, "nothing was deleted");
  assert.deepEqual(
    await Promise.all(
      (await column("default", "done")).map(
        async (id) => (await listTasks()).find((t) => t.id === id)!.title,
      ),
    ),
    ["keep", "a", "b"],
    "rehomed tasks join the end, keeping their relative order",
  );
  assert.deepEqual(
    (await listStatuses("default")).map((s) => s.order),
    [0, 1, 2],
    "the gap the delete left is closed",
  );
});

await test("a column with nowhere to send its tasks is refused", async () => {
  await reset();
  for (const id of ["in_progress", "blocked", "done"]) (await deleteStatus(id));
  await assert.rejects(async () => (await deleteStatus("todo")), BoardError, "the last column stays");
  await assert.rejects(async () => (await deleteStatus("todo", "nonexistent")),
    BoardError,
    "moveTo must name a real sibling",
  );
});

await test("a new board gets its own columns, and its own ids", async () => {
  await reset();
  const board = await createBoard({ name: "Roadmap", color: "blue" });
  const statuses = (await listStatuses(board.id));
  assert.deepEqual((await statuses).map((s) => s.name), ["To do", "In progress", "Blocked", "Done"]);
  assert.equal(
    (await statuses).some((s) => s.id === "todo"),
    false,
    "the seed ids belong to the default board alone",
  );
});

await test("deleting a board takes its columns and tasks; the last board stays", async () => {
  await reset();
  const board = await createBoard({ name: "Roadmap" });
  const first = (await listStatuses(board.id))[0]!;
  await createTask({ title: "on the new board", statusId: first.id });
  await createTask({ title: "on the default board", statusId: "todo" });
  await deleteBoard(board.id);
  assert.deepEqual((await listTasks()).map((t) => t.title), ["on the default board"]);
  assert.equal((await listStatuses(board.id)).length, 0);
  await assert.rejects(async () => (await deleteBoard("default")), BoardError, "the last board stays");
});

await test("a task's placement is resolved from whichever half the caller named", async () => {
  await reset();
  const board = await createBoard({ name: "Roadmap" });
  const target = (await listStatuses(board.id))[1]!;

  // A status alone names its board.
  const byStatus = await createTask({ title: "a", statusId: target.id });
  assert.equal(byStatus.boardId, board.id);

  // A board alone lands in that board's first column.
  const byBoard = await createTask({ title: "b", boardId: board.id });
  assert.equal(byBoard.statusId, (await listStatuses(board.id))[0]!.id);

  // Neither: the default board's first column.
  const bare = await createTask({ title: "c" });
  assert.equal(bare.boardId, "default");
  assert.equal(bare.statusId, "todo");

  // An inconsistent pair is refused rather than rendered nowhere.
  await assert.rejects(async () => (await createTask({ title: "d", boardId: "default", statusId: target.id })), BoardError);
});

await test("moving a task to another board sends it to that board's first column", async () => {
  await reset();
  const board = await createBoard({ name: "Roadmap" });
  const task = await createTask({ title: "a", statusId: "done" });
  const moved = (await updateTask(task.id, { boardId: board.id }))!;
  assert.equal(moved.boardId, board.id);
  assert.equal(moved.statusId, (await listStatuses(board.id))[0]!.id);
  assert.equal(moved.order, 0, "it joins the end of its new column");
});

await test("applyReorder writes each entry's own position, per column", async () => {
  await reset();
  const a = await createTask({ title: "a", statusId: "todo" });
  const b = await createTask({ title: "b", statusId: "todo" });
  const c = await createTask({ title: "c", statusId: "done" });

  /* The board-wide entry list: three entries across two columns. The old code
     wrote the *array index* as `order`, so "done" started at 2 instead of 0 —
     harmless until a task was dropped into it at a position the client had
     computed from 0. */
  await applyReorder([
    { id: b.id, statusId: "todo", order: 0 },
    { id: a.id, statusId: "todo", order: 1 },
    { id: c.id, statusId: "done", order: 0 },
  ]);
  assert.deepEqual((await column("default", "todo")), [b.id, a.id]);
  assert.equal((await db.select().from(tasksTable).where(eq(tasksTable.id, c.id)))[0]!.order, 0);
});

await test("a reorder into an empty column is a plain cross-column move", async () => {
  await reset();
  const a = await createTask({ title: "a", statusId: "todo" });
  const b = await createTask({ title: "b", statusId: "todo" });
  assert.deepEqual((await column("default", "blocked")), [], "the target starts empty");

  // What the kanban sends after dropping `a` onto an empty column: the target
  // holding only `a`, and the source renumbered without it.
  await applyReorder([
    { id: b.id, statusId: "todo", order: 0 },
    { id: a.id, statusId: "blocked", order: 0 },
  ]);
  assert.deepEqual((await column("default", "todo")), [b.id]);
  assert.deepEqual((await column("default", "blocked")), [a.id]);
});

await test("a reorder naming a column of another board is refused whole", async () => {
  await reset();
  const board = await createBoard({ name: "Roadmap" });
  const other = (await listStatuses(board.id))[0]!;
  const a = await createTask({ title: "a", statusId: "todo" });
  await assert.rejects(async () => (await applyReorder([{ id: a.id, statusId: other.id, order: 0 }], "default")),
    BoardError,
  );
  assert.equal(
    (await db.select().from(tasksTable).where(eq(tasksTable.id, a.id)))[0]!.statusId,
    "todo",
    "nothing was written",
  );
});

await test("reconcile rehomes a task whose column vanished", async () => {
  await reset();
  const a = await createTask({ title: "a", statusId: "done" });
  // Only a backup import can produce this; boards.ts always rehomes first.
  await db.delete(boardStatusesTable).where(eq(boardStatusesTable.id, "done"));
  assert.equal((await reconcileTaskStatuses()), 1);
  assert.equal(
    (await db.select().from(tasksTable).where(eq(tasksTable.id, a.id)))[0]!.statusId,
    "todo",
    "it lands in the board's first column, not nowhere",
  );
});

if (failures.length) {
  console.error(`\nboards: ${passed} passed, ${failures.length} failed\n`);
  for (const failure of failures) console.error(`FAIL ${failure}\n`);
  process.exit(1);
}
await test("keys: a board mints its key from its name, tasks are numbered per board", async () => {
  await reset();
  assert.equal(keyFromName("Web Platform"), "WP");
  assert.equal(keyFromName("Daedalus"), "DAED");
  assert.equal(keyFromName("Web Platform", new Set(["WP"])), "WP2");
  const a = await createTask({ title: "first" });
  const b = await createTask({ title: "second" });
  assert.deepEqual([a.number, b.number], [1, 2]);
  assert.equal((await getBoard("default"))!.nextNumber, 3);
  assert.equal((await findTaskByKey("task-2"))?.id, b.id, "lookup by key is case-insensitive");
  const other = await createBoard({ name: "Other" });
  const moved = (await updateTask(a.id, { boardId: other.id }))!;
  assert.equal(moved.number, 1, "a board move takes a number from the new board");
  assert.equal(moved.boardId, other.id);
});

await test("ensureDefaultBoard backfills numbers onto pre-key rows", async () => {
  await reset();
  await db.insert(tasksTable)
    .values({ id: "old1", title: "a", statusId: "todo", createdAt: 1, updatedAt: 1 })
    ;
  await db.insert(tasksTable)
    .values({ id: "old2", title: "b", statusId: "todo", createdAt: 2, updatedAt: 2 })
    ;
  await ensureDefaultBoard();
  assert.deepEqual(
    (await listTasks()).map((t) => t.number),
    [1, 2],
  );
  assert.equal((await getBoard("default"))!.nextNumber, 3);
});

await test("completion is stamped by the column's category", async () => {
  await reset();
  const t = await createTask({ title: "x" });
  assert.equal(t.completedAt, null);
  const done = (await updateTask(t.id, { statusId: "done" }))!;
  assert.ok(done.completedAt, "entering a done column stamps completedAt");
  const reopened = (await updateTask(t.id, { statusId: "todo" }))!;
  assert.equal(reopened.completedAt, null, "leaving it clears the stamp");
  await applyReorder([{ id: t.id, statusId: "done", order: 0 }]);
  assert.ok((await listTasks())[0]!.completedAt, "a drag into done stamps too");
  await updateStatus("done", { category: "in_progress" });
  assert.equal((await listTasks())[0]!.completedAt, null, "recategorising the column clears its tasks");
});

await test("a parent must be on the same board and never a descendant", async () => {
  await reset();
  const epic = await createTask({ title: "Epic", type: "epic" });
  const child = await createTask({ title: "Child", parentId: epic.id });
  await assert.rejects(async () => (await updateTask(epic.id, { parentId: child.id })), /ancestor/);
  const other = await createBoard({ name: "Other" });
  const away = await createTask({ title: "Away", boardId: other.id });
  await assert.rejects(async () => (await updateTask(away.id, { parentId: epic.id })), /same board/);
  assert.deepEqual(((await getTaskDetail(epic.id))!).children.map((c) => c.id), [child.id]);
  await deleteTask(epic.id);
  assert.equal((await listTasks()).find((t) => t.id === child.id)!.parentId, null, "children are detached, not deleted");
});

await test("activity records every tracked change, comments and links", async () => {
  await reset();
  const a = await createTask({ title: "a" });
  const b = await createTask({ title: "b" });
  await updateTask(a.id, { priority: "high", title: "A", labels: ["x"] });
  await updateTask(a.id, { priority: "high" });
  await addComment(a.id, { body: "hello" });
  await addLink(a.id, { toId: b.id, kind: "blocks" });
  const fields = ((await getTaskDetail(a.id))!).activity.map((e) => e.field).sort();
  assert.deepEqual(fields, ["commented", "created", "labels", "linked", "priority", "title"]);
  assert.equal((await getTaskDetail(b.id))!.links.length, 1, "a link is seen from both ends");
  await assert.rejects(async () => (await addLink(a.id, { toId: a.id, kind: "relates" })), /itself/);
});

await test("sprints: one active at a time, and closing moves the open work", async () => {
  await reset();
  const s1 = await createSprint("default", { name: "Sprint 1" });
  const s2 = await createSprint("default", { name: "Sprint 2" });
  await startSprint(s1.id);
  await assert.rejects(async () => (await startSprint(s2.id)), /still active/);
  const done = await createTask({ title: "done", sprintId: s1.id, statusId: "done" });
  const open = await createTask({ title: "open", sprintId: s1.id });
  const result = await completeSprint(s1.id, "next");
  assert.equal(result.moved, 1);
  assert.equal(result.next?.id, s2.id);
  assert.equal((await listTasks()).find((t) => t.id === open.id)!.sprintId, s2.id);
  assert.equal((await listTasks()).find((t) => t.id === done.id)!.sprintId, s1.id, "done work stays on the record");
  assert.equal(result.sprint.state, "closed");
  const third = await completeSprint(s2.id, "next");
  assert.ok(third.next && third.next.id !== s2.id, "closing the last sprint creates the next one");
});

await test("bulk updates skip a status from another board rather than failing", async () => {
  await reset();
  const other = await createBoard({ name: "Other" });
  const here = await createTask({ title: "here" });
  const there = await createTask({ title: "there", boardId: other.id });
  const rows = await bulkUpdate({ ids: [here.id, there.id], patch: { statusId: "done", priority: "urgent" } });
  assert.equal(rows.length, 2);
  assert.equal((await rows).find((r) => r.id === here.id)!.statusId, "done");
  assert.notEqual((await rows).find((r) => r.id === there.id)!.statusId, "done");
  assert.ok((await rows).every((r) => r.priority === "urgent"));
});

console.log(`\nboards: ${passed} passed, 0 failed`);
