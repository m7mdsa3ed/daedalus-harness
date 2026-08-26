/* ── Dependencies ──
   A dependency is a row in a join table (`pm_task_deps`), not a field on the
   task, so unlike every other tab in the editor this one cannot read its data
   out of the slim task in the store: it fetches the board's whole dependency
   graph once on open (`GET /api/boards/:id/dependencies`, one range scan) and
   keeps it in local state. That one payload answers both directions — what
   this task is *blocked by* and what it *blocks* — and carries the server's
   own `blockedTaskIds`, computed with the board's done-category rule.

   Adding an edge is guarded by `wouldCycle`, a pure reachability check over
   the same edge list, so a candidate that would close a loop is never offered
   in the first place (the search list filters with it) rather than being
   offered and refused. It is exported because the timeline draws the same
   graph and needs the same answer before it lets a bar be dropped.

   `BlockedBadge` is the other half: pure over data it is handed — no fetch, no
   store — so a memo'd task card can render it thousands of times. */
import * as React from "react"
import { AlertTriangleIcon, LinkIcon, PlusIcon, XIcon } from "lucide-react"

import { reportError } from "@/lib/errors"
import { loadSettings, type ServerSettings } from "@/lib/settings"
import { useActions, type Actions } from "@/lib/actions"
import {
  hasDependencyGraph,
  loadDependencyGraph,
  patchDependencyGraph,
  useDependencyGraph,
} from "@/lib/pm/dependencies"
import type { Board, Task, TaskDep } from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Pure graph helpers (no React, no fetch — safe in a memo, a sort or a drop
// handler on the timeline)

/** The edge list this module reasons over. `taskId` depends on (is blocked by)
    `dependsOnId` — the same direction the server's join table stores. */
export type DepEdges = readonly TaskDep[]

/** `dependsOn` adjacency: task id → the ids it waits for. */
function adjacency(edges: DepEdges): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const edge of edges) {
    const to = map.get(edge.taskId)
    if (to) to.push(edge.dependsOnId)
    else map.set(edge.taskId, [edge.dependsOnId])
  }
  return map
}

/**
 * Would adding "`from` depends on `to`" close a loop?
 *
 * True when `from === to`, or when `from` is already reachable from `to` by
 * following `dependsOn` edges — i.e. `to` (directly or transitively) already
 * waits for `from`, so the new edge would make each wait for the other.
 * Pure and allocation-light: one adjacency map, one iterative DFS with a
 * visited set, so a cyclic graph (which the server should never produce, but a
 * stale client copy might) terminates instead of hanging.
 */
export function wouldCycle(graph: DepEdges, from: string, to: string): boolean {
  if (from === to) return true
  const adj = adjacency(graph)
  const seen = new Set<string>([to])
  const stack = [to]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === from) return true
    for (const next of adj.get(id) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return false
}

/** The board's own definition of done — a done-category column — with
    `completedAt` as the fallback for a task whose column is not in the passed
    board (a partial/filtered config). Same rule as epic-progress. */
function isDone(task: Task, board?: Board): boolean {
  const columns = board?.columns ?? []
  const column = columns.find((entry) => entry.id === task.columnId)
  if (column) return column.category === "done"
  return task.completedAt !== null
}

/**
 * The tasks `taskId` waits for that are not finished yet — the blocked set,
 * derived rather than fetched. Dependencies whose task is not in `tasks`
 * (archived, trashed, another page) are skipped: the server's
 * `blockedTaskIds` is the authority for those, and `BlockedBadge` takes it.
 */
export function unfinishedDeps(
  graph: DepEdges,
  taskId: string,
  tasks: readonly Task[],
  board?: Board
): Task[] {
  const out: Task[] = []
  for (const edge of graph) {
    if (edge.taskId !== taskId) continue
    const dep = tasks.find((row) => row.id === edge.dependsOnId)
    if (dep && !isDone(dep, board)) out.push(dep)
  }
  return out
}

// ---------------------------------------------------------------------------
// Blocked badge — pure, memo'd, droppable onto a task card

/**
 * "Blocked" marker for a task card / list row. Handed data, never fetching:
 * pass `dependencies` (+ the board's tasks) for an exact count, or just
 * `blockedTaskIds` from `GET /api/boards/:id/dependencies` for the flag alone.
 * Renders nothing when the task is not blocked, so it costs one array scan.
 */
export const BlockedBadge = React.memo(function BlockedBadge({
  task,
  tasks,
  board,
  dependencies,
  blockedTaskIds,
  className,
}: {
  task: Task
  /** The board's loaded tasks — only needed with `dependencies`. */
  tasks?: readonly Task[]
  /** Only needed with `dependencies`, to read the done-category columns. */
  board?: Board
  /** Edge list; with it the badge can say *how many* are unfinished. */
  dependencies?: DepEdges
  /** The server's precomputed set — enough on its own for the flag. */
  blockedTaskIds?: ReadonlySet<string> | readonly string[]
  className?: string
}) {
  const count =
    dependencies && tasks ? unfinishedDeps(dependencies, task.id, tasks, board).length : 0

  const flagged = Array.isArray(blockedTaskIds)
    ? blockedTaskIds.includes(task.id)
    : blockedTaskIds instanceof Set
      ? blockedTaskIds.has(task.id)
      : false

  if (count === 0 && !flagged) return null

  return (
    <Badge
      variant="outline"
      title={
        count > 0
          ? `Blocked by ${count} unfinished ${count === 1 ? "task" : "tasks"}`
          : "Blocked by an unfinished task"
      }
      className={cn("gap-1 border-destructive/30 text-destructive", className)}
    >
      <AlertTriangleIcon className="size-3" />
      {count > 0 ? `Blocked · ${count}` : "Blocked"}
    </Badge>
  )
})

// ---------------------------------------------------------------------------
// The tab

/* The editor is opened from views that do not carry `actions` in their props
   (PmViewProps is board/tasks/onOpenTask), so this builds its own from the
   active server the way task-editor does; a caller that already has a set
   passes it and skips the second one. */
function useOwnActions(provided?: Actions): Actions {
  const [settings] = React.useState(() => loadSettings())
  const own = useActions(settings as ServerSettings)
  return provided ?? own
}

/** How many candidates the search list renders at once — a 5k-task board must
    not put 5k cmdk items in the DOM. Past it the user keeps typing. */
const CANDIDATE_LIMIT = 50

function StatusDot({ board, task }: { board: Board; task: Task }) {
  const column = board.columns.find((entry) => entry.id === task.columnId)
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        column?.color
          ? undefined
          : column?.category === "done"
            ? "bg-primary"
            : column?.category === "active"
              ? "bg-foreground/60"
              : "bg-muted-foreground/40"
      )}
      style={column?.color ? { background: column.color } : undefined}
    />
  )
}

const DepRow = React.memo(function DepRow({
  board,
  task,
  onRemove,
  onOpenTask,
  removeLabel,
  busy,
}: {
  board: Board
  task: Task
  onRemove: (id: string) => void
  onOpenTask?: (id: string) => void
  removeLabel: string
  busy: boolean
}) {
  const column = board.columns.find((entry) => entry.id === task.columnId)
  const done = isDone(task, board)

  return (
    <div className="flex items-center gap-2 rounded-lg py-1 pr-1 pl-2 hover:bg-muted">
      <StatusDot board={board} task={task} />
      <button
        type="button"
        onClick={onOpenTask ? () => onOpenTask(task.id) : undefined}
        disabled={!onOpenTask}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left disabled:cursor-default"
      >
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{task.key}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            done && "text-muted-foreground line-through"
          )}
        >
          {task.title}
        </span>
      </button>
      {column && (
        <span
          className={cn(
            "shrink-0 text-[11px]",
            done ? "text-muted-foreground" : "text-foreground/70"
          )}
        >
          {column.name}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        title={removeLabel}
        aria-label={removeLabel}
        disabled={busy}
        onClick={() => onRemove(task.id)}
      >
        <XIcon />
      </Button>
    </div>
  )
})

export function DependencyPicker({
  board,
  task,
  tasks: provided,
  actions: providedActions,
  onOpenTask,
}: {
  board: Board
  task: Task
  /** The board's loaded tasks; falls back to the store, like subtask-tree. */
  tasks?: Task[]
  /** Optional: the editor hands its own down instead of minting a second set. */
  actions?: Actions
  /** Optional: walk into a dependency the way the subtask tree walks children. */
  onOpenTask?: (id: string) => void
}) {
  const actions = useOwnActions(providedActions)
  const { state } = useStore()
  const stored = state.pmTasks[board.id]
  const tasks = provided ?? stored ?? []

  const [busy, setBusy] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  const boardId = board.id

  /* The board's one graph (lib/pm/dependencies): the badges on the cards
     behind this dialog and the timeline's arrows read the same object, so an
     edge added here shows up there without a second fetch. */
  const graph = useDependencyGraph(actions, boardId)
  const loading = !hasDependencyGraph(boardId)

  const reload = React.useCallback(async () => {
    try {
      await loadDependencyGraph(actions, boardId, { force: true })
    } catch (error) {
      reportError(error, "Couldn't load the dependencies")
    }
  }, [actions, boardId])

  const edges = graph.dependencies

  const byId = React.useMemo(() => {
    const map = new Map<string, Task>()
    for (const row of tasks) map.set(row.id, row)
    return map
  }, [tasks])

  /** What this task waits for, and what waits for it — both out of the one
      payload, so "blocks" costs a filter rather than a second endpoint. */
  const blockedBy = React.useMemo(
    () =>
      edges
        .filter((edge) => edge.taskId === task.id)
        .map((edge) => byId.get(edge.dependsOnId))
        .filter((row): row is Task => row !== undefined),
    [edges, byId, task.id]
  )

  const blocks = React.useMemo(
    () =>
      edges
        .filter((edge) => edge.dependsOnId === task.id)
        .map((edge) => byId.get(edge.taskId))
        .filter((row): row is Task => row !== undefined),
    [edges, byId, task.id]
  )

  const unfinished = React.useMemo(
    () => blockedBy.filter((row) => !isDone(row, board)),
    [blockedBy, board]
  )

  /* Candidates: live tasks of this board, minus self, minus what is already a
     dependency, minus anything that would close a loop. The cycle check runs
     over the current edge list once per candidate — cheap, and it is the only
     honest way to keep an impossible edge out of the list rather than letting
     the server refuse it. Matching is done here (not by cmdk) so the list can
     be sliced: `shouldFilter={false}`. */
  const candidates = React.useMemo(() => {
    const existing = new Set(
      edges.filter((edge) => edge.taskId === task.id).map((edge) => edge.dependsOnId)
    )
    const needle = query.trim().toLowerCase()
    const out: Task[] = []
    let matched = 0
    for (const row of tasks) {
      if (row.id === task.id) continue
      if (row.deletedAt !== null || row.archivedAt !== null) continue
      if (existing.has(row.id)) continue
      if (needle && !`${row.key} ${row.title}`.toLowerCase().includes(needle)) continue
      if (wouldCycle(edges, task.id, row.id)) continue
      matched += 1
      if (out.length < CANDIDATE_LIMIT) out.push(row)
    }
    return { shown: out, matched }
  }, [tasks, edges, task.id, query])

  const add = async (dependsOnId: string) => {
    setOpen(false)
    setQuery("")
    setBusy(true)
    // Optimistic: the endpoint answers with no body, so the edge the user just
    // picked goes in immediately and the reload only reconciles blockedTaskIds.
    patchDependencyGraph(boardId, (current) => ({
      dependencies: [...current.dependencies, { taskId: task.id, dependsOnId }],
      blockedTaskIds: current.blockedTaskIds,
    }))
    try {
      await actions.addDependency(boardId, task.id, dependsOnId)
      await reload()
    } catch (error) {
      reportError(error, "Couldn't add the dependency")
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (dependsOnId: string, taskId = task.id) => {
    setBusy(true)
    patchDependencyGraph(boardId, (current) => ({
      dependencies: current.dependencies.filter(
        (edge) => !(edge.taskId === taskId && edge.dependsOnId === dependsOnId)
      ),
      blockedTaskIds: current.blockedTaskIds,
    }))
    try {
      await actions.removeDependency(boardId, taskId, dependsOnId)
      await reload()
    } catch (error) {
      reportError(error, "Couldn't remove the dependency")
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 p-4">
      {unfinished.length > 0 && (
        <p className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          Blocked by {unfinished.length} unfinished {unfinished.length === 1 ? "task" : "tasks"}
        </p>
      )}

      <section className="space-y-1">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-[11px] font-medium text-muted-foreground">
            Blocked by{blockedBy.length > 0 ? ` · ${blockedBy.length}` : ""}
          </h3>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <Button variant="outline" size="xs" disabled={busy}>
                  <PlusIcon /> Add
                </Button>
              }
            />
            <PopoverContent align="end" className="w-[22rem] gap-0 p-0">
              <Command shouldFilter={false} className="bg-transparent">
                <CommandInput
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search tasks by key or title…"
                />
                <CommandList className="max-h-64">
                  <CommandEmpty>
                    {tasks.length <= 1 ? "No other tasks on this board." : "No task matches."}
                  </CommandEmpty>
                  <CommandGroup heading="Depends on">
                    {candidates.shown.map((row) => (
                      <CommandItem
                        key={row.id}
                        value={row.id}
                        onSelect={() => void add(row.id)}
                        className="gap-2"
                      >
                        <StatusDot board={board} task={row} />
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {row.key}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{row.title}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  {candidates.matched > candidates.shown.length && (
                    <p className="px-3 pb-2 text-[11px] text-muted-foreground">
                      {candidates.matched - candidates.shown.length} more — keep typing to narrow.
                    </p>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        {loading && blockedBy.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">Loading dependencies…</p>
        ) : blockedBy.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            Nothing blocks this task.
          </p>
        ) : (
          blockedBy.map((row) => (
            <DepRow
              key={row.id}
              board={board}
              task={row}
              busy={busy}
              removeLabel={`Remove dependency on ${row.key}`}
              onRemove={(id) => void remove(id)}
              onOpenTask={onOpenTask}
            />
          ))
        )}
      </section>

      <section className="space-y-1">
        <h3 className="px-1 text-[11px] font-medium text-muted-foreground">
          Blocks{blocks.length > 0 ? ` · ${blocks.length}` : ""}
        </h3>
        {blocks.length === 0 ? (
          <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <LinkIcon className="size-3" /> This task blocks nothing.
          </p>
        ) : (
          blocks.map((row) => (
            <DepRow
              key={row.id}
              board={board}
              task={row}
              busy={busy}
              removeLabel={`${row.key} no longer depends on ${task.key}`}
              /* The edge is owned by the *other* task, so removing it from
                 this side deletes `row → task`, not `task → row`. */
              onRemove={() => void remove(task.id, row.id)}
              onOpenTask={onOpenTask}
            />
          ))
        )}
      </section>
    </div>
  )
}
