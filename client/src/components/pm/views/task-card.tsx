import * as React from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { format } from "date-fns"
import {
  AlertTriangleIcon,
  CalendarIcon,
  CheckSquareIcon,
  ChevronsUpIcon,
  GitBranchIcon,
  LayersIcon,
  MinusIcon,
  ArrowDownIcon,
  ArrowUpIcon,
} from "lucide-react"

import type { Label as PmLabel, Task } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

/* ── Kanban task card ──
   Presentational and `memo`d: a board can hold thousands of these, so the card
   takes only values it renders and callbacks the lane keeps stable. Everything
   derived from the rest of the board (label rows, subtask counts) is computed
   once by the view and handed down, never looked up per card.

   The drag behaviour lives in `SortableTaskCard` below so the same markup can
   be reused verbatim inside the view's DragOverlay. */

// ---------------------------------------------------------------------------
// Small derivations

/** Priority 0–4. 0 renders nothing — "no priority" is not a badge. */
const PRIORITY_META: Array<{
  label: string
  icon: typeof MinusIcon
  className: string
  style?: React.CSSProperties
} | null> = [
  null,
  { label: "Low priority", icon: ArrowDownIcon, className: "text-muted-foreground" },
  { label: "Medium priority", icon: MinusIcon, className: "text-foreground/70" },
  {
    label: "High priority",
    icon: ArrowUpIcon,
    className: "",
    style: { color: "var(--chart-4)" },
  },
  { label: "Urgent", icon: ChevronsUpIcon, className: "text-destructive" },
]

/** Initials for a free-form assignee name — there are no accounts, only strings. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]
  return letters.toUpperCase()
}

function checklistProgress(task: Task): { done: number; total: number } | null {
  let done = 0
  let total = 0
  for (const list of task.checklists ?? []) {
    for (const item of list.items) {
      total += 1
      if (item.done) done += 1
    }
  }
  return total === 0 ? null : { done, total }
}

// ---------------------------------------------------------------------------

export interface TaskCardProps {
  task: Task
  /** The board's labels keyed by id — built once per render by the view. */
  labels: Record<string, PmLabel>
  /** Subtask roll-up (`parentId` children), counted once by the view. */
  subtasks?: { done: number; total: number }
  /** Epic roll-up (`epicId` children) — only ever set for a card whose issue
      type `isEpic`, and counted in the same single pass the view already makes
      for subtasks, so an epic costs no lookup of its own. */
  epic?: { done: number; total: number }
  onOpen(id: string): void
  /** Waiting on an unfinished dependency — read from the board's one
      `GET /dependencies` fetch (lib/pm/dependencies), never looked up here. */
  blocked?: boolean
  /** Painted while the real card is lifted, and by the DragOverlay clone. */
  dragging?: boolean
  overlay?: boolean
  className?: string
}

/** React 19 takes `ref` as a plain prop — no forwardRef needed for the
    sortable node below. */
type TaskCardDivProps = TaskCardProps &
  Omit<React.HTMLAttributes<HTMLDivElement>, "onClick" | "children"> & {
    ref?: React.Ref<HTMLDivElement>
  }

function TaskCardImpl({
  task,
  labels,
  subtasks,
  epic,
  onOpen,
  blocked,
  dragging,
  overlay,
  className,
  ...rest
}: TaskCardDivProps) {
  const priority = PRIORITY_META[task.priority] ?? null
  const PriorityIcon = priority?.icon
  const checklist = checklistProgress(task)
  const overdue =
    task.dueDate !== null && task.completedAt === null && task.dueDate < Date.now()
  const chips = task.labelIds.map((id) => labels[id]).filter((label): label is PmLabel => !!label)

  return (
    <div
      role="button"
      tabIndex={0}
      /* dnd-kit's own keyboard listener (drag) arrives in `rest` and wins —
         Enter lifts the card there; a card with no listeners opens instead. */
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
        // touch-action lives on the drag surface only — the card IS the handle.
        "touch-none rounded-lg border bg-card p-2.5 text-left text-sm shadow-xs outline-none",
        "hover:border-ring/40 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        dragging && "opacity-40",
        overlay && "rotate-1 cursor-grabbing shadow-lg",
        className
      )}
    >
      <div className="flex items-start gap-2">
        {blocked && (
          <AlertTriangleIcon
            aria-label="Blocked by an unfinished task"
            className="mt-0.5 size-3.5 shrink-0 text-destructive"
          />
        )}
        <span className="min-w-0 flex-1 line-clamp-3 font-medium text-foreground">
          {task.title}
        </span>
        {PriorityIcon && (
          <PriorityIcon
            aria-label={priority?.label}
            className={cn("mt-0.5 size-3.5 shrink-0", priority?.className)}
            style={priority?.style}
          />
        )}
      </div>

      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {chips.map((label) => (
            <span
              key={label.id}
              className={cn(
                "inline-flex items-center gap-1 rounded-4xl border px-1.5 py-px text-[10px] leading-4",
                label.color ? "" : "bg-muted text-muted-foreground"
              )}
              style={
                label.color
                  ? {
                      borderColor: label.color,
                      color: label.color,
                      backgroundColor: `color-mix(in oklab, ${label.color} 16%, transparent)`,
                    }
                  : undefined
              }
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: label.color ?? "currentColor" }}
              />
              {label.name}
            </span>
          ))}
        </div>
      )}

      {/* Epics ARE tasks, so an epic card is the roll-up of what points at it:
          the bar is the same "done vs everything" the editor's EpicProgress
          breaks down by column. */}
      {epic && epic.total > 0 && (
        <div
          className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={epic.total}
          aria-valuenow={epic.done}
          aria-label={`Epic progress: ${epic.done} of ${epic.total} tasks done`}
          title={`Epic: ${epic.done} of ${epic.total} tasks done`}
        >
          <span
            className="h-full"
            style={{
              width: `${(epic.done / epic.total) * 100}%`,
              backgroundColor: "var(--chart-1)",
            }}
          />
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{task.key}</span>

        {epic && epic.total > 0 && (
          <span className="inline-flex items-center gap-1" title="Tasks in this epic">
            <LayersIcon className="size-3" />
            {epic.done}/{epic.total}
          </span>
        )}

        {task.dueDate !== null && (
          <span className={cn("inline-flex items-center gap-1", overdue && "text-destructive")}>
            <CalendarIcon className="size-3" />
            {format(task.dueDate, "MMM d")}
          </span>
        )}

        {subtasks && subtasks.total > 0 && (
          <span className="inline-flex items-center gap-1" title="Subtasks">
            <GitBranchIcon className="size-3" />
            {subtasks.done}/{subtasks.total}
          </span>
        )}

        {checklist && (
          <span className="inline-flex items-center gap-1" title="Checklist">
            <CheckSquareIcon className="size-3" />
            {checklist.done}/{checklist.total}
          </span>
        )}

        {task.storyPoints !== null && (
          <span className="rounded-4xl bg-muted px-1.5 py-px" title="Story points">
            {task.storyPoints}
          </span>
        )}

        {task.assignees.length > 0 && (
          <span className="ml-auto flex items-center -space-x-1">
            {task.assignees.slice(0, 3).map((name) => (
              <span
                key={name}
                title={name}
                className="flex size-5 items-center justify-center rounded-full border bg-muted text-[9px] font-medium text-foreground"
              >
                {initialsOf(name)}
              </span>
            ))}
            {task.assignees.length > 3 && (
              <span className="pl-2">+{task.assignees.length - 3}</span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

/** Cards are re-rendered by the thousand on a board fetch — memo with the
    view's stable callbacks keeps a drag from repainting every lane. */
export const TaskCard = React.memo(TaskCardImpl)

// ---------------------------------------------------------------------------

export interface SortableTaskCardProps extends TaskCardProps {
  /** The lane this card currently sits in — read by the view's drop handler. */
  columnId: string
}

/** The draggable wrapper. No `transition-transform` class anywhere near it:
    dnd-kit sets `transform` imperatively and a CSS transition fights it. */
function SortableTaskCardImpl({ columnId, ...card }: SortableTaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.task.id,
    data: { type: "task", columnId },
  })

  return (
    <TaskCard
      {...card}
      dragging={isDragging}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // The sortable node's own transform/transition — never a utility class.
      style={{ transform: CSS.Translate.toString(transform), transition }}
    />
  )
}

export const SortableTaskCard = React.memo(SortableTaskCardImpl)
