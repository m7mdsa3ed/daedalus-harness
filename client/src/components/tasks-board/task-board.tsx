import * as React from "react"
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable"
import {
  ChevronLeft,
  ChevronRight,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  SquareKanban,
  Trash2,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { COLOR_DOT, type BoardStatus } from "@/lib/boards"
import type { Task, TaskStatus } from "@/lib/tasks-board"
import { TaskCard, TaskRow } from "./task-card"

const VIEW_STORAGE_KEY = "ui.boardView"

/** Ordered task lists per column id. Columns come from the board, so a status
    with no tasks still gets a (empty) bucket — which is what makes it a drop
    target at all. */
type Columns = Record<string, Task[]>

function groupByStatus(tasks: Task[], statuses: BoardStatus[]): Columns {
  const grouped: Columns = {}
  for (const status of statuses) grouped[status.id] = []
  for (const task of tasks) grouped[task.statusId]?.push(task)
  for (const list of Object.values(grouped)) list.sort((a, b) => a.order - b.order)
  return grouped
}

/**
 * Which column currently holds `id` — read from the DRAG STATE, not from the
 * server's list.
 *
 * This is the fix for dropping onto an empty column. `onDragOver` moves the
 * card into the target bucket as soon as the pointer crosses into it, so by the
 * time `onDragEnd` runs the card is the only thing in a column that was empty —
 * and dnd-kit reports `over.id` as the card itself rather than the column. The
 * old code resolved that id against the *server's* task list, which still said
 * the card was in its original column; source and target came out equal, the
 * within-column branch ran, the card was no longer at the index it looked for,
 * and the drop silently did nothing. The draft is the only thing that knows
 * where a card is mid-drag, so it is what gets asked.
 */
function columnOf(columns: Columns, id: string): string | undefined {
  for (const [statusId, list] of Object.entries(columns)) {
    if (list.some((task) => task.id === id)) return statusId
  }
  return undefined
}

const COLUMN_PREFIX = "column:"

/** A drop target id is either a column's or a card's; only the column's is
    namespaced, since a card's has to be its own id for `useSortable`. */
function statusFromOverId(columns: Columns, overId: string): string | undefined {
  return overId.startsWith(COLUMN_PREFIX)
    ? overId.slice(COLUMN_PREFIX.length)
    : columnOf(columns, overId)
}

/** One kanban column (a status): the drop target for its tasks. */
function Column({
  status,
  tasks,
  index,
  total,
  onNew,
  onTaskClick,
  onRename,
  onDelete,
  onMoveColumn,
}: {
  status: BoardStatus
  tasks: Task[]
  index: number
  total: number
  onNew: (statusId: TaskStatus) => void
  onTaskClick: (task: Task) => void
  onRename: (status: BoardStatus) => void
  onDelete: (status: BoardStatus) => void
  onMoveColumn: (status: BoardStatus, delta: -1 | 1) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${status.id}` })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        /* On a phone a column is nearly the viewport and snaps into place, so
           the horizontal scroller reads as a pager rather than as a strip of
           half-visible columns; from `sm` up it is the fixed 18rem it was. */
        "flex w-[85vw] max-w-[19rem] shrink-0 snap-start flex-col rounded-xl border bg-muted/30 sm:w-72 sm:max-w-none",
        isOver && "border-primary/40 bg-muted/60",
      )}
    >
      <div className="flex items-center justify-between gap-1 px-3 py-2.5">
        <span className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {status.color && (
            <span className={cn("size-2 shrink-0 rounded-full", COLOR_DOT[status.color])} />
          )}
          <span className="truncate">{status.name}</span>
          <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
            {tasks.length}
          </span>
        </span>
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => onNew(status.id)}
            aria-label={`Add task to ${status.name}`}
            title={`Add task to ${status.name}`}
            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-7"
          >
            <Plus className="size-4" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`${status.name} column options`}
                  className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-7"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => onRename(status)}>
                <Pencil className="size-4" /> Rename…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index === 0}
                onClick={() => onMoveColumn(status, -1)}
              >
                <ChevronLeft className="size-4" /> Move left
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index === total - 1}
                onClick={() => onMoveColumn(status, 1)}
              >
                <ChevronRight className="size-4" /> Move right
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                // The board's last column has nowhere to send its tasks, and a
                // board with no columns has nothing to draw.
                disabled={total <= 1}
                onClick={() => onDelete(status)}
                className="text-destructive"
              >
                <Trash2 className="size-4" /> Delete column…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <div className="flex min-h-[2rem] flex-1 flex-col gap-2 p-2">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} />
          ))}
        </SortableContext>
        {tasks.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground">
            <SquareKanban className="size-5 opacity-50" />
            <p>Drop tasks here</p>
          </div>
        )}
      </div>
    </div>
  )
}

export function Board({
  tasks,
  statuses,
  onMove,
  onNew,
  onTaskClick,
  onAddColumn,
  onRenameColumn,
  onDeleteColumn,
  onMoveColumn,
}: {
  /** The board's tasks, already filtered for display. */
  tasks: Task[]
  /** The board's columns, left to right. */
  statuses: BoardStatus[]
  /** `{statusId: orderedTaskIds}` for the columns the drag touched. */
  onMove: (byStatus: Record<string, string[]>) => void
  onNew: (statusId: TaskStatus) => void
  onTaskClick: (task: Task) => void
  onAddColumn: () => void
  onRenameColumn: (status: BoardStatus) => void
  onDeleteColumn: (status: BoardStatus) => void
  onMoveColumn: (status: BoardStatus, delta: -1 | 1) => void
}) {
  const [view, setView] = React.useState<"board" | "list">(() =>
    localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "board",
  )
  React.useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, view)
  }, [view])

  /* The drag's own view of the board. Re-seeded whenever the server's list or
     the board's columns change — including right after a drop, which is what
     replaces the optimistic order with the committed one. */
  const [draft, setDraft] = React.useState<Columns>(() => groupByStatus(tasks, statuses))
  React.useEffect(() => {
    setDraft(groupByStatus(tasks, statuses))
  }, [tasks, statuses])

  /* Mouse and touch are separated on purpose. One PointerSensor with a distance
     constraint makes a finger that starts on a card ambiguous: the same gesture
     is both "scroll the column" and "pick the card up", and dnd-kit resolves it
     by taking the drag — so a phone could not scroll a column past its second
     card. Touch therefore activates on a *press* (a long-press, tolerant of the
     few pixels a finger drifts while held), which leaves every short swipe to
     the scroller; the mouse keeps the 4px distance it always had, since a
     pointer that is not also the scroll gesture has nothing to disambiguate. */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  )

  const reset = () => setDraft(groupByStatus(tasks, statuses))

  /** The list view's own grouping — the committed one, never the drag draft. */
  const listGroups = React.useMemo(() => groupByStatus(tasks, statuses), [tasks, statuses])

  /* Cross-column hover: take the card out of the column it is in and append it
     to the one under the pointer, so an empty column stops being empty and the
     card is visibly accepted. Appending rather than inserting at the pointer is
     deliberate — `onDragEnd` does the precise placement, and doing it in both
     places applied the move twice. */
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    setDraft((prev) => {
      const fromStatus = columnOf(prev, activeId)
      const targetStatus = statusFromOverId(prev, overId)
      if (!fromStatus || !targetStatus || fromStatus === targetStatus) return prev
      if (!prev[targetStatus]) return prev
      const moving = prev[fromStatus].find((task) => task.id === activeId)
      if (!moving) return prev
      return {
        ...prev,
        [fromStatus]: prev[fromStatus].filter((task) => task.id !== activeId),
        [targetStatus]: [...prev[targetStatus], moving],
      }
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return reset()
    const movedId = String(active.id)
    const overId = String(over.id)

    /* Where the card started, per the server, and where the drag has put it.
       They differ exactly when this was a cross-column move — including the
       empty-column case, where `over.id` is the moved card itself because it is
       now the only thing in that column. */
    const originStatus = tasks.find((task) => task.id === movedId)?.statusId
    const targetStatus = statusFromOverId(draft, overId) ?? columnOf(draft, movedId)
    if (!originStatus || !targetStatus || !draft[targetStatus]) return reset()

    const ids = draft[targetStatus].map((task) => task.id)
    const fromIndex = ids.indexOf(movedId)
    /* Dropped on a card → take its place. Dropped on the column's background →
       the end of the column, which is also the empty-column answer (the card is
       already the only entry there, so this is a move onto itself). */
    const overIndex = overId.startsWith(COLUMN_PREFIX) ? -1 : ids.indexOf(overId)
    let ordered: string[]
    if (fromIndex === -1) {
      /* The card is not in the target column's draft, which means `onDragOver`
         never committed — a drag fast enough to end in the same frame it
         crossed. Insert instead of moving, rather than dropping the gesture. */
      ordered = [...ids]
      ordered.splice(overIndex === -1 ? ordered.length : overIndex, 0, movedId)
    } else {
      ordered = arrayMove(ids, fromIndex, overIndex === -1 ? ids.length - 1 : overIndex)
    }

    /* Both ends of the move are sent, never just the target: the source column
       closed a gap and its remaining tasks need their positions rewritten too,
       or the next drop into it lands at a stale index. */
    const byStatus: Record<string, string[]> = { [targetStatus]: ordered }
    if (originStatus !== targetStatus && draft[originStatus]) {
      byStatus[originStatus] = draft[originStatus]
        .filter((task) => task.id !== movedId)
        .map((task) => task.id)
    }
    onMove(byStatus)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 sm:px-4">
        <ViewToggle view={view} onChange={setView} />
        <button
          type="button"
          onClick={() => onNew(statuses[0]?.id ?? "")}
          disabled={statuses.length === 0}
          aria-label="New task"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-4xl bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Plus className="size-4" />
          {/* The label is what makes the button read; the icon alone is enough
              once the toolbar above it is competing for the same narrow row. */}
          <span className="hidden min-[380px]:inline">New task</span>
        </button>
      </div>

      {view === "board" ? (
        <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:snap-none">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={reset}
          >
            {statuses.map((status, index) => (
              <Column
                key={status.id}
                status={status}
                index={index}
                total={statuses.length}
                tasks={draft[status.id] ?? []}
                onNew={onNew}
                onTaskClick={onTaskClick}
                onRename={onRenameColumn}
                onDelete={onDeleteColumn}
                onMoveColumn={onMoveColumn}
              />
            ))}
          </DndContext>
          <button
            type="button"
            onClick={onAddColumn}
            className="flex h-fit w-40 shrink-0 snap-start items-center gap-2 rounded-xl border border-dashed px-3 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-56 sm:py-2.5"
          >
            <Plus className="size-4" /> Add column
          </button>
        </div>
      ) : (
        <div className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 flex-col gap-5 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {/* Same grouping and same order as the board — the list is the board
              read down a column instead of across, so a status with no tasks
              (which is a real drop target there) is only noise here and is
              dropped. `draft` is deliberately not used: nothing drags in this
              view, so the server's order is always the right one. */}
          {statuses.map((status) => {
            const inStatus = listGroups[status.id] ?? []
            if (inStatus.length === 0) return null
            return (
              <section key={status.id} className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {status.color && (
                    <span className={cn("size-2 shrink-0 rounded-full", COLOR_DOT[status.color])} />
                  )}
                  <span className="truncate">{status.name}</span>
                  <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                    {inStatus.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => onNew(status.id)}
                    aria-label={`Add task to ${status.name}`}
                    title={`Add task to ${status.name}`}
                    className="ml-auto grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Plus className="size-4" />
                  </button>
                </h3>
                {inStatus.map((task) => (
                  /* No `status` on the row: the group heading above it is where
                     the status is said now. */
                  <TaskRow
                    key={task.id}
                    task={task}
                    selected={false}
                    onClick={() => onTaskClick(task)}
                  />
                ))}
              </section>
            )
          })}
          {tasks.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No tasks match the current filters.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ViewToggle({
  view,
  onChange,
}: {
  view: "board" | "list"
  onChange: (v: "board" | "list") => void
}) {
  return (
    <div
      className="inline-flex shrink-0 items-center gap-0.5 rounded-4xl border bg-muted/30 p-0.5 text-xs font-medium"
      aria-label="Board view"
    >
      {(["board", "list"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          aria-label={`${v} view`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-4xl px-2.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            view === v
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v === "board" ? (
            <SquareKanban className="size-3.5 shrink-0" />
          ) : (
            <List className="size-3.5 shrink-0" />
          )}
          <span className="capitalize">{v}</span>
        </button>
      ))}
    </div>
  )
}
