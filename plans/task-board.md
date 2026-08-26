# Daedalus Harness — Full-Featured Task Board (ClickUp/Jira-class PM module)

## Context
Daedalus Harness is a generic ACP agent harness (Node/Hono bridge + React 19/Tailwind v4 client).
User wants a task/project board inside it benchmarked against ClickUp & Jira ("everything possible").
Decisions made with user:
- **Storage**: server-side, in the existing **SQLite database via Drizzle** (`server/src/db/`) —
  the codebase migrated off `data/*.json`; new entities must NOT reintroduce JSON files.
- **Integration**: PM module stays **separate** from ACP threads/agents (no dispatch/linking in v1).
- **Scope**: ALL four layers — Core PM essentials + Agile + Time/planning + Power features.
- Single bearer token ⇒ assignees are free-form strings (no accounts); avatars = initials.

## Feature set
**Core**: boards w/ custom status columns (color, category open/active/done, WIP limits), labels,
priorities 0–4, due/start dates, markdown descriptions, subtasks (recursive), checklists, comments,
per-task activity log, search/filter bar, kanban DnD, list view, table view w/ multi-select bulk ops,
archive/trash + restore/purge.
**Agile**: extensible issue types (epic/story/task/bug…), epics ARE tasks (`isEpic` type + `epicId`
children, roll-up progress), story points, time estimates, sprints (planned/active/completed, goal,
dates, completion snapshot), backlog w/ ranked drag, burndown + velocity charts (recharts).
**Time/planning**: calendar view (drag-reschedule), timeline/Gantt (drag bars / resize edges via native
pointer events; SVG dependency arrows), dependencies (`dependsOn`, blocked indicators), milestones.
**Power**: automations (WHEN trigger → IF conditions → THEN actions, server-side on every mutation),
custom fields per board (text/number/select/multiselect/date/checkbox/url) rendered generically,
saved views/filters per board, recurring tasks (spawn-on-complete), duplicate-board-as-template +
task templates, dashboard widgets (stat tiles + charts), notifications inbox (client-local read state),
⌘K palette entries, keyboard shortcuts (N=new, /=filter).

## Server — new subfolder `server/src/pm/` + tables in the existing database

Storage follows the codebase's own hard-won rules (see `db/schema.ts` header):
**references are real tables with FKs + cascades** (no id arrays nothing keeps honest), and
**append-only logs are tables, not embedded arrays** (the journal lesson — a comment or activity
append must not rewrite a whole document, and a long history costs no RAM and paginates as a range
scan). Config that is only ever read as a whole and never referenced by id (saved views, automation
rules, a task's checklists, a sprint's completion snapshot) stays a `{ mode: "json" }` column —
same pattern as `profiles.models`.

| File | Responsibility |
|---|---|
| `db/pm.ts` | All Drizzle table defs (below), re-exported from `db/schema.ts`'s barrel so `drizzle-kit generate` and `migrate()` pick them up with zero config changes. `pm_` prefix on every table. |
| `pm/schema.ts` | zod **input** schemas + wire types (BoardInput, TaskPatch, FilterSpec, AutomationRule, Recurrence, custom-field defs/values). Row types come from Drizzle `$inferSelect`; zod validates only what crosses HTTP. Pure. |
| `pm/boards.ts` | Board + config CRUD (columns/labels/types/fields/sprints/milestones/views/automations), trash/restore/purge, duplicate/template instantiation. `projects.ts` is the style model: sync `db` calls, `db.transaction` around multi-table writes. |
| `pm/tasks.ts` | Task queries (filter/sort/paginate **in SQL**), `applyMutation` pipeline, move/reorder, comments, bulk ops. |
| `pm/automations.ts` | Pure `matchRule`/`runAutomations(board, changeCtx, depth)` — unit-testable, no db access; actions returned as patches for `applyMutation` to apply. |
| `pm/reports.ts` | Burndown series (sprint window + completedAt), velocity from sprint snapshots, dashboard aggregates — SQL group-bys, not load-all-and-reduce. |
| `pm/routes.ts` | Hono sub-app with all endpoints; mounted once in index.ts. |

`index.ts` change (minimal): `import { pmRoutes } from "./pm/routes.js"; app.route("/api", pmRoutes);`
— registered AFTER the `app.use("/api/*")` auth middleware so PM routes inherit bearer auth.

Schema-change workflow is the committed one: edit `db/pm.ts`, `pnpm db:generate`, commit the SQL in
`server/drizzle/` — never `drizzle-kit push`. **Exactly one agent per workflow may run `db:generate`**
(migration files are serial and would conflict).

### Tables (`db/pm.ts`)
- Ids `randomUUID()`; timestamps epoch-ms `integer`; string-literal unions via `text({ enum })`
  (`erasableSyntaxOnly` — no TS enums).
- `pm_boards { id, name, description, color, keyPrefix, nextKey, defaultView, savedViews(json),
  automations(json), archivedAt, deletedAt, templateFor }` — savedViews/automations are whole-read
  config referenced by nothing, so JSON columns; everything tasks point AT is a table.
- Per-board config tables, all `boardId` FK → `pm_boards ON DELETE CASCADE`:
  `pm_columns { id, boardId, name, color, category(open|active|done), wipLimit, order }`,
  `pm_labels { id, boardId, name, color }`,
  `pm_issue_types { id, boardId, name, icon, isEpic, order }`,
  `pm_custom_fields { id, boardId, name, type, options(json), order }`,
  `pm_sprints { id, boardId, name, goal, startDate, endDate, state, snapshot(json) }`,
  `pm_milestones { id, boardId, name, date, reachedAt }`.
- `pm_tasks { id, boardId(cascade), key, title, descriptionMd, columnId, typeId, priority,
  assignees(json), startDate, dueDate, storyPoints, estimateMinutes, epicId(self, SET NULL),
  parentId(self, CASCADE — subtasks die with parent), sprintId(SET NULL → backlog),
  milestoneId(SET NULL), recurrence(json), customFieldValues(json, keyed by field id, validated
  against `pm_custom_fields` in applyMutation), checklists(json — small, whole-read),
  order, backlogRank, createdAt, updatedAt, completedAt, archivedAt, deletedAt, recurrenceParentId }`.
  `columnId` FK with **no cascade action** (RESTRICT): the delete-column endpoint takes a
  `moveTasksTo` target and moves first — a column delete must never eat tasks.
- Join tables, cascade both sides (dangling ids structurally impossible):
  `pm_task_labels (taskId, labelId)`, `pm_task_deps (taskId, dependsOnId)`.
- Append-only, own tables, lazily fetched + paginated (the journal pattern):
  `pm_comments { id, taskId(cascade), author, bodyMd, createdAt }`,
  `pm_activity { taskId(cascade), seq, at, actor, field, from(json), to(json) }`
  uniqueIndex `(taskId, seq)`.
- Indexes for the hot lists: `pm_tasks (boardId, deletedAt, archivedAt)` for the board fetch,
  `(boardId, columnId, order)`, `(boardId, sprintId)`, `(boardId, dueDate)` for calendar/timeline,
  uniqueIndex `(boardId, key)`.
- Human keys `KEY-seq`: allocate atomically inside the insert transaction with
  `UPDATE pm_boards SET next_key = next_key + 1 ... RETURNING next_key` — no read-modify-write
  race, no counter file. Prefix collisions on board create → 400.
- Ranks: integers spaced 1000 (`i*1000`); insert when gap ≤1 renormalizes the slice — one
  `db.transaction`, an UPDATE per shifted row, still one fsync. Same scheme for column `order`
  and `backlogRank`.
- Move op = `{columnId, index, sprintId?}`; bulk reorder `{scope, orderedIds}` for sorts/gestures.
- Soft delete mirrors sessions (`deletedAt` → restore → `?purge=1` hard-deletes; cascades and
  SET NULLs do the ref cleanup that JSON needed hand-written sweeps for).

### Mutation pipeline (`applyMutation` in tasks.ts)
Single choke point for EVERY task write, and the WHOLE pipeline runs in **one `db.transaction`**
(better-sqlite3 is synchronous, so this is safe and cheap — one fsync per HTTP request, and a
half-applied automation chain cannot be observed or persisted):
validate custom fields vs `pm_custom_fields` → apply patch + diff ChangeRecords (move into a
done-category column sets `completedAt`, out clears it) → append `pm_activity` rows → run
automations (each action recurses into applyMutation with depth+1 and ruleId added to a chain-set;
loop-safe structurally: MAX_CHAIN_DEPTH=4, per-chain rule dedup kills A→B→A cycles, whitelisted
field-setting actions only) → stamp updatedAt → recurrence spawn-on-complete (clone w/ fresh key,
reset checklists, no comments/activity carried, advance dates, `recurrenceParentId`).

### Query performance rules (the point of moving off JSON)
- List endpoints filter/sort/paginate **in SQL** (drizzle `and()`/`like`/`inArray` + limit/offset,
  `count()` for `{total, tasks}`) — never load-all-then-filter in JS.
- The board fetch returns **slim tasks**: comments and activity live in their own tables, so they
  are simply not joined — the task editor lazy-loads `GET .../comments` and `GET .../activity?after=`
  on open. A 5k-task board's kanban payload stays flat.
- Appending a comment or activity row writes one row — under the old JSON design it rewrote the
  entire board shard.
- `GET /api/search?q=` (⌘K) is a cross-board `LIKE` over title/key/description with a LIMIT —
  upgradeable to FTS5 later without touching the route shape; not v1.
- Reports aggregate in SQL (`GROUP BY sprintId`, `sum(storyPoints)`), returning series, not rows.

### REST surface (envelopes match existing: 201 create, 404 `{error:"not found"}`, 400 `{error:issues}`)
- Boards: `GET/POST /api/boards`, `GET/PATCH/DELETE /api/boards/:id` (PATCH not PUT — volatile
  `nextKey`; note this deliberate deviation in routes.ts header), `POST .../restore`,
  `POST .../duplicate {asTemplate}`, DELETE `?purge=1`.
- Board config sub-resources (columns/labels/issue-types/custom-fields): plain CRUD;
  DELETE column requires `?moveTasksTo=`.
- Tasks: `GET/POST /api/boards/:id/tasks` (query filters q/column/assignee/label/type/sprint=none|id/
  epic/parent/milestone/priorityGte/due/archived/trashed/limit/offset → `{total,tasks}`),
  `GET/PATCH .../tasks/:taskId`, `POST .../move`, `POST .../restore`, `DELETE ?purge=1`,
  `POST /api/boards/:id/reorder` (bulk ranks), `POST .../tasks/bulk` (multi-select ops — one
  transaction, one response).
- Per-task: `GET/POST .../comments`, `DELETE .../comments/:cid`, `GET .../activity?after=<seq>`.
- Sprints CRUD + `/start` + `/complete {moveIncompleteTo}` (snapshot frozen into `snapshot` json);
  milestones CRUD + `/reach`; saved views PUT/DELETE; automations CRUD + POST `/test` dry-run preview.
- Reports/search: `GET .../reports/burndown?sprintId=`, `.../reports/velocity`, `GET .../dashboard`,
  `GET /api/search?q=` cross-board (⌘K).

### Tests
New `server/test/pm.test.ts` in established style: the npm `test` script already sets
`DAEDALUS_DATA_DIR=/tmp/daedalus-test-data`; extend it to `... && tsx test/pm.test.ts` and have the
test rmSync that dir first — `db/index.ts` creates a fresh db and runs `migrate()` at import, so a
clean dir IS the seed. Use Hono's `app.request()` for HTTP-level coverage (export the app or a
factory from routes.ts). Cover: board defaults, key sequence under concurrent inserts, move/rank
renormalization, custom-field rejection, bulk ops, column-delete-with-moveTasksTo, cascade cleanup
(purge board → tasks/comments/labels gone; delete label → join rows gone), automation cascade
depth-cap + A→B→A termination, recurrence spawn, comment/activity pagination.

## Client

### Wiring (4 existing files)
- `lib/router.tsx` (React Router now — the old hand-rolled `router.ts` is gone): add path builders
  `tasksPath()` and `boardPath(boardId, view)`; the route tree lives in `app-shell.tsx`'s `<Routes>`,
  so add `/tasks` (overview hub) and `/b/:boardId/:view?` (default kanban) there, rendering
  `<ErrorBoundary name="pm"><PmPage/></ErrorBoundary>`. `navigateTo` already covers
  out-of-React navigation (⌘K, notifications).
- `components/app-shell.tsx`: widen `panels` record with `"pm"` (sidebar body: boards grouped
  Active/Templates/Archive + Inbox + New board) + the routes above.
- `lib/store.tsx` + `lib/actions.ts`: State gains `boards[]` (bootstrap Promise.all) + lazy
  `pmTasks: Record<boardId, Task[]>` (slim tasks; comments/activity are fetched by the task editor
  on open and NOT kept in the store); actions: refreshBoards/loadBoard/create/update/move/reorder/
  bulk/comment/delete/restore/archive, sprint/view/automation/field mutators, fetchReports — thin
  `api()` calls + dispatch; optimistic updates reconciled via upsert-one action; refetch-on-focus.
- `components/command-palette.tsx`: "Open Tasks", per-board entries, "New board", context-aware
  "New task", search endpoint results.

### New files
```
lib/pm/types.ts        # mirrored TS interfaces (server/client never import each other today; twin-comment both sides)
lib/pm/prefs.ts        # pins-pattern mini-store: ui.pm.view.<boardId>, ui.pm.collapsedColumns.*, ui.pm.inboxReadAt
lib/pm/filtering.ts    # pure applyFilters(tasks, FilterSpec) shared by every view (client-side, over the loaded board)
lib/pm/rank.ts         # optimistic rank math mirroring server (gap-1000 + renormalize)

components/pm/pm-page.tsx            # header (title, sprint selector, view tabs) + FilterBar + active view
components/pm/pm-overview.tsx        # /tasks hub: board cards, my-tasks widget, inbox
components/pm/pm-sidebar-panels.tsx  # SidebarPanel bodies for app-shell
components/pm/new-task-dialog.tsx    # quick-create (+ template pick)
components/pm/filter-bar.tsx         # chips + saved-view menu

components/pm/views/kanban-view.tsx / kanban-column.tsx / task-card.tsx   # DndContext here; WIP badges
components/pm/views/list-view.tsx / table-view.tsx (bulk bar) / backlog-view.tsx (sprint lanes + rank drag)
components/pm/views/calendar-view.tsx (day-cell droppables) / timeline-view.tsx (CSS-grid bars, pointer-drag/resize,
                                     SVG dep arrows — native Pointer Events like sidebar-resizer, NOT dnd-kit)
components/pm/views/dashboard-view.tsx

components/pm/charts/burndown-chart.tsx / velocity-chart.tsx   # recharts, --chart-1..5 tokens

components/pm/task/task-editor.tsx   # dialog: fields+md description left; tabs right (subtasks/checklists/
                                     # comments/activity/dependencies); comments+activity lazy-fetched here
components/pm/task/task-fields-form.tsx (react-hook-form+zod) / custom-field-renderer.tsx (generic per type)
components/pm/task/subtask-tree.tsx / checklist-editor.tsx / comments-thread.tsx (react-markdown+remark-gfm)
components/pm/task/activity-list.tsx / dependency-picker.tsx (cmdk search-add, blocked warnings) / recurrence-editor.tsx

components/pm/settings/board-settings-dialog.tsx (tabs shell) / columns-editor.tsx (dnd-kit vertical reorder)
components/pm/settings/labels-editor.tsx / issue-types-editor.tsx / custom-field-editor.tsx
components/pm/settings/automation-builder.tsx (WHEN→IF→THEN rows + Test dry-run) / sprint-editor.tsx
components/pm/settings/milestone-editor.tsx / template-flows.tsx
```

### Dependencies & conventions
- Add `@dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities` (no DnD lib exists today).
- Reuse: date-fns v4, recharts 3.8, react-markdown+remark-gfm, cmdk, react-day-picker calendar,
  sonner toasts (Undo action for archive/delete), `useConfirm()` for destructive flows, ui/* primitives.
- Style ONLY with semantic utilities (`bg-card`, `text-muted-foreground`, `border`…) — all palettes +
  custom themes then work untouched.
- dnd-kit gotchas: no `transition-transform` classes on sortable nodes; DragOverlay portaled outside
  ScrollArea; PointerSensor distance-6 so clicks open cards; KeyboardSensor for a11y; touch-action none
  on handles only.
- Client tsconfig: `verbatimModuleSyntax` (use `import type`) + `erasableSyntaxOnly` (no enums/param props).
- Render performance: task cards/rows are `memo`d with stable callbacks; per-view derived data goes
  through memoized `applyFilters`; list/table views render windowed slices past ~500 rows (plain
  slice + "show more", no virtualization lib in v1).

## Build order & execution strategy — orchestrated Workflows

Implementation runs as **one Workflow invocation per milestone**, sequential (I verify each gate between
runs). Inside a workflow: parallel build agents get **disjoint file-ownership sets** (no worktrees needed;
shared/existing files like router.tsx/app-shell.tsx/store.tsx/actions.ts/index.ts/db/schema.ts are owned
by exactly ONE agent per workflow); a final integration agent per workflow runs the typecheck/test gate
and fixes cross-file errors, looping until clean (`while` gate, bounded attempts).

1. **W1 — Server foundation** (~4 agents): (a) `db/pm.ts` + schema barrel export + `pnpm db:generate`
   (only this agent generates migrations) + `pm/schema.ts` first (everything imports these);
   (b) ∥ `pm/boards.ts` + sprint/milestone/view mutators; (c) ∥ `pm/tasks.ts` + `applyMutation`
   + move/bulk/comments; (d) ∥ `pm/automations.ts` + `pm/reports.ts` (pure modules against schema types);
   then (e) `pm/routes.ts`, index.ts mount, test-script edit + `test/pm.test.ts`; integration agent runs
   `tsc --noEmit && pnpm test` fix-loop. Gate: server tests green, migration SQL committed.
2. **W2 — Client core** (~6 agents): (a) wiring agent owns ALL existing-file edits: install @dnd-kit,
   lib/pm/types|prefs|filtering|rank.ts, router/shell/store/actions/palette edits (so later agents never
   touch shared files); then ∥ view agents on NEW files only: kanban(column/card/DnD), list+table,
   filter-bar+new-task-dialog, task-editor family (fields/checklists/comments/activity/subtasks),
   pm-page+overview+sidebar panels; integration agent `tsc -b && pnpm build` fix-loop.
3. **W3 — Agile** (~4 agents): (a) server sprints endpoints + reports.ts wiring into routes (+tests);
   ∥ (b) backlog-view + sprint editor/start-complete flow; (c) epic roll-up + burndown/velocity charts;
   integration gate.
4. **W4 — Time & planning** (~4 agents): ∥ calendar-view, timeline-view (native pointer events),
   dependency-picker + blocked indicators, milestones editor/markers; integration gate.
5. **W5 — Power features** (~5 agents): (a) server: custom-field validation finalize, saved-view/
   automation-test/dashboard/search endpoints; ∥ (b) custom-field renderer+editor; (c) automation builder
   + saved-views bar; (d) recurrence editor + templates flows; (e) dashboard widgets + inbox; integration gate.
6. **W6 — Polish** (1–2 agents): ⌘K deep-links, empty states/skeletons, shortcuts, rollback audit,
   large-board memoization/windowing pass.
7. **W7 — Hardening** (1 agent): index audit vs actual query plans (`EXPLAIN QUERY PLAN` on the hot
   endpoints), README/docs snippet, full final `tsc` + tests both sides.

Workflow notes: scripts are plain JS, `export const meta = {...}` required; no Date.now()/Math.random()
in scripts — pass any needed values via `args`; agents return raw data; each agent prompt carries its exact
file list + the conventions above + instruction to match surrounding code style. User does the visual UI
pass at the end (project convention: no browser automation).

## Risks / notes
- better-sqlite3 is synchronous single-process — one transaction per HTTP mutation is the whole
  concurrency story (matches how the rest of the server already works); WAL is already on, so the
  agent journal's streaming writes and a big board read don't block each other.
- Burndown reconstructs history from current state + completedAt (approximate for mid-sprint scope adds);
  velocity exact going forward via completion snapshots — document limitation.
- Timeline uses native pointer events, not dnd-kit (wrong shape for edge-resize).
- zod v4: use `z.url()` top-level format validators (v4 renamed string formats).
- Duplicated client/server types can drift — pm.test.ts asserts wire shapes end-to-end; pointer comments
  on both twins.
- Migration files are serial: exactly one agent per workflow runs `pnpm db:generate`, and its SQL is
  committed with the schema change (project rule — never `drizzle-kit push`).
- `importLegacyJson` is untouched — there is no legacy PM data to import.

## Critical files
- Modify: `server/src/index.ts` (mount), `server/src/db/schema.ts` (barrel re-export of `db/pm.ts`),
  `server/package.json` (test script), `client/src/lib/router.tsx`, `client/src/components/app-shell.tsx`
  (panels + `<Routes>`), `client/src/lib/store.tsx`, `client/src/lib/actions.ts`,
  `client/src/components/command-palette.tsx`.
- Follow patterns from: `server/src/projects.ts` (entity module over `db`, transactions, join tables),
  `server/src/db/schema.ts` (table style, enum text columns, index naming, doc-comment voice),
  `server/src/sessions.ts` (soft delete), `server/test/pipe.test.ts` (test harness style),
  `client/src/lib/pins.ts` (device-local mini-store), `client/src/lib/session-tabs.ts` (persistence keys).

## Verification
- Server: `cd server && pnpm exec tsc --noEmit && pnpm test` (pipe self-check + new pm.test.ts covering
  CRUD, moves/ranks, validation, cascades, automations loop-safety, recurrence, pagination).
- Client: `cd client && pnpm exec tsc -b && pnpm build` per milestone.
- UI: user manual pass (project convention — no browser automation/screenshots).
