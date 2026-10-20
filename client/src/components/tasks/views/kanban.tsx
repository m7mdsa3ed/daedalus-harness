import * as React from "react"
import { createPortal } from "react-dom"
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  getFirstCollision,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
  type UniqueIdentifier,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable"
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  SquareKanban,
  Trash2,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty } from "@/components/empty"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { COLOR_DOT, type BoardStatus } from "@/lib/boards"
import type { Task } from "@/lib/tasks-board"
import { TaskCard, TaskCardOverlay } from "../task-card"
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

/** The source card fades to a placeholder while the overlay animates into its slot. */
const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }),
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
  const [adding, setAdding] = React.useState(false)
  const over = status.wipLimit != null && count > status.wipLimit
  return (
    <div
      ref={setNodeRef}
      className={cn(
        /* On a phone a column is nearly the viewport and snaps into place, so
           the horizontal scroller reads as a pager rather than as a strip of
           half-visible columns; from `sm` up it is the fixed width it was. */
        "flex max-h-full w-[85vw] max-w-[19rem] shrink-0 snap-start flex-col rounded-xl bg-muted/50 sm:w-72 sm:max-w-none",
        isOver && "ring-1 ring-primary/40",
        over && "ring-1 ring-destructive/40",
      )}
    >
      <div className="flex items-center justify-between gap-1 px-3 py-2.5">
        <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className={cn("size-2 shrink-0 rounded-full", status.color ? COLOR_DOT[status.color] : "bg-muted-foreground/40")} />
          <span className="truncate">{status.name}</span>
          <Badge
            variant={over ? "destructive" : "secondary"}
            className="tabular-nums"
            title={status.wipLimit != null ? `Work-in-progress limit ${status.wipLimit}` : undefined}
          >
            {count}
            {status.wipLimit != null && `/${status.wipLimit}`}
          </Badge>
          {points > 0 && <span className="text-xs font-normal tabular-nums text-muted-foreground">{points} pts</span>}
        </span>
        <span className="flex shrink-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setAdding(true)}
            aria-label={`Add task to ${status.name}`}
            className="text-muted-foreground"
          >
            <Plus />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`${status.name} column options`} className="text-muted-foreground">
                  <MoreHorizontal />
                </Button>
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
                variant="destructive"
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
          <Empty icon={SquareKanban}>
            Drop tasks here
          </Empty>
        )}
      </div>
      <div className="p-2 pt-0">
        <QuickAdd onCreate={(title) => onCreate(status.id, title)} compact open={adding} onOpenChange={setAdding} />
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
  const [activeId, setActiveId] = React.useState<string | null>(null)
  /* Re-seed only when the data changes, and never mid-drag: an update landing
     during a drag would yank the card out of the pointer's column. Ending a
     drag deliberately does NOT re-seed — the draft already shows the drop, and
     resetting it to not-yet-updated props would snap the card back until the
     write lands. The committed list re-seeds it when it arrives. */
  const dragging = React.useRef(false)
  React.useEffect(() => {
    if (!dragging.current) setDraft(groupByStatus(tasks, statuses))
  }, [tasks, statuses])

  /* ── Collision detection (dnd-kit's MultipleContainers preset) ──
     Pointer first, then rect overlap; a column hit resolves to its closest
     card. When a cross-column move shifts the layout for a frame and nothing
     is under the pointer, the last match is reused instead of flickering. */
  const lastOverId = React.useRef<UniqueIdentifier | null>(null)
  const recentlyMovedToNewColumn = React.useRef(false)
  React.useEffect(() => {
    requestAnimationFrame(() => {
      recentlyMovedToNewColumn.current = false
    })
  }, [draft])
  const collisionDetection: CollisionDetection = React.useCallback(
    (args) => {
      const pointer = pointerWithin(args)
      const intersections = pointer.length > 0 ? pointer : rectIntersection(args)
      let overId = getFirstCollision(intersections, "id")
      if (overId != null) {
        const id = String(overId)
        if (id.startsWith(COLUMN_PREFIX)) {
          const cards = new Set((draft[id.slice(COLUMN_PREFIX.length)] ?? []).map((t) => t.id))
          if (cards.size > 0) {
            overId =
              closestCenter({
                ...args,
                droppableContainers: args.droppableContainers.filter((c) => cards.has(String(c.id))),
              })[0]?.id ?? overId
          }
        }
        lastOverId.current = overId
        return [{ id: overId }]
      }
      if (recentlyMovedToNewColumn.current) lastOverId.current = activeId
      return lastOverId.current != null ? [{ id: lastOverId.current }] : []
    },
    [activeId, draft],
  )

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

  const reset = () => {
    dragging.current = false
    setActiveId(null)
    setDraft(groupByStatus(tasks, statuses))
  }

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

  const handleDragStart = ({ active }: DragStartEvent) => {
    dragging.current = true
    setActiveId(String(active.id))
  }

  /* Cross-column hover: move the card into the column under the pointer, at
     the slot it is over — above that card, or below it once the dragged rect's
     top passes the card's bottom (dnd-kit's MultipleContainers preset). Over
     the column background, it goes last. Same-column order is left to the
     sortable strategy and committed in `onDragEnd`. */
  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return
    const movingId = String(active.id)
    const overId = String(over.id)
    setDraft((prev) => {
      const fromStatus = columnOf(prev, movingId)
      const targetStatus = statusFromOverId(prev, overId)
      if (!fromStatus || !targetStatus || fromStatus === targetStatus) return prev
      if (!prev[targetStatus]) return prev
      const moving = prev[fromStatus].find((task) => task.id === movingId)
      if (!moving) return prev
      const target = prev[targetStatus]
      const overIndex = target.findIndex((task) => task.id === overId)
      const translated = active.rect.current.translated
      const below = translated != null && translated.top > over.rect.top + over.rect.height
      const at = overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length
      recentlyMovedToNewColumn.current = true
      return {
        ...prev,
        [fromStatus]: prev[fromStatus].filter((task) => task.id !== movingId),
        [targetStatus]: [...target.slice(0, at), moving, ...target.slice(at)],
      }
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    dragging.current = false
    setActiveId(null)
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
    /* Commit the drop to the draft synchronously (as dnd-kit's own example
       does in onDragEnd), so the card stays where it was dropped no matter
       when the write reaches the store or the server. */
    setDraft((prev) => {
      const byId = new Map(Object.values(prev).flat().map((task) => [task.id, task]))
      const next = { ...prev }
      for (const [statusId, ids] of Object.entries(byStatus))
        next[statusId] = ids.flatMap((id) => byId.get(id) ?? [])
      return next
    })
    onMove(byStatus)
  }

  const activeTask = activeId != null ? allTasks.find((t) => t.id === activeId) : undefined

  return (
    <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3 pb-[max(0.75rem,var(--safe-bottom))] sm:snap-none">
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        // Columns change size while a card crosses them; re-measure every frame.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={handleDragStart}
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
        {/* Portalled to <body>: the card must escape the columns' overflow and
            stacking contexts, and any transformed ancestor (a dialog centred
            with translate) that would re-anchor its position: fixed. */}
        {createPortal(
          <DragOverlay dropAnimation={dropAnimation}>
            {activeTask ? <TaskCardOverlay task={activeTask} ctx={ctx} /> : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      <Button type="button" variant="outline" onClick={columns.onAdd} className="w-40 shrink-0 snap-start justify-start border-dashed text-muted-foreground sm:w-56">
        <Plus /> Add column
      </Button>
    </div>
  )
}
