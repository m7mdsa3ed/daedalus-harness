import * as React from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { CornerDownRight, ListTree, MessageSquare } from "lucide-react"

import { cn } from "@/lib/utils"
import type { BoardStatus } from "@/lib/boards"
import type { Task } from "@/lib/tasks-board"
import { checklistProgress } from "@/lib/tasks-view"
import {
  AssigneeAvatar,
  DueChip,
  EstimateBadge,
  KeyBadge,
  LabelChip,
  PriorityIcon,
  ProgressBar,
  StatusPill,
  TypeIcon,
} from "./fields"

const MAX_LABELS = 3

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

/** The kanban card: draggable, and a button that opens the task. */
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
  const progress = checklistProgress(task)
  const parent = ctx.parentOf(task)
  const children = ctx.childCount(task)
  const selected = ctx.selected.has(task.id)

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
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
        "group w-full cursor-pointer rounded-xl border bg-card text-left text-sm text-card-foreground shadow-xs transition-colors hover:border-primary/30 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "z-10 opacity-60 shadow-lg",
        selected && "border-primary/50 bg-primary/5",
        task.archived && "opacity-60",
      )}
    >
      <div className="space-y-2 p-3">
        {parent && (
          <p className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
            <CornerDownRight className="size-3 shrink-0" />
            <TypeIcon type={parent.type} className="size-3" />
            <span className="truncate">{parent.title}</span>
          </p>
        )}
        <p className={cn("line-clamp-3 font-medium leading-snug", task.completedAt != null && "text-muted-foreground line-through decoration-muted-foreground/50")}>
          {task.title}
        </p>
        {task.description && (
          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{stripMarkdown(task.description)}</p>
        )}
        {task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.labels.slice(0, MAX_LABELS).map((label) => (
              <LabelChip key={label} label={label} />
            ))}
            {task.labels.length > MAX_LABELS && (
              <span className="text-[10px] text-muted-foreground">+{task.labels.length - MAX_LABELS}</span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <TypeIcon type={task.type} />
          <KeyBadge task={task} boardKey={ctx.boardKey} />
          <PriorityIcon priority={task.priority} />
          {children > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[10px]" title={`${children} subtasks`}>
              <ListTree className="size-3" />
              {children}
            </span>
          )}
          {progress.total > 0 && <ProgressBar done={progress.done} total={progress.total} />}
          <span className="ml-auto flex items-center gap-1.5">
            <DueChip task={task} />
            <EstimateBadge estimate={task.estimate} />
            <AssigneeAvatar name={task.assignee} size="xs" />
          </span>
        </div>
      </div>
    </div>
  )
}

/** The list-view row: dense, selectable, one line plus a meta line. */
export function TaskRow({
  task,
  status,
  ctx,
  onClick,
  depth = 0,
  commentCount,
}: {
  task: Task
  status?: BoardStatus | null
  ctx: CardContext
  onClick: () => void
  depth?: number
  commentCount?: number
}) {
  const selected = ctx.selected.has(task.id)
  const progress = checklistProgress(task)
  return (
    <div
      role="row"
      className={cn(
        "group flex min-h-10 w-full items-center gap-2 border-b px-2 text-left text-sm transition-colors hover:bg-accent/40 last:border-b-0",
        selected && "bg-primary/5",
        task.archived && "opacity-60",
      )}
      style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
    >
      {ctx.onToggleSelect && (
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => ctx.onToggleSelect?.(task.id, (e.nativeEvent as MouseEvent).shiftKey)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${task.title}`}
          className={cn("size-3.5 shrink-0 accent-primary opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100", selected && "opacity-100")}
        />
      )}
      <TypeIcon type={task.type} />
      <KeyBadge task={task} boardKey={ctx.boardKey} className="w-16 shrink-0 truncate" />
      <button
        type="button"
        onClick={onClick}
        className={cn("min-w-0 flex-1 truncate text-left font-medium hover:underline focus-visible:outline-none focus-visible:underline", task.completedAt != null && "text-muted-foreground line-through")}
      >
        {task.title}
      </button>
      {task.labels.slice(0, 2).map((label) => (
        <LabelChip key={label} label={label} />
      ))}
      {progress.total > 0 && <ProgressBar done={progress.done} total={progress.total} className="hidden sm:inline-flex" />}
      {commentCount ? (
        <span className="hidden items-center gap-0.5 text-[10px] text-muted-foreground sm:inline-flex">
          <MessageSquare className="size-3" />
          {commentCount}
        </span>
      ) : null}
      {status !== undefined && <StatusPill status={status ?? undefined} className="hidden sm:inline-flex" />}
      <PriorityIcon priority={task.priority} />
      <DueChip task={task} className="hidden w-24 justify-end sm:inline-flex" />
      <EstimateBadge estimate={task.estimate} />
      <AssigneeAvatar name={task.assignee} size="xs" />
    </div>
  )
}

/** Wraps a list of rows so the group heading can be collapsed. */
export function GroupSection({
  title,
  count,
  color,
  points,
  action,
  children,
  defaultOpen = true,
}: {
  title: React.ReactNode
  count: number
  color?: string | null
  points?: number
  action?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-2 border-b bg-muted/30 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          <CornerDownRight className={cn("size-3 shrink-0 transition-transform", open ? "rotate-0" : "-rotate-90")} />
          {color && <span className={cn("size-2 shrink-0 rounded-full", color)} />}
          <span className="truncate">{title}</span>
          <span className="rounded-pill bg-muted px-1.5 text-[10px] tabular-nums">{count}</span>
          {points != null && points > 0 && <span className="text-[10px] tabular-nums">{points} pts</span>}
        </button>
        {action}
      </header>
      {open && <div>{children}</div>}
    </section>
  )
}
