import * as React from "react"
import { createPortal } from "react-dom"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { MoreHorizontalIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  CompleteSprintDialog,
  SprintDialog,
  refreshAfterSprintChange,
  sprintApi,
  sprintDateRange,
  sprintDaysLeft,
} from "@/components/pm/settings/sprint-editor"
import { Assignees, PriorityFlag } from "@/components/pm/views/list-view"
import { useActions, type Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { byBacklogRank } from "@/lib/pm/filtering"
import { moveInList } from "@/lib/pm/rank"
import type { IssueType, PmViewProps, Sprint, Task } from "@/lib/pm/types"
import { loadSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

/* ── Backlog ──
   The planning view: one lane per sprint plus the backlog itself, ordered the
   way planning reads — the active sprint (what is being worked), then each
   planned sprint (what is committed next), then the backlog (everything else).
   A completed sprint only appears while it still holds tasks, at the bottom,
   so nothing can become unreachable.

   Order here is `backlogRank`, not the column `order` the kanban sorts by — a
   task's place in a lane is a planning decision independent of its status. A
   drop therefore goes through `actions.reorder` (scope `backlog`/`sprint`,
   which is the backlogRank list) rather than `moveTask`, and a cross-lane drop
   is a sprint change plus that reorder: `patchTask({ sprintId })` first, so the
   task belongs to the lane it is being ranked in.

   Same dnd-kit house rules as the kanban: PointerSensor distance-6 so a click
   still opens the task, KeyboardSensor for drag-by-keyboard, DragOverlay
   portaled to document.body, and no transition-transform class anywhere near a
   sortable node. */

/** Past this many rendered rows the view stops and offers "Show more" — the
    same plain-slice window list-view uses, no virtualization in v1. */
const WINDOW = 500

const BACKLOG_LANE = "backlog"
const laneDropId = (laneId: string) => `lane:${laneId}`

interface Lane {
  id: string
  sprint: Sprint | null
  tasks: Task[]
  points: number
  /** Tasks with no completedAt — what "Complete sprint" has to relocate. */
  incomplete: number
  incompletePoints: number
}

export type BacklogViewProps = PmViewProps & {
  /** pm-page passes its Actions through; absent, the view makes its own (the
      hook is a memo over `api()` + dispatch, so a second one is free). */
  actions?: Actions
  onNewTask?(sprintId: string | null): void
}

export function BacklogView({
  board,
  tasks,
  onOpenTask,
  actions: actionsProp,
  onNewTask,
}: BacklogViewProps) {
  const [fallbackSettings] = React.useState(
    () => loadSettings() ?? { id: "", name: "", url: "", token: "" }
  )
  const fallbackActions = useActions(fallbackSettings)
  const actions = actionsProp ?? fallbackActions
  const confirm = useConfirm()

  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [limit, setLimit] = React.useState(WINDOW)
  /** `null` = closed; `{ sprint: null }` = create. */
  const [editing, setEditing] = React.useState<{ sprint: Sprint | null } | null>(null)
  const [completing, setCompleting] = React.useState<Sprint | null>(null)

  // A different board is a different backlog; a narrowed filter is not.
  React.useEffect(() => setLimit(WINDOW), [board.id])

  const sensors = useSensors(
    // Distance 6: below that a press is a click and opens the task editor.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const types = React.useMemo(() => {
    const byId: Record<string, IssueType> = {}
    for (const type of board.issueTypes) byId[type.id] = type
    return byId
  }, [board.issueTypes])

  const doneColumns = React.useMemo(
    () => new Set(board.columns.filter((c) => c.category === "done").map((c) => c.id)),
    [board.columns]
  )

  const activeSprint = React.useMemo(
    () => board.sprints.find((sprint) => sprint.state === "active") ?? null,
    [board.sprints]
  )

  const lanes = React.useMemo<Lane[]>(() => {
    const buckets = new Map<string, Task[]>([[BACKLOG_LANE, []]])
    for (const sprint of board.sprints) buckets.set(sprint.id, [])
    for (const task of tasks) {
      const key = task.sprintId !== null && buckets.has(task.sprintId) ? task.sprintId : BACKLOG_LANE
      buckets.get(key)!.push(task)
    }

    const planned = board.sprints
      .filter((sprint) => sprint.state === "planned")
      .sort(
        (a, b) =>
          (a.startDate ?? Number.MAX_SAFE_INTEGER) - (b.startDate ?? Number.MAX_SAFE_INTEGER) ||
          a.name.localeCompare(b.name)
      )
    /* History stays out of the way, and only while it still holds something —
       a completed sprint with tasks left in it must not swallow them. */
    const finished = board.sprints.filter(
      (sprint) => sprint.state === "completed" && (buckets.get(sprint.id)?.length ?? 0) > 0
    )

    const ordered: Array<Sprint | null> = [
      ...(activeSprint ? [activeSprint] : []),
      ...planned,
      null,
      ...finished,
    ]

    return ordered.map((sprint) => {
      const laneTasks = byBacklogRank(buckets.get(sprint?.id ?? BACKLOG_LANE) ?? [])
      let points = 0
      let incomplete = 0
      let incompletePoints = 0
      for (const task of laneTasks) {
        const value = task.storyPoints ?? 0
        points += value
        const done = task.completedAt !== null || doneColumns.has(task.columnId)
        if (!done) {
          incomplete += 1
          incompletePoints += value
        }
      }
      return {
        id: sprint?.id ?? BACKLOG_LANE,
        sprint,
        tasks: laneTasks,
        points,
        incomplete,
        incompletePoints,
      }
    })
  }, [activeSprint, board.sprints, doneColumns, tasks])

  const activeTask = activeId ? tasks.find((task) => task.id === activeId) ?? null : null

  const handleOpen = React.useCallback((id: string) => onOpenTask(id), [onOpenTask])

  const onDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }, [])

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActiveId(null)
      const { active, over } = event
      if (!over) return

      const taskId = String(active.id)
      const task = tasks.find((candidate) => candidate.id === taskId)
      if (!task) return

      // `over` is either a lane (dropped on empty space) or another row.
      const overData = over.data.current as { type?: string; laneId?: string } | undefined
      const sourceLaneId =
        task.sprintId !== null && lanes.some((lane) => lane.id === task.sprintId)
          ? task.sprintId
          : BACKLOG_LANE
      const targetLaneId =
        overData?.type === "lane" ? String(overData.laneId) : overData?.laneId ?? sourceLaneId
      const lane = lanes.find((candidate) => candidate.id === targetLaneId)
      if (!lane) return

      const ids = lane.tasks.map((candidate) => candidate.id)
      const overIndex = ids.indexOf(String(over.id))
      const index = overIndex === -1 ? ids.length : overIndex

      if (targetLaneId === sourceLaneId) {
        // Measured against the lane minus the dragged row, exactly as the rank
        // math is: a drop back onto its own place is a no-op, not a rewrite.
        const currentIndex = ids.indexOf(taskId)
        if (Math.min(index, ids.length - 1) === currentIndex) return
      }

      const orderedIds = moveInList([...ids, taskId], taskId, index)
      const scope =
        targetLaneId === BACKLOG_LANE
          ? ({ kind: "backlog" } as const)
          : ({ kind: "sprint", sprintId: targetLaneId } as const)

      void (async () => {
        try {
          if (targetLaneId !== sourceLaneId) {
            await actions.patchTask(board.id, taskId, {
              sprintId: targetLaneId === BACKLOG_LANE ? null : targetLaneId,
            })
          }
          await actions.reorder(board.id, { scope, orderedIds })
        } catch {
          // Both actions paint optimistically, roll back and report on their
          // own — nothing left to say here.
        }
      })()
    },
    [actions, board.id, lanes, tasks]
  )

  const startSprint = React.useCallback(
    async (sprint: Sprint) => {
      try {
        await sprintApi(actions).startSprint(board.id, sprint.id)
        refreshAfterSprintChange(actions, board.id)
        toast.success(`${sprint.name} started`)
      } catch (err) {
        reportError(err, "Couldn't start the sprint")
      }
    },
    [actions, board.id]
  )

  const deleteSprint = React.useCallback(
    async (sprint: Sprint) => {
      const ok = await confirm({
        title: `Delete ${sprint.name}?`,
        description:
          "The sprint is removed; its tasks stay on the board and fall back to the backlog.",
        confirmLabel: "Delete sprint",
        destructive: true,
      })
      if (!ok) return
      try {
        await sprintApi(actions).deleteSprint(board.id, sprint.id)
        refreshAfterSprintChange(actions, board.id)
        toast.success(`${sprint.name} deleted`)
      } catch (err) {
        reportError(err, "Couldn't delete the sprint")
      }
    },
    [actions, board.id, confirm]
  )

  // Spend the window top-down, the way list-view does: the lanes nearest the
  // top of the plan are the ones worth mounting first.
  let budget = limit
  const rendered = lanes.map((lane) => {
    const slice = lane.tasks.slice(0, Math.max(0, budget))
    budget -= slice.length
    return { lane, slice }
  })
  const total = lanes.reduce((sum, lane) => sum + lane.tasks.length, 0)
  const used = limit - budget
  const truncated = Math.max(0, total - used)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      // An empty lane has no items to measure; measure droppables always so a
      // first drop into one still registers.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
          {rendered.map(({ lane, slice }) => (
            <BacklogLane
              key={lane.id}
              lane={lane}
              slice={slice}
              types={types}
              hasActiveSprint={activeSprint !== null}
              onOpenTask={handleOpen}
              onNewTask={onNewTask}
              onEdit={(sprint) => setEditing({ sprint })}
              onStart={startSprint}
              onComplete={(sprint) => setCompleting(sprint)}
              onDelete={deleteSprint}
              onNewSprint={() => setEditing({ sprint: null })}
            />
          ))}

          {truncated > 0 && (
            <div className="flex items-center justify-center gap-3 py-2">
              <span className="text-xs text-muted-foreground">
                Showing {used} of {total}
              </span>
              <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + WINDOW)}>
                Show more
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Outside every scroll container, or a lifted row gets clipped. */}
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <BacklogRow
              task={activeTask}
              type={activeTask.typeId ? types[activeTask.typeId] : undefined}
              onOpen={handleOpen}
              overlay
              className="w-[32rem] max-w-[90vw]"
            />
          )}
        </DragOverlay>,
        document.body
      )}

      {editing && (
        <SprintDialog
          board={board}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          sprint={editing.sprint}
          actions={actions}
        />
      )}
      {completing && (
        <CompleteSprintDialog
          board={board}
          open
          onOpenChange={(open) => !open && setCompleting(null)}
          sprint={completing}
          incomplete={lanes.find((lane) => lane.id === completing.id)?.incomplete ?? 0}
          incompletePoints={lanes.find((lane) => lane.id === completing.id)?.incompletePoints}
          actions={actions}
        />
      )}
    </DndContext>
  )
}

// ---------------------------------------------------------------------------
// Lanes

interface BacklogLaneProps {
  lane: Lane
  /** The windowed rows — the lane's own count still reads `lane.tasks`. */
  slice: Task[]
  types: Record<string, IssueType>
  hasActiveSprint: boolean
  onOpenTask(id: string): void
  onNewTask?(sprintId: string | null): void
  onEdit(sprint: Sprint): void
  onStart(sprint: Sprint): void
  onComplete(sprint: Sprint): void
  onDelete(sprint: Sprint): void
  onNewSprint(): void
}

function BacklogLaneImpl({
  lane,
  slice,
  types,
  hasActiveSprint,
  onOpenTask,
  onNewTask,
  onEdit,
  onStart,
  onComplete,
  onDelete,
  onNewSprint,
}: BacklogLaneProps) {
  // The lane itself is a drop target, which is what makes an empty lane (no
  // sortable rows to hit) accept a task at all.
  const { setNodeRef, isOver } = useDroppable({
    id: laneDropId(lane.id),
    data: { type: "lane", laneId: lane.id },
  })
  const ids = React.useMemo(() => lane.tasks.map((task) => task.id), [lane.tasks])
  const sprint = lane.sprint
  const range = sprint ? sprintDateRange(sprint) : null
  const daysLeft = sprint?.state === "active" ? sprintDaysLeft(sprint) : null

  return (
    <section
      className={cn(
        "rounded-xl border bg-card/40",
        sprint?.state === "active" && "border-ring/40"
      )}
    >
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {sprint?.name ?? "Backlog"}
        </span>
        {sprint?.state === "active" && (
          <span className="rounded-4xl border border-ring/40 bg-primary/10 px-1.5 py-px text-[10px] leading-4 text-foreground">
            Active
          </span>
        )}
        {sprint?.state === "completed" && (
          <span className="rounded-4xl border px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
            Completed
          </span>
        )}
        {range && <span className="text-[11px] text-muted-foreground">{range}</span>}
        {daysLeft !== null && (
          <span className="text-[11px] text-muted-foreground">
            {daysLeft >= 0
              ? `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`
              : `${-daysLeft} ${daysLeft === -1 ? "day" : "days"} over`}
          </span>
        )}

        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          <span>
            {lane.tasks.length} {lane.tasks.length === 1 ? "task" : "tasks"}
          </span>
          {lane.points > 0 && (
            <span title="Story points in this lane" className="rounded-4xl bg-muted px-1.5 py-px">
              {lane.points} pts
            </span>
          )}
        </span>

        {sprint === null ? (
          <Button variant="outline" size="sm" onClick={onNewSprint}>
            <PlusIcon />
            New sprint
          </Button>
        ) : sprint.state === "planned" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={hasActiveSprint}
            title={
              hasActiveSprint
                ? "Complete the active sprint first — a board runs one at a time."
                : `Start ${sprint.name}`
            }
            onClick={() => onStart(sprint)}
          >
            Start sprint
          </Button>
        ) : sprint.state === "active" ? (
          <Button variant="outline" size="sm" onClick={() => onComplete(sprint)}>
            Complete sprint
          </Button>
        ) : null}

        {onNewTask && sprint?.state !== "completed" && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`New task in ${sprint?.name ?? "the backlog"}`}
            onClick={() => onNewTask(sprint?.id ?? null)}
          >
            <PlusIcon />
          </Button>
        )}

        {sprint && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label={`${sprint.name} options`}>
                  <MoreHorizontalIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(sprint)}>Edit sprint</DropdownMenuItem>
              {sprint.state === "planned" && !hasActiveSprint && (
                <DropdownMenuItem onClick={() => onStart(sprint)}>Start sprint</DropdownMenuItem>
              )}
              {sprint.state === "active" && (
                <DropdownMenuItem onClick={() => onComplete(sprint)}>
                  Complete sprint
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(sprint)}>
                Delete sprint
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      {sprint?.goal && (
        <p className="px-3 pb-2 text-xs text-muted-foreground">{sprint.goal}</p>
      )}

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-14 flex-col gap-1 rounded-b-xl border-t px-2 py-2",
          isOver && "bg-muted/50"
        )}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {slice.map((task) => (
            <SortableBacklogRow
              key={task.id}
              task={task}
              laneId={lane.id}
              type={task.typeId ? types[task.typeId] : undefined}
              onOpen={onOpenTask}
            />
          ))}
        </SortableContext>
        {lane.tasks.length === 0 && (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            {sprint === null ? "Nothing in the backlog" : "Drag tasks here to plan them"}
          </p>
        )}
        {slice.length === 0 && lane.tasks.length > 0 && (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            {lane.tasks.length} {lane.tasks.length === 1 ? "task" : "tasks"} — show more below
          </p>
        )}
      </div>
    </section>
  )
}

const BacklogLane = React.memo(BacklogLaneImpl)

// ---------------------------------------------------------------------------
// Rows

export interface BacklogRowProps {
  task: Task
  type?: IssueType
  onOpen(id: string): void
  /** Painted while the real row is lifted, and by the DragOverlay clone. */
  dragging?: boolean
  overlay?: boolean
  className?: string
}

/** React 19 takes `ref` as a plain prop — no forwardRef for the sortable node. */
type BacklogRowDivProps = BacklogRowProps &
  Omit<React.HTMLAttributes<HTMLDivElement>, "onClick" | "children"> & {
    ref?: React.Ref<HTMLDivElement>
  }

function BacklogRowImpl({
  task,
  type,
  onOpen,
  dragging,
  overlay,
  className,
  ...rest
}: BacklogRowDivProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      /* dnd-kit's own keyboard listener (drag) arrives in `rest` and wins —
         Enter lifts the row there; a row with no listeners opens instead. */
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen(task.id)
        }
      }}
      {...rest}
      /* After the spread on purpose: the PointerSensor's distance-6 constraint
         means a click is never a drag, so click always opens the task. */
      onClick={() => onOpen(task.id)}
      className={cn(
        // touch-action lives on the drag surface only — the row IS the handle.
        "flex touch-none items-center gap-2 rounded-lg border border-transparent bg-card/60 px-2 py-1.5 text-left outline-none",
        "hover:border-ring/40 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        dragging && "opacity-40",
        overlay && "border-border bg-card shadow-lg",
        className
      )}
    >
      <span className="w-20 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
        {task.key}
      </span>
      {type && (
        <span
          title={type.name}
          className="shrink-0 rounded-4xl border px-1.5 py-px text-[10px] leading-4 text-muted-foreground"
        >
          {type.icon ? `${type.icon} ` : ""}
          {type.name}
        </span>
      )}
      <PriorityFlag priority={task.priority} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          task.completedAt !== null ? "text-muted-foreground line-through" : "text-foreground"
        )}
      >
        {task.title}
      </span>
      {task.storyPoints !== null && (
        <span
          title="Story points"
          className="shrink-0 rounded-4xl bg-muted px-1.5 py-px text-[11px] text-muted-foreground tabular-nums"
        >
          {task.storyPoints}
        </span>
      )}
      <Assignees assignees={task.assignees} />
    </div>
  )
}

/** Memoized: a filter keystroke or a lane refresh re-renders the view, and only
    the rows whose task object actually changed should re-render with it. */
export const BacklogRow = React.memo(BacklogRowImpl)

interface SortableBacklogRowProps extends BacklogRowProps {
  /** The lane this row currently sits in — read by the view's drop handler. */
  laneId: string
}

/** The draggable wrapper. No `transition-transform` class anywhere near it:
    dnd-kit sets `transform` imperatively and a CSS transition fights it. */
function SortableBacklogRowImpl({ laneId, ...row }: SortableBacklogRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.task.id,
    data: { type: "task", laneId },
  })

  return (
    <BacklogRow
      {...row}
      dragging={isDragging}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // The sortable node's own transform/transition — never a utility class.
      style={{ transform: CSS.Translate.toString(transform), transition }}
    />
  )
}

const SortableBacklogRow = React.memo(SortableBacklogRowImpl)

export default BacklogView
