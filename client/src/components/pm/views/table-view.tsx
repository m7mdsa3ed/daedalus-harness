import * as React from "react"
import {
  AlertTriangleIcon,
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  TrashIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Assignees,
  ColumnDot,
  DueDate,
  LabelChips,
  PRIORITY_NAMES,
  PriorityFlag,
} from "@/components/pm/views/list-view"
import type { Actions } from "@/lib/actions"
import { useActions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { byRank, sortTasks, type SortKey } from "@/lib/pm/filtering"
import type { BulkOp, BulkPatch, IssueType, Label, PmViewProps, Task } from "@/lib/pm/types"
import { loadSettings, type ServerSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

/* ── Table view ──
   The spreadsheet reading of a board: every field in a column, sortable by
   header click, and — the reason this view exists rather than being a denser
   list — multi-select with a bulk bar. Tasks arrive already filtered from
   pm-page; sorting is client-side over that array (the whole board is in the
   store, so a sort is a compare, not a round trip).

   Every bulk action is exactly one `actions.bulkTasks` call — one server
   transaction, one response, one re-render — and the selection clears once it
   lands. The one exception is add/remove-label: a bulk PATCH sets `labelIds`
   wholesale, so adding a label to rows with different label sets is issued as
   one call per distinct resulting set (usually one or two). */

const WINDOW = 500

// ---------------------------------------------------------------------------
// Sorting

type TableSortKey =
  | "key"
  | "title"
  | "column"
  | "type"
  | "priority"
  | "labels"
  | "assignees"
  | "dueDate"
  | "storyPoints"

interface TableSort {
  key: TableSortKey
  dir: "asc" | "desc"
}

/** Keys lib/pm/filtering already compares — reuse its comparator rather than
    keeping a second copy of "nulls sink last". */
const SHARED: Partial<Record<TableSortKey, SortKey>> = {
  title: "title",
  priority: "priority",
  dueDate: "dueDate",
  storyPoints: "storyPoints",
}

interface SortContext {
  columnOrder: Map<string, number>
  typeOrder: Map<string, number>
  labels: Map<string, Label>
}

/** `KEY-12` sorts after `KEY-9`, so the numeric suffix is what compares. */
function keyNumber(key: string): number {
  const n = Number(key.slice(key.lastIndexOf("-") + 1))
  return Number.isFinite(n) ? n : 0
}

const rank = (order: Map<string, number>, id: string | null) =>
  (id === null ? undefined : order.get(id)) ?? Number.POSITIVE_INFINITY

function localCompare(a: Task, b: Task, key: TableSortKey, ctx: SortContext): number {
  switch (key) {
    case "key":
      return keyNumber(a.key) - keyNumber(b.key) || a.key.localeCompare(b.key)
    case "column":
      return rank(ctx.columnOrder, a.columnId) - rank(ctx.columnOrder, b.columnId)
    case "type":
      return rank(ctx.typeOrder, a.typeId) - rank(ctx.typeOrder, b.typeId)
    case "labels":
      return firstLabel(a, ctx).localeCompare(firstLabel(b, ctx))
    case "assignees":
      return (a.assignees[0] ?? "￿").localeCompare(b.assignees[0] ?? "￿")
    default:
      return 0
  }
}

const firstLabel = (task: Task, ctx: SortContext) =>
  task.labelIds.map((id) => ctx.labels.get(id)?.name).find(Boolean) ?? "￿"

function sortRows(tasks: Task[], sort: TableSort | null, ctx: SortContext): Task[] {
  if (!sort) return byRank(tasks)
  const shared = SHARED[sort.key]
  if (shared) return sortTasks(tasks, { key: shared, dir: sort.dir })
  const sign = sort.dir === "desc" ? -1 : 1
  return [...tasks].sort((a, b) => sign * localCompare(a, b, sort.key, ctx))
}

// ---------------------------------------------------------------------------
// Rows

interface RowProps {
  task: Task
  index: number
  selected: boolean
  labels: Map<string, Label>
  columnNames: Map<string, { name: string; color: string | null }>
  typeNames: Map<string, string>
  /** Waiting on an unfinished dependency — from the board's one graph fetch. */
  blocked?: boolean
  onOpen: (id: string) => void
  onToggle: (id: string, index: number, shift: boolean) => void
}

const TableRowItem = React.memo(function TableRowItem({
  task,
  index,
  selected,
  labels,
  columnNames,
  typeNames,
  blocked,
  onOpen,
  onToggle,
}: RowProps) {
  // Base UI's onCheckedChange does not carry the modifier keys, so the shift
  // state is read off the pointer event that precedes it.
  const shift = React.useRef(false)
  const column = columnNames.get(task.columnId)
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      onClick={() => onOpen(task.id)}
      className="cursor-pointer"
    >
      <TableCell className="w-9 px-3">
        <span
          className="flex items-center"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            shift.current = event.shiftKey
          }}
        >
          <Checkbox
            aria-label={`Select ${task.key}`}
            checked={selected}
            onCheckedChange={() => onToggle(task.id, index, shift.current)}
          />
        </span>
      </TableCell>
      <TableCell className="font-mono text-[11px] text-muted-foreground">{task.key}</TableCell>
      <TableCell className="max-w-[28rem]">
        <span className="flex min-w-0 items-center gap-1.5">
          {blocked && (
            <AlertTriangleIcon
              aria-label="Blocked by an unfinished task"
              className="size-3.5 shrink-0 text-destructive"
            />
          )}
          <span
            className={cn(
              "min-w-0 truncate",
              task.completedAt !== null ? "text-muted-foreground line-through" : "text-foreground"
            )}
          >
            {task.title}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2 text-muted-foreground">
          <ColumnDot color={column?.color} />
          {column?.name ?? "—"}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {(task.typeId && typeNames.get(task.typeId)) || "—"}
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <PriorityFlag priority={task.priority} />
          {PRIORITY_NAMES[task.priority] ?? task.priority}
        </span>
      </TableCell>
      <TableCell>
        <LabelChips labelIds={task.labelIds} labels={labels} />
      </TableCell>
      <TableCell>
        <Assignees assignees={task.assignees} />
      </TableCell>
      <TableCell>
        <DueDate task={task} />
      </TableCell>
      <TableCell className="text-right text-muted-foreground tabular-nums">
        {task.storyPoints ?? "—"}
      </TableCell>
    </TableRow>
  )
})

// ---------------------------------------------------------------------------

const HEADS: Array<{ key: TableSortKey; label: string; className?: string }> = [
  { key: "key", label: "Key" },
  { key: "title", label: "Title" },
  { key: "column", label: "Status" },
  { key: "type", label: "Type" },
  { key: "priority", label: "Priority" },
  { key: "labels", label: "Labels" },
  { key: "assignees", label: "Assignees" },
  { key: "dueDate", label: "Due" },
  { key: "storyPoints", label: "Points", className: "text-right" },
]

export interface TableViewProps extends PmViewProps {
  /** The board's blocked set — pm-page fetches the graph once for every view. */
  blockedTaskIds?: ReadonlySet<string>
  /** pm-page passes the shared instance; without it the view builds its own
      against the active server (same store, same dispatch) so the bulk bar is
      never a dead button. */
  actions?: Actions
}

export function TableView({
  board,
  tasks,
  onOpenTask,
  actions: given,
  blockedTaskIds,
}: TableViewProps) {
  const settings = React.useMemo(() => loadSettings(), [])
  const own = useActions(settings as ServerSettings)
  const actions = given ?? own

  const [sort, setSort] = React.useState<TableSort | null>(null)
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  const [limit, setLimit] = React.useState(WINDOW)
  const lastIndex = React.useRef<number | null>(null)

  React.useEffect(() => {
    setSelected(new Set())
    setSort(null)
    setLimit(WINDOW)
    lastIndex.current = null
  }, [board.id])

  const labels = React.useMemo(
    () => new Map(board.labels.map((label) => [label.id, label])),
    [board.labels]
  )
  const columns = React.useMemo(
    () => [...board.columns].sort((a, b) => a.order - b.order),
    [board.columns]
  )
  const issueTypes = React.useMemo<IssueType[]>(
    () => [...board.issueTypes].sort((a, b) => a.order - b.order),
    [board.issueTypes]
  )
  const columnNames = React.useMemo(
    () => new Map(columns.map((column) => [column.id, { name: column.name, color: column.color }])),
    [columns]
  )
  const typeNames = React.useMemo(
    () => new Map(issueTypes.map((type) => [type.id, type.name])),
    [issueTypes]
  )
  const ctx = React.useMemo<SortContext>(
    () => ({
      columnOrder: new Map(columns.map((column, index) => [column.id, index])),
      typeOrder: new Map(issueTypes.map((type, index) => [type.id, index])),
      labels,
    }),
    [columns, issueTypes, labels]
  )

  const rows = React.useMemo(() => sortRows(tasks, sort, ctx), [tasks, sort, ctx])
  const visible = React.useMemo(() => rows.slice(0, limit), [rows, limit])

  // Every assignee the board actually uses — there are no accounts to list.
  const assigneeOptions = React.useMemo(() => {
    const names = new Set<string>()
    for (const task of tasks) for (const name of task.assignees) names.add(name)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [tasks])

  const tasksById = React.useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks]
  )

  const rowsRef = React.useRef(visible)
  rowsRef.current = visible

  const onOpen = React.useCallback((id: string) => onOpenTask(id), [onOpenTask])

  const onToggle = React.useCallback((id: string, index: number, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const anchor = lastIndex.current
      if (shift && anchor !== null) {
        const [from, to] = anchor <= index ? [anchor, index] : [index, anchor]
        for (let i = from; i <= to; i++) {
          const task = rowsRef.current[i]
          if (task) next.add(task.id)
        }
      } else if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    lastIndex.current = index
  }, [])

  const allVisibleSelected = visible.length > 0 && visible.every((task) => selected.has(task.id))
  const someVisibleSelected = !allVisibleSelected && visible.some((task) => selected.has(task.id))

  const toggleAllVisible = () => {
    setSelected((prev) => {
      if (visible.every((task) => prev.has(task.id))) {
        const next = new Set(prev)
        for (const task of visible) next.delete(task.id)
        return next
      }
      const next = new Set(prev)
      for (const task of visible) next.add(task.id)
      return next
    })
    lastIndex.current = null
  }

  const headClick = (key: TableSortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" }
      // asc → desc → back to the board's own rank order.
      return prev.dir === "asc" ? { key, dir: "desc" } : null
    })
  }

  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No tasks match this view.
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full caption-bottom text-sm">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-9 px-3">
                <Checkbox
                  aria-label="Select all visible tasks"
                  checked={allVisibleSelected}
                  indeterminate={someVisibleSelected}
                  onCheckedChange={toggleAllVisible}
                />
              </TableHead>
              {HEADS.map((head) => {
                const active = sort?.key === head.key
                return (
                  <TableHead key={head.key} className={cn("p-0", head.className)}>
                    <button
                      type="button"
                      onClick={() => headClick(head.key)}
                      className={cn(
                        "flex h-12 w-full items-center gap-1 px-3 text-xs font-medium transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                        head.className === "text-right" && "justify-end",
                        active ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {head.label}
                      {active &&
                        (sort.dir === "asc" ? (
                          <ArrowUpIcon className="size-3" />
                        ) : (
                          <ArrowDownIcon className="size-3" />
                        ))}
                    </button>
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr:last-child]:border-0">
            {visible.map((task, index) => (
              <TableRowItem
                key={task.id}
                task={task}
                index={index}
                selected={selected.has(task.id)}
                labels={labels}
                columnNames={columnNames}
                typeNames={typeNames}
                blocked={blockedTaskIds?.has(task.id)}
                onOpen={onOpen}
                onToggle={onToggle}
              />
            ))}
          </TableBody>
        </table>
        {rows.length > visible.length && (
          <div className="flex items-center justify-center gap-3 py-4">
            <span className="text-xs text-muted-foreground">
              Showing {visible.length} of {rows.length}
            </span>
            <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + WINDOW)}>
              Show more
            </Button>
          </div>
        )}
      </div>
      {selected.size > 0 && (
        <BulkBar
          actions={actions}
          boardId={board.id}
          columns={columns}
          labelList={board.labels}
          assigneeOptions={assigneeOptions}
          ids={[...selected]}
          tasksById={tasksById}
          onDone={() => {
            setSelected(new Set())
            lastIndex.current = null
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bulk bar

interface BulkBarProps {
  actions: Actions
  boardId: string
  columns: Array<{ id: string; name: string; color: string | null }>
  labelList: Label[]
  assigneeOptions: string[]
  ids: string[]
  tasksById: Map<string, Task>
  onDone: () => void
}

function BulkBar({
  actions,
  boardId,
  columns,
  labelList,
  assigneeOptions,
  ids,
  tasksById,
  onDone,
}: BulkBarProps) {
  const [busy, setBusy] = React.useState(false)

  const run = async (context: string, ops: BulkOp[], done?: () => void) => {
    setBusy(true)
    try {
      for (const op of ops) await actions.bulkTasks(boardId, op)
      done?.()
      onDone()
    } catch (error) {
      reportError(error, context)
    } finally {
      setBusy(false)
    }
  }

  const patch = (context: string, body: BulkPatch) =>
    run(context, [{ ids, op: { type: "patch", patch: body } }])

  /** A bulk PATCH replaces `labelIds`, so rows that already differ have to be
      batched by the set they end up with — still one transaction per group. */
  const changeLabel = (labelId: string, add: boolean) => {
    const groups = new Map<string, { ids: string[]; labelIds: string[] }>()
    for (const id of ids) {
      const task = tasksById.get(id)
      if (!task) continue
      const has = task.labelIds.includes(labelId)
      if (has === add) continue
      const next = add ? [...task.labelIds, labelId] : task.labelIds.filter((x) => x !== labelId)
      const key = [...next].sort().join("\u0000")
      const group = groups.get(key)
      if (group) group.ids.push(id)
      else groups.set(key, { ids: [id], labelIds: next })
    }
    if (groups.size === 0) return onDone()
    return run(
      add ? "Couldn't add the label" : "Couldn't remove the label",
      [...groups.values()].map((group) => ({
        ids: group.ids,
        op: { type: "patch" as const, patch: { labelIds: group.labelIds } },
      }))
    )
  }

  const undoable = (
    context: string,
    op: BulkOp["op"],
    inverse: BulkOp["op"],
    message: string
  ) => {
    const affected = [...ids]
    return run(context, [{ ids: affected, op }], () =>
      toast(message, {
        description: `${affected.length} ${affected.length === 1 ? "task" : "tasks"}`,
        action: {
          label: "Undo",
          onClick: () => {
            actions
              .bulkTasks(boardId, { ids: affected, op: inverse })
              .catch((error) => reportError(error, "Couldn't undo that"))
          },
        },
      })
    )
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border bg-card p-1.5 shadow-2xl ring-1 ring-foreground/5">
        <span className="px-2 text-xs font-medium text-foreground tabular-nums">
          {ids.length} selected
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" disabled={busy}>
                Move to
              </Button>
            }
          />
          <DropdownMenuContent side="top" className="w-56">
            <DropdownMenuLabel>Move to column</DropdownMenuLabel>
            {columns.map((column) => (
              <DropdownMenuItem
                key={column.id}
                onClick={() => patch("Couldn't move the tasks", { columnId: column.id })}
              >
                <ColumnDot color={column.color} />
                {column.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" disabled={busy}>
                Priority
              </Button>
            }
          />
          <DropdownMenuContent side="top" className="w-44">
            {PRIORITY_NAMES.map((name, priority) => (
              <DropdownMenuItem
                key={name}
                onClick={() => patch("Couldn't set the priority", { priority })}
              >
                <PriorityFlag priority={priority} />
                {name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" disabled={busy || labelList.length === 0}>
                Labels
              </Button>
            }
          />
          <DropdownMenuContent side="top" className="w-56">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Add label</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {labelList.map((label) => (
                  <DropdownMenuItem key={label.id} onClick={() => changeLabel(label.id, true)}>
                    {label.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Remove label</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {labelList.map((label) => (
                  <DropdownMenuItem key={label.id} onClick={() => changeLabel(label.id, false)}>
                    {label.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" disabled={busy}>
                Assign
              </Button>
            }
          />
          <DropdownMenuContent side="top" className="w-56">
            <DropdownMenuLabel>Assign to</DropdownMenuLabel>
            {assigneeOptions.map((name) => (
              <DropdownMenuItem
                key={name}
                onClick={() => patch("Couldn't assign the tasks", { assignees: [name] })}
              >
                {name}
              </DropdownMenuItem>
            ))}
            {assigneeOptions.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onClick={() => patch("Couldn't clear the assignees", { assignees: [] })}
            >
              Unassign
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="mx-1 h-5 w-px bg-border" />

        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            undoable(
              "Couldn't archive the tasks",
              { type: "archive" },
              { type: "unarchive" },
              "Archived"
            )
          }
        >
          <ArchiveIcon />
          Archive
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            undoable(
              "Couldn't trash the tasks",
              { type: "trash" },
              { type: "restore" },
              "Moved to Trash"
            )
          }
        >
          <TrashIcon />
          Trash
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onDone}>
          <XIcon />
        </Button>
      </div>
    </div>
  )
}

export default TableView
