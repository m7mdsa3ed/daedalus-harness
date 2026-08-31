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
import { applyReorder, createTask, listTasks, updateTask } from "../src/tasks-board.js";

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
console.log(`\nboards: ${passed} passed, 0 failed`);
