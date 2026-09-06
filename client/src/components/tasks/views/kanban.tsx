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
  CircleCheck,
  CircleDashed,
  CircleDot,
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
import { COLOR_DOT, type BoardStatus, type StatusCategory } from "@/lib/boards"
import type { Task } from "@/lib/tasks-board"
import { TaskCard } from "../task-card"
import { QuickAdd } from "../quick-add"
import type { ColumnOps, ViewProps } from "../types"

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
 * draft is the only thing that knows where a card is mid-drag, so it is what
 * gets asked.
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
  return overId.startsWith(COLUMN_PREFIX) ? overId.slice(COLUMN_PREFIX.length) : columnOf(columns, overId)
}

const CATEGORY_ICON: Record<StatusCategory, React.ComponentType<{ className?: string }>> = {
  todo: CircleDashed,
  in_progress: CircleDot,
  done: CircleCheck,
}

/** One kanban column (a status): the drop target for its tasks. */
function Column({
  status,
  tasks,
  total,
  index,
  count,
  points,
  ops,
  ctx,
  onOpen,
  onCreate,
}: {
  status: BoardStatus
  tasks: Task[]
  /** Unfiltered count and points — what the WIP limit is measured against. */
  count: number
  points: number
  index: number
  total: number
  ops: ColumnOps
  ctx: ViewProps["ctx"]
  onOpen: (task: Task) => void
  onCreate: (statusId: string, title: string) => Promise<void>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${status.id}` })
  const over = status.wipLimit != null && count > status.wipLimit
  const Icon = CATEGORY_ICON[status.category]
  return (
    <div
      ref={setNodeRef}
      className={cn(
        /* On a phone a column is nearly the viewport and snaps into place, so
           the horizontal scroller reads as a pager rather than as a strip of
           half-visible columns; from `sm` up it is the fixed width it was. */
        "flex max-h-full w-[85vw] max-w-[19rem] shrink-0 snap-start flex-col rounded-2xl border bg-muted/30 sm:w-72 sm:max-w-none",
        isOver && "border-primary/40 bg-muted/60",
        over && "border-destructive/40",
      )}
    >
      <div className="flex items-center justify-between gap-1 px-3 py-2.5">
        <span className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span className={cn("size-2 shrink-0 rounded-full", status.color ? COLOR_DOT[status.color] : "bg-muted-foreground/40")} />
          <span className="truncate">{status.name}</span>
          <span
            className={cn(
              "rounded-pill bg-muted px-1.5 text-[10px] tabular-nums",
              over && "bg-destructive/15 text-destructive",
            )}
            title={status.wipLimit != null ? `Work-in-progress limit ${status.wipLimit}` : undefined}
          >
            {count}
            {status.wipLimit != null && `/${status.wipLimit}`}
          </span>
          {points > 0 && <span className="text-[10px] tabular-nums normal-case">{points} pts</span>}
        </span>
        <span className="flex shrink-0 items-center">
          <Icon className="mr-1 size-3.5 text-muted-foreground/70" aria-hidden />
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
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => ops.onEdit(status)}>
                <Pencil className="size-4" /> Edit column…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index === 0} onClick={() => ops.onMove(status, -1)}>
                <ChevronLeft className="size-4" /> Move left
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index === total - 1} onClick={() => ops.onMove(status, 1)}>
                <ChevronRight className="size-4" /> Move right
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                // The board's last column has nowhere to send its tasks, and a
                // board with no columns has nothing to draw.
                disabled={total <= 1}
                onClick={() => ops.onDelete(status)}
                className="text-destructive"
              >
                <Trash2 className="size-4" /> Delete column…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      <div className="flex min-h-[2rem] flex-1 flex-col gap-2 overflow-y-auto p-2">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} ctx={ctx} onClick={() => onOpen(task)} />
          ))}
        </SortableContext>
        {tasks.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-6 text-center text-xs text-muted-foreground">
            <SquareKanban className="size-5 opacity-50" />
            <p>Drop tasks here</p>
          </div>
        )}
      </div>
      <div className="p-2 pt-0">
        <QuickAdd onCreate={(title) => onCreate(status.id, title)} compact />
      </div>
    </div>
  )
}

export function KanbanView({
  statuses,
  tasks,
  allTasks,
  ctx,
  onOpen,
  onCreate,
  onMove,
  columns,
}: ViewProps & {
  /** `{statusId: orderedTaskIds}` for the columns the drag touched. */
  onMove: (byStatus: Record<string, string[]>) => void
  columns: ColumnOps
}) {
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
     the scroller; the mouse keeps the 4px distance it always had. */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  )

  const reset = () => setDraft(groupByStatus(tasks, statuses))

  /* Unfiltered per-column counts: a WIP limit is about the column, not about
     what the current filter happens to show of it. */
  const totals = React.useMemo(() => {
    const out: Record<string, { count: number; points: number }> = {}
    for (const s of statuses) out[s.id] = { count: 0, points: 0 }
    for (const t of allTasks) {
      if (t.archived) continue
      const bucket = out[t.statusId]
      if (!bucket) continue
      bucket.count++
      bucket.points += t.estimate ?? 0
    }
    return out
  }, [allTasks, statuses])

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
      byStatus[originStatus] = draft[originStatus].filter((task) => task.id !== movedId).map((task) => task.id)
    }
    onMove(byStatus)
  }

  return (
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
            count={totals[status.id]?.count ?? 0}
            points={totals[status.id]?.points ?? 0}
            ops={columns}
            ctx={ctx}
            onOpen={onOpen}
            onCreate={async (statusId, title) => {
              await onCreate({ title, statusId })
            }}
          />
        ))}
      </DndContext>
      <button
        type="button"
        onClick={columns.onAdd}
        className="flex h-fit w-40 shrink-0 snap-start items-center gap-2 rounded-2xl border border-dashed px-3 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-56 sm:py-2.5"
      >
        <Plus className="size-4" /> Add column
      </button>
    </div>
  )
}
