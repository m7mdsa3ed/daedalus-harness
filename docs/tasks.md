# Tasks

The harness's own task workspace: `/board/<boardId>`, backed by
`server/src/boards.ts` + `server/src/tasks-board.ts` + `server/src/routes/tasks.ts`
on the server and `client/src/components/tasks/` on the client. Standalone — no
foreign keys to sessions or agents, and the routine `task` action is the one
place an agent writes to it.

## Model

- **A board is a project of work, not a kanban.** It owns a `key` (`WEB`), its
  columns (`board_statuses`), sprints, saved views (`board_views`) and custom
  field definitions (`boards.custom_fields`). `projectId` is a pointer at a
  project and nothing more: a project's deletion leaves the board standing.
- **A task's key is minted, not stored as text.** `tasks.number` is a per-board
  sequence taken from `boards.next_number` inside the create transaction, so two
  creates on one board can never share a number; the client draws `KEY-n`. A
  task moved to another board takes a fresh number from that board. Pre-key rows
  have no number and `ensureDefaultBoard` backfills them at boot, in creation
  order — the same idempotent seed that made legacy statuses legible.
- **A column has a category, and the category is what the harness knows.**
  `board_statuses.category` is `todo | in_progress | done`. Entering a `done`
  column stamps `tasks.completed_at`; leaving one clears it; recategorising a
  column re-stamps every task in it. Sprint progress, the "done this week"
  reading and the strike-through all read the stamp, never the column's name.
  `wip_limit` is advisory — the board shows a column over it, nothing refuses
  the move.
- **The tree is one column.** `tasks.parent_id` is an epic's children or a
  task's subtasks, read either way by the parent's `type`. A parent must be on
  the same board and never a descendant (`assertParent` walks up). Deleting a
  parent *detaches* its children; a board move detaches them too.
- **Every change is written to `task_activity` by the one function that writes
  tasks** (`updateTask`, plus `created`/`commented`/`linked` markers), so the
  detail panel shows a history without diffing rows. Ids stay ids in the log;
  the client resolves names against the board it has.
- **Sprints are `planned → active → closed`, one active per board.** Starting
  a second is refused rather than silently closing the first. Completing one
  asks where the open tasks go (`backlog` or `next`, creating the next sprint
  if there is none) — the same shape as a column delete asking where its tasks
  go. Done tasks stay on the closed sprint as its record.
- **Links are directed rows** (`task_links`: `blocks | relates | duplicates`),
  read from both ends; `relates` is symmetric and de-duplicated either way.
- **Custom fields are declared on the board and valued on the task**
  (`tasks.custom`, keyed by the field's id, so a rename keeps the values).
- **`tasks.number` and `tasks.archived` are nullable, on purpose.** drizzle-kit
  reads a NOT NULL column whose default is `0`/`false` as having *no* default
  and plans a `delete from tasks` before adding it to a populated table (and a
  SQL-spelled default makes it rebuild the table on every push). A nullable
  column is a plain `ALTER TABLE … ADD` with no data-loss path. Null reads as
  "unnumbered" (boot backfills it) and "not archived".
- **No foreign keys, on purpose.** Every cascade is written out by hand in one
  transaction (`deleteBoard`, `deleteStatus`, `deleteSprint`, `deleteTask`),
  because a column delete is a question ("where do its tasks go?") and a task
  delete must not take its children. `reconcileTaskStatuses` repairs what a
  backup import can leave dangling (column, sprint, parent).

## API

`GET /api/boards` answers everything the switcher needs in one request —
boards, statuses, sprints, views. Tasks are `GET /api/tasks` (all boards; the
client filters), `GET /api/tasks/:id` for the detail (comments, activity,
links, children), `GET /api/tasks/by-key/:key` for deep links. Writes answer
with the row(s) they changed: `POST /api/tasks/reorder` the whole list,
`POST /api/tasks/bulk` the rows it touched. Comments and links hang off
`/api/tasks/:id/…` and are deleted by their own id.

## Client

- **The pure half is `lib/tasks-view.ts`**: filters, grouping, sorting, the
  derived facts (overdue, checklist progress, sprint progress) and the
  `ViewState` ↔ saved-view mapping. A saved view is exactly one `ViewState`,
  read defensively (`viewStateFrom`) because the server stores it free-form.
- **How a board is read is the reader's, not the board's.** Which board was
  last open, the layout, the live filters and which saved view they came from
  are all `localStorage` per board; a *saved* view is the deliberate exception
  and lives on the server so it can be shared.
- **One contract for every view** (`components/tasks/types.ts: ViewProps`):
  the board's rows, the visible list, the full list for parents, and the verbs.
  A view never touches the query cache; the page (`index.tsx`) is the one place
  that does. Views: board (kanban, dnd-kit, WIP limits, quick-add per column),
  list (grouped, collapsible, quick-add inherits the group), table (columns are
  the view's, every cell is a picker), calendar (by due date), timeline (bars
  from start to due, children under their parent), sprints (active, planned,
  backlog, closed).
- **The atoms and the pickers are one file** (`fields.tsx`) so the card, the
  row, the table cell, the detail panel and the bulk bar agree on what a
  priority looks like and how a status is chosen.
- **The open task is a search param** (`?task=<id>`), so a task is a URL that
  survives reload and can be copied; opening a task on another board navigates
  to that board.
- **The cache reconciles from the answer.** Create/update upsert the row (and
  patch the open detail's `task`), reorder adopts the list verbatim, bulk
  merges; the writes that rehome tasks (column delete, board delete, sprint
  close/delete, category change) invalidate the list too. A task's detail is
  its own key (`taskDetailKey`), invalidated by anything that touches it.

## Tests

`cd server && pnpm test:boards` — keys and numbering, backfill, completion
stamping, the parent rules, activity, sprints, bulk, plus the original column
and reorder contracts. Runs against a temp database; delete
`/tmp/daedalus-test-boards` after a schema change so it is re-pushed.
