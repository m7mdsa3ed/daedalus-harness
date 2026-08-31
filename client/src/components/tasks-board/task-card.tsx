import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { CalendarIcon, Circle } from "lucide-react"

import { cn } from "@/lib/utils"
import { COLOR_DOT, type BoardStatus } from "@/lib/boards"
import {
  PRIORITY_LABEL,
  type Task,
  type TaskPriority,
} from "@/lib/tasks-board"

const PRIORITY_DOT: Record<TaskPriority, string> = {
  low: "bg-sky-500",
  medium: "bg-slate-400",
  high: "bg-amber-500",
  urgent: "bg-red-500",
}

const MAX_LABELS = 3

/** Turn a markdown body into a one-line plain-text preview for a clipped card:
    links to their text, emphasis to plain, code fences to nothing. Good enough
    for a two-line excerpt without paying for a full markdown render per card. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function dueLabel(dueAt: number | null): string | null {
  if (dueAt == null) return null
  const now = Date.now()
  const day = 24 * 60 * 60_000
  const d = new Date(dueAt)
  const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  if (dueAt < now) return `Overdue · ${label}`
  if (dueAt < now + day) return `Today · ${label}`
  return label
}

export function TaskCard({
  task,
  onClick,
}: {
  task: Task
  onClick: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })

  const overdue = task.dueAt != null && task.dueAt < Date.now()

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onClick}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cn(
        "group w-full rounded-lg border bg-card text-left text-sm text-card-foreground shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "z-10 opacity-60",
      )}
    >
      <div className="space-y-2 p-3">
        <p className="line-clamp-2 font-medium leading-snug">{task.title}</p>
        {task.description && (
          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
            {stripMarkdown(task.description)}
          </p>
        )}
        {task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.labels.slice(0, MAX_LABELS).map((label) => (
              <span
                key={label}
                className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {label}
              </span>
            ))}
            {task.labels.length > MAX_LABELS && (
              <span className="text-[10px] text-muted-foreground">
                +{task.labels.length - MAX_LABELS}
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className="inline-flex items-center gap-1"
            title={`Priority: ${PRIORITY_LABEL[task.priority]}`}
          >
            <Circle className={cn("size-2.5 fill-current", PRIORITY_DOT[task.priority])} />
            {PRIORITY_LABEL[task.priority]}
          </span>
          {task.assignee && <span className="truncate">{task.assignee}</span>}
          {task.dueAt != null && (
            <span
              className={cn(
                "ml-auto inline-flex items-center gap-1",
                overdue && "font-medium text-destructive",
              )}
              title={new Date(task.dueAt).toLocaleString()}
            >
              <CalendarIcon className="size-3" />
              {dueLabel(task.dueAt)}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

/** A tiny non-draggable row for the list view — selects the task to edit. */
export function TaskRow({
  task,
  status,
  selected,
  onClick,
}: {
  task: Task
  /** The column the task is in, drawn inline. Omitted where the list already
      groups by status and the heading says it. */
  status?: BoardStatus | null
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full min-h-11 items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left text-sm text-card-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary/40 bg-accent/40",
      )}
    >
      <Circle
        aria-hidden
        className={cn("size-2.5 shrink-0 fill-current", PRIORITY_DOT[task.priority])}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{task.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {status && (
            <span className="inline-flex items-center gap-1 align-middle">
              {status.color && (
                <span className={cn("size-1.5 rounded-full", COLOR_DOT[status.color])} />
              )}
              {status.name}
            </span>
          )}
          {status && (task.assignee || task.labels.length > 0) ? " · " : ""}
          {task.assignee ? `${task.assignee}${task.labels.length ? " · " : ""}` : ""}
          {task.labels.join(", ")}
        </span>
      </span>
      {task.dueAt != null && (
        <span
          className={cn(
            "shrink-0 text-xs",
            task.dueAt < Date.now() && "text-destructive",
          )}
        >
          {dueLabel(task.dueAt)}
        </span>
      )}
    </button>
  )
}
