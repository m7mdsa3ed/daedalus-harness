// Self-check for boards.ts + tasks-board.ts: a status is a row, so it can be
// added, renamed, reordered and deleted — and none of those may lose a task.
// Also covers the reorder contract the kanban depends on (position is the
// entry's own `order`, per column) and the placement rules a create/update
// resolves.
//
// Runs against a real (temp) database — importing db/index.js pushes the schema
// into whatever DAEDALUS_DATA_DIR points at. Run: pnpm test:boards
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
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

function reset() {
  db.delete(tasksTable).run();
  db.delete(boardStatusesTable).run();
  db.delete(boardsTable).run();
  db.delete(sprintsTable).run();
  db.delete(taskActivityTable).run();
  db.delete(taskCommentsTable).run();
  db.delete(taskLinksTable).run();
  ensureDefaultBoard();
}

/** Ids of one column's tasks, in stored order. */
const column = (boardId: string, statusId: string) =>
  db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.statusId, statusId))
    .orderBy(asc(tasksTable.order))
    .all()
    .filter((t) => t.boardId === boardId)
    .map((t) => t.id);

const names = (boardId: string) => listStatuses(boardId).map((s) => s.name);

console.log("boards");

test("the seed is the migration: the default board's ids are the legacy slugs", () => {
  reset();
  assert.deepEqual(
    listStatuses("default").map((s) => s.id),
    ["todo", "in_progress", "blocked", "done"],
  );
  // A row written before boards existed already holds one of those in `status`.
  db.insert(tasksTable)
    .values({ id: "legacy", title: "Old", statusId: "todo", createdAt: 1, updatedAt: 1 })
    .run();
  assert.equal(reconcileTaskStatuses(), 0, "a legacy task is already valid");
});

test("ensureDefaultBoard is idempotent and never re-seeds a deleted column", () => {
  reset();
  deleteStatus("blocked");
  ensureDefaultBoard();
  assert.equal(listStatuses("default").length, 3, "the seed does not come back");
});

test("a status can be added, renamed and reordered", () => {
  reset();
  const review = createStatus("default", { name: "In review", color: "violet", order: 2 });
  assert.deepEqual(names("default"), ["To do", "In progress", "In review", "Blocked", "Done"]);
  assert.deepEqual(
    listStatuses("default").map((s) => s.order),
    [0, 1, 2, 3, 4],
    "order stays a dense run after an insert in the middle",
  );
  updateStatus(review.id, { name: "Review" });
  assert.equal(listStatuses("default")[2]!.name, "Review");
  reorderStatuses("default", ["done", review.id, "todo"]);
  assert.deepEqual(names("default"), ["Done", "Review", "To do", "In progress", "Blocked"]);
});

test("deleting a column moves its tasks; it never deletes them", () => {
  reset();
  createTask({ title: "a", statusId: "blocked" });
  createTask({ title: "b", statusId: "blocked" });
  createTask({ title: "keep", statusId: "done" });
  deleteStatus("blocked", "done");
  assert.equal(listTasks().length, 3, "nothing was deleted");
  assert.deepEqual(
    column("default", "done").map((id) => listTasks().find((t) => t.id === id)!.title),
    ["keep", "a", "b"],
    "rehomed tasks join the end, keeping their relative order",
  );
  assert.deepEqual(
    listStatuses("default").map((s) => s.order),
    [0, 1, 2],
    "the gap the delete left is closed",
  );
});

test("a column with nowhere to send its tasks is refused", () => {
  reset();
  for (const id of ["in_progress", "blocked", "done"]) deleteStatus(id);
  assert.throws(() => deleteStatus("todo"), BoardError, "the last column stays");
  assert.throws(
    () => deleteStatus("todo", "nonexistent"),
    BoardError,
    "moveTo must name a real sibling",
  );
});

test("a new board gets its own columns, and its own ids", () => {
  reset();
  const board = createBoard({ name: "Roadmap", color: "blue" });
  const statuses = listStatuses(board.id);
  assert.deepEqual(statuses.map((s) => s.name), ["To do", "In progress", "Blocked", "Done"]);
  assert.equal(
    statuses.some((s) => s.id === "todo"),
    false,
    "the seed ids belong to the default board alone",
  );
});

test("deleting a board takes its columns and tasks; the last board stays", () => {
  reset();
  const board = createBoard({ name: "Roadmap" });
  const first = listStatuses(board.id)[0]!;
  createTask({ title: "on the new board", statusId: first.id });
  createTask({ title: "on the default board", statusId: "todo" });
  deleteBoard(board.id);
  assert.deepEqual(listTasks().map((t) => t.title), ["on the default board"]);
  assert.equal(listStatuses(board.id).length, 0);
  assert.throws(() => deleteBoard("default"), BoardError, "the last board stays");
});

test("a task's placement is resolved from whichever half the caller named", () => {
  reset();
  const board = createBoard({ name: "Roadmap" });
  const target = listStatuses(board.id)[1]!;

  // A status alone names its board.
  const byStatus = createTask({ title: "a", statusId: target.id });
  assert.equal(byStatus.boardId, board.id);

  // A board alone lands in that board's first column.
  const byBoard = createTask({ title: "b", boardId: board.id });
  assert.equal(byBoard.statusId, listStatuses(board.id)[0]!.id);

  // Neither: the default board's first column.
  const bare = createTask({ title: "c" });
  assert.equal(bare.boardId, "default");
  assert.equal(bare.statusId, "todo");

  // An inconsistent pair is refused rather than rendered nowhere.
  assert.throws(() => createTask({ title: "d", boardId: "default", statusId: target.id }), BoardError);
});

test("moving a task to another board sends it to that board's first column", () => {
  reset();
  const board = createBoard({ name: "Roadmap" });
  const task = createTask({ title: "a", statusId: "done" });
  const moved = updateTask(task.id, { boardId: board.id })!;
  assert.equal(moved.boardId, board.id);
  assert.equal(moved.statusId, listStatuses(board.id)[0]!.id);
  assert.equal(moved.order, 0, "it joins the end of its new column");
});

test("applyReorder writes each entry's own position, per column", () => {
  reset();
  const a = createTask({ title: "a", statusId: "todo" });
  const b = createTask({ title: "b", statusId: "todo" });
  const c = createTask({ title: "c", statusId: "done" });

  /* The board-wide entry list: three entries across two columns. The old code
     wrote the *array index* as `order`, so "done" started at 2 instead of 0 —
     harmless until a task was dropped into it at a position the client had
     computed from 0. */
  applyReorder([
    { id: b.id, statusId: "todo", order: 0 },
    { id: a.id, statusId: "todo", order: 1 },
    { id: c.id, statusId: "done", order: 0 },
  ]);
  assert.deepEqual(column("default", "todo"), [b.id, a.id]);
  assert.equal(db.select().from(tasksTable).where(eq(tasksTable.id, c.id)).get()!.order, 0);
});

test("a reorder into an empty column is a plain cross-column move", () => {
  reset();
  const a = createTask({ title: "a", statusId: "todo" });
  const b = createTask({ title: "b", statusId: "todo" });
  assert.deepEqual(column("default", "blocked"), [], "the target starts empty");

  // What the kanban sends after dropping `a` onto an empty column: the target
  // holding only `a`, and the source renumbered without it.
  applyReorder([
    { id: b.id, statusId: "todo", order: 0 },
    { id: a.id, statusId: "blocked", order: 0 },
  ]);
  assert.deepEqual(column("default", "todo"), [b.id]);
  assert.deepEqual(column("default", "blocked"), [a.id]);
});

test("a reorder naming a column of another board is refused whole", () => {
  reset();
  const board = createBoard({ name: "Roadmap" });
  const other = listStatuses(board.id)[0]!;
  const a = createTask({ title: "a", statusId: "todo" });
  assert.throws(
    () => applyReorder([{ id: a.id, statusId: other.id, order: 0 }], "default"),
    BoardError,
  );
  assert.equal(
    db.select().from(tasksTable).where(eq(tasksTable.id, a.id)).get()!.statusId,
    "todo",
    "nothing was written",
  );
});

test("reconcile rehomes a task whose column vanished", () => {
  reset();
  const a = createTask({ title: "a", statusId: "done" });
  // Only a backup import can produce this; boards.ts always rehomes first.
  db.delete(boardStatusesTable).where(eq(boardStatusesTable.id, "done")).run();
  assert.equal(reconcileTaskStatuses(), 1);
  assert.equal(
    db.select().from(tasksTable).where(eq(tasksTable.id, a.id)).get()!.statusId,
    "todo",
    "it lands in the board's first column, not nowhere",
  );
});

if (failures.length) {
  console.error(`\nboards: ${passed} passed, ${failures.length} failed\n`);
  for (const failure of failures) console.error(`FAIL ${failure}\n`);
  process.exit(1);
}
test("keys: a board mints its key from its name, tasks are numbered per board", () => {
  reset();
  assert.equal(keyFromName("Web Platform"), "WP");
  assert.equal(keyFromName("Daedalus"), "DAED");
  assert.equal(keyFromName("Web Platform", new Set(["WP"])), "WP2");
  const a = createTask({ title: "first" });
  const b = createTask({ title: "second" });
  assert.deepEqual([a.number, b.number], [1, 2]);
  assert.equal(getBoard("default")!.nextNumber, 3);
  assert.equal(findTaskByKey("task-2")?.id, b.id, "lookup by key is case-insensitive");
  const other = createBoard({ name: "Other" });
  const moved = updateTask(a.id, { boardId: other.id })!;
  assert.equal(moved.number, 1, "a board move takes a number from the new board");
  assert.equal(moved.boardId, other.id);
});

test("ensureDefaultBoard backfills numbers onto pre-key rows", () => {
  reset();
  db.insert(tasksTable)
    .values({ id: "old1", title: "a", statusId: "todo", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(tasksTable)
    .values({ id: "old2", title: "b", statusId: "todo", createdAt: 2, updatedAt: 2 })
    .run();
  ensureDefaultBoard();
  assert.deepEqual(
    listTasks().map((t) => t.number),
    [1, 2],
  );
  assert.equal(getBoard("default")!.nextNumber, 3);
});

test("completion is stamped by the column's category", () => {
  reset();
  const t = createTask({ title: "x" });
  assert.equal(t.completedAt, null);
  const done = updateTask(t.id, { statusId: "done" })!;
  assert.ok(done.completedAt, "entering a done column stamps completedAt");
  const reopened = updateTask(t.id, { statusId: "todo" })!;
  assert.equal(reopened.completedAt, null, "leaving it clears the stamp");
  applyReorder([{ id: t.id, statusId: "done", order: 0 }]);
  assert.ok(listTasks()[0]!.completedAt, "a drag into done stamps too");
  updateStatus("done", { category: "in_progress" });
  assert.equal(listTasks()[0]!.completedAt, null, "recategorising the column clears its tasks");
});

test("a parent must be on the same board and never a descendant", () => {
  reset();
  const epic = createTask({ title: "Epic", type: "epic" });
  const child = createTask({ title: "Child", parentId: epic.id });
  assert.throws(() => updateTask(epic.id, { parentId: child.id }), /ancestor/);
  const other = createBoard({ name: "Other" });
  const away = createTask({ title: "Away", boardId: other.id });
  assert.throws(() => updateTask(away.id, { parentId: epic.id }), /same board/);
  assert.deepEqual(getTaskDetail(epic.id)!.children.map((c) => c.id), [child.id]);
  deleteTask(epic.id);
  assert.equal(listTasks().find((t) => t.id === child.id)!.parentId, null, "children are detached, not deleted");
});

test("activity records every tracked change, comments and links", () => {
  reset();
  const a = createTask({ title: "a" });
  const b = createTask({ title: "b" });
  updateTask(a.id, { priority: "high", title: "A", labels: ["x"] });
  updateTask(a.id, { priority: "high" });
  addComment(a.id, { body: "hello" });
  addLink(a.id, { toId: b.id, kind: "blocks" });
  const fields = getTaskDetail(a.id)!.activity.map((e) => e.field).sort();
  assert.deepEqual(fields, ["commented", "created", "labels", "linked", "priority", "title"]);
  assert.equal(getTaskDetail(b.id)!.links.length, 1, "a link is seen from both ends");
  assert.throws(() => addLink(a.id, { toId: a.id, kind: "relates" }), /itself/);
});

test("sprints: one active at a time, and closing moves the open work", () => {
  reset();
  const s1 = createSprint("default", { name: "Sprint 1" });
  const s2 = createSprint("default", { name: "Sprint 2" });
  startSprint(s1.id);
  assert.throws(() => startSprint(s2.id), /still active/);
  const done = createTask({ title: "done", sprintId: s1.id, statusId: "done" });
  const open = createTask({ title: "open", sprintId: s1.id });
  const result = completeSprint(s1.id, "next");
  assert.equal(result.moved, 1);
  assert.equal(result.next?.id, s2.id);
  assert.equal(listTasks().find((t) => t.id === open.id)!.sprintId, s2.id);
  assert.equal(listTasks().find((t) => t.id === done.id)!.sprintId, s1.id, "done work stays on the record");
  assert.equal(result.sprint.state, "closed");
  const third = completeSprint(s2.id, "next");
  assert.ok(third.next && third.next.id !== s2.id, "closing the last sprint creates the next one");
});

test("bulk updates skip a status from another board rather than failing", () => {
  reset();
  const other = createBoard({ name: "Other" });
  const here = createTask({ title: "here" });
  const there = createTask({ title: "there", boardId: other.id });
  const rows = bulkUpdate({ ids: [here.id, there.id], patch: { statusId: "done", priority: "urgent" } });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === here.id)!.statusId, "done");
  assert.notEqual(rows.find((r) => r.id === there.id)!.statusId, "done");
  assert.ok(rows.every((r) => r.priority === "urgent"));
});

console.log(`\nboards: ${passed} passed, 0 failed`);
