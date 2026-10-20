import * as React from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ChevronDown, CornerDownRight, ListChecks, ListTree } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Count } from "@/components/settings/primitives"
import type { BoardStatus } from "@/lib/boards"
import { taskKey, type Task } from "@/lib/tasks-board"
import { checklistProgress, dueLabel } from "@/lib/tasks-view"
import {
  AssigneeAvatar,
  DueChip,
  EstimateBadge,
  ICON_BTN,
  KeyBadge,
  LabelChip,
  PriorityIcon,
  ProgressBar,
  StatusPill,
  TypeIcon,
} from "./fields"

const MAX_LABELS = 2

/** Turn a markdown body into a one-line plain-text preview for a clipped card:
    links to their text, emphasis to plain, code fences to nothing. Good enough
    for a two-line excerpt without paying for a full markdown render per card. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export interface CardContext {
  boardKey: string
  /** Parent title by id, for the breadcrumb on a child card. */
  parentOf: (task: Task) => Task | undefined
  /** How many children a task has. */
  childCount: (task: Task) => number
  selected: Set<string>
  onToggleSelect?: (id: string, additive: boolean) => void
}

/** Hidden until the card or row is pointed at, held visible while checked or
    focused, and always there on a touch screen — the checkbox is the touch path
    to selection, since a phone has no modifier-click. */
const SELECT_REVEAL =
  "opacity-0 transition-opacity focus-visible:opacity-100 data-checked:opacity-100 pointer-coarse:opacity-100"

/** Stops the gestures that would start a drag (dnd-kit's mouse and touch
    sensors listen on the card) or open the task, so a tick only ticks. */
const swallow = (e: React.SyntheticEvent) => e.stopPropagation()

function SelectBox({
  task,
  ctx,
  reveal,
}: {
  task: Task
  ctx: CardContext
  /** The hover reveal, spelled against the caller's named group. */
  reveal: string
}) {
  if (!ctx.onToggleSelect) return null
  return (
    <span
      className="grid size-6 shrink-0 place-items-center pointer-coarse:size-8"
      onPointerDown={swallow}
      onMouseDown={swallow}
      onTouchStart={swallow}
      onClick={swallow}
      onKeyDown={swallow}
    >
      <Checkbox
        checked={ctx.selected.has(task.id)}
        // Shift extends a range over the visible order, as a modifier-click does.
        onCheckedChange={(_, details) =>
          ctx.onToggleSelect?.(task.id, "shiftKey" in details.event && (details.event as MouseEvent).shiftKey)
        }
        aria-label={`Select ${task.title}`}
        className={cn(SELECT_REVEAL, reveal)}
      />
    </span>
  )
}

/** The card's face, with no dnd-kit inside: the sortable card and the drag
    overlay both draw it (dnd-kit: overlay children must not be draggables). */
function TaskCardBody({ task, ctx }: { task: Task; ctx: CardContext }) {
  const progress = checklistProgress(task)
  const parent = ctx.parentOf(task)
  const children = ctx.childCount(task)
  const done = task.completedAt != null
  const hasFooter =
    task.dueAt != null || progress.total > 0 || children > 0 || task.estimate != null || task.assignee != null
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <SelectBox task={task} ctx={ctx} reveal="group-hover/card:opacity-100" />
        <KeyBadge task={task} boardKey={ctx.boardKey} className="truncate" />
        <TypeIcon type={task.type} />
        <PriorityIcon priority={task.priority} className="ms-auto" />
      </div>
      {parent && (
        <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <CornerDownRight className="size-3 shrink-0" />
          <KeyBadge task={parent} boardKey={ctx.boardKey} className="shrink-0" />
          <span className="truncate">{parent.title}</span>
        </p>
      )}
      <p
        className={cn(
          "line-clamp-3 text-sm font-medium leading-snug",
          done && "text-muted-foreground line-through decoration-muted-foreground/50",
        )}
      >
        {task.title}
      </p>
      {task.labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {task.labels.slice(0, MAX_LABELS).map((label) => (
            <LabelChip key={label} label={label} />
          ))}
          {task.labels.length > MAX_LABELS && (
            <span className="text-xs text-muted-foreground">+{task.labels.length - MAX_LABELS}</span>
          )}
        </div>
      )}
      {hasFooter && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <DueChip task={task} />
          {progress.total > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums" title={`${progress.done}/${progress.total} checklist items done`}>
              <ListChecks className="size-3" />
              {progress.done}/{progress.total}
            </span>
          )}
          {children > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums" title={`${children} subtasks`}>
              <ListTree className="size-3" />
              {children}
            </span>
          )}
          {task.estimate != null && <span className="tabular-nums">{task.estimate} pts</span>}
          {task.assignee != null && <AssigneeAvatar name={task.assignee} size="sm" className="ms-auto" />}
        </div>
      )}
    </>
  )
}

const CARD =
  "group/card grid w-full cursor-pointer gap-2 rounded-lg bg-card p-3 text-left ring-1 ring-foreground/10 outline-none transition-shadow focus-visible:ring-[3px] focus-visible:ring-ring/50"

/** A touch-held card is a drag, never a text selection or the OS's callout. */
const COARSE = "pointer-coarse:select-none [-webkit-touch-callout:none] touch-manipulation"

/** The kanban card: sortable, and a button that opens the task. While it is
    dragged it stays in its column as a faded placeholder — the card under the
    pointer is the DragOverlay's copy (TaskCardOverlay). */
export function TaskCard({
  task,
  ctx,
  onClick,
}: {
  task: Task
  ctx: CardContext
  onClick: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const selected = ctx.selected.has(task.id)

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      data-selected={selected || undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          ctx.onToggleSelect?.(task.id, true)
          return
        }
        onClick()
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        CARD,
        COARSE,
        selected ? "ring-2 ring-primary" : "hover:ring-foreground/20",
        task.completedAt != null && "opacity-70",
        task.archived && "opacity-60",
        isDragging && "opacity-40",
      )}
    >
      <TaskCardBody task={task} ctx={ctx} />
    </div>
  )
}

/** What follows the pointer during a drag: the same face, lifted. */
export function TaskCardOverlay({ task, ctx }: { task: Task; ctx: CardContext }) {
  return (
    <div className={cn(CARD, COARSE, "cursor-grabbing shadow-lg rotate-1", ctx.selected.has(task.id) && "ring-2 ring-primary")}>
      <TaskCardBody task={task} ctx={ctx} />
    </div>
  )
}

/** The list-view row: the whole row opens the task; what it says grows with
    the panel's width, and a narrow panel reads the essentials on a second line. */
export function TaskRow({
  task,
  status,
  ctx,
  onClick,
  depth = 0,
  trailing,
}: {
  task: Task
  status?: BoardStatus | null
  ctx: CardContext
  onClick: () => void
  depth?: number
  /** A control at the row's end (a picker); its clicks never open the row. */
  trailing?: React.ReactNode
}) {
  const selected = ctx.selected.has(task.id)
  const progress = checklistProgress(task)
  const done = task.completedAt != null
  const narrowMeta = [taskKey(task, ctx.boardKey), status?.name, dueLabel(task.dueAt)].filter(Boolean).join(" · ")
  return (
    <div
      onClick={onClick}
      className={cn(
        "group/row grid min-h-11 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-3 text-sm transition-colors hover:bg-muted/50 pointer-coarse:min-h-12",
        selected && "bg-muted",
        task.archived && "opacity-60",
      )}
      style={depth > 0 ? { paddingInlineStart: `${0.75 + depth * 1.25}rem` } : undefined}
    >
      <div className="flex items-center gap-2">
        <SelectBox task={task} ctx={ctx} reveal="group-hover/row:opacity-100" />
        <TypeIcon type={task.type} />
        <KeyBadge task={task} boardKey={ctx.boardKey} className="hidden w-16 truncate @panel-sm:block" />
      </div>
      <div className="min-w-0 py-1.5">
        {/* No handler of its own: a keyboard Enter clicks it, and the click
            bubbles to the row, which is what opens the task. */}
        <button
          type="button"
          className={cn(
            "block max-w-full truncate text-left font-medium focus-visible:underline focus-visible:outline-none",
            done && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </button>
        <p className="truncate text-xs text-muted-foreground @panel-sm:hidden">{narrowMeta}</p>
      </div>
      <div className="flex items-center gap-3">
        {task.labels.length > 0 && (
          <span className="hidden items-center gap-1 @panel-lg:flex">
            {task.labels.slice(0, MAX_LABELS).map((label) => (
              <LabelChip key={label} label={label} />
            ))}
          </span>
        )}
        {progress.total > 0 && <ProgressBar done={progress.done} total={progress.total} className="hidden @panel-md:inline-flex" />}
        {status !== undefined && <StatusPill status={status ?? undefined} className="hidden @panel-md:inline-flex" />}
        <PriorityIcon priority={task.priority} />
        <span className="hidden w-20 justify-end @panel-sm:flex">
          <DueChip task={task} />
        </span>
        {task.estimate != null && (
          <span className="hidden @panel-lg:inline-flex">
            <EstimateBadge estimate={task.estimate} />
          </span>
        )}
        <AssigneeAvatar name={task.assignee} size="sm" />
        {trailing != null && (
          <span className="flex items-center" onClick={swallow} onKeyDown={swallow}>
            {trailing}
          </span>
        )}
      </div>
    </div>
  )
}

/** A heading over one card of rows, collapsible; the heading sticks while its
    rows scroll under it. */
export function GroupSection({
  title,
  count,
  color,
  points,
  meta,
  action,
  children,
  defaultOpen = true,
}: {
  title: React.ReactNode
  count: number
  color?: string | null
  points?: number
  /** Drawn after the title: a sprint's dates, a progress line. */
  meta?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <section className="grid gap-2">
      <header className="sticky top-0 z-10 flex min-h-9 flex-wrap items-center gap-2 bg-background/95 px-1 backdrop-blur">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Collapse group" : "Expand group"}
          className={cn(ICON_BTN, "text-muted-foreground")}
        >
          <ChevronDown className={cn("transition-transform", !open && "-rotate-90")} />
        </Button>
        {color && <span className={cn("size-2 shrink-0 rounded-full", color)} />}
        <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        <Count>{count}</Count>
        {points != null && points > 0 && (
          <span className="hidden text-xs tabular-nums text-muted-foreground @panel-sm:inline">{points} pts</span>
        )}
        {meta}
        {action && <span className="ms-auto flex items-center gap-1">{action}</span>}
      </header>
      {open && (
        <div className="divide-y overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">{children}</div>
      )}
    </section>
  )
}
