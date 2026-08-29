import * as React from "react"
import { SearchIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { reportError } from "@/lib/errors"
import type { ServerSettings } from "@/lib/settings"
import {
  STATUS_LABEL,
  STATUS_ORDER,
  TASK_PRIORITIES,
  TASK_STATUSES,
  createTask,
  deleteTask,
  loadTasks,
  reorderTasks,
  updateTask,
  useTasks,
  type Task,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks-board"
import { Board } from "./task-board"
import { TaskFormDialog } from "./task-form"

/** Dialog state: whether it is open, and the task being edited (null = new). */
interface DialogState {
  open: boolean
  task: Task | null
}

export function TasksBoard({ settings }: { settings: ServerSettings }) {
  const tasks = useTasks()
  const [dialog, setDialog] = React.useState<DialogState>({ open: false, task: null })
  const [creatingStatus, setCreatingStatus] = React.useState<TaskStatus>("todo")
  const [query, setQuery] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<TaskStatus | "all">("all")
  const [priorityFilter, setPriorityFilter] = React.useState<TaskPriority | "all">("all")

  React.useEffect(() => {
    loadTasks(settings).catch((err) => reportError(err, "Couldn't load the tasks board"))
  }, [settings])

  const filtered = tasks.filter((task) => {
    if (statusFilter !== "all" && task.status !== statusFilter) return false
    if (priorityFilter !== "all" && task.priority !== priorityFilter) return false
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (
      task.title.toLowerCase().includes(q) ||
      (task.description ?? "").toLowerCase().includes(q) ||
      task.labels.some((l) => l.toLowerCase().includes(q)) ||
      (task.assignee ?? "").toLowerCase().includes(q)
    )
  })

  const openNew = (status: TaskStatus) => {
    setCreatingStatus(status)
    setDialog({ open: true, task: null })
  }

  const handleSave = async (input: TaskInput): Promise<void> => {
    if (dialog.task) {
      await updateTask(settings, dialog.task.id, input)
    } else {
      await createTask(settings, { ...input, status: creatingStatus })
    }
  }

  const handleMove = async (byStatus: Partial<Record<TaskStatus, string[]>>) => {
    try {
      // Rebuild the whole board's ordered ids. Columns the drag did not touch
      // keep their current order; a task that moved columns is taken out of its
      // old column here, since the authoritative `tasks` still lists it there.
      const movedIds = new Set(Object.values(byStatus).flat())
      const entries: { id: string; status: TaskStatus; order: number }[] = []
      for (const status of STATUS_ORDER) {
        const overrides = byStatus[status]
        const ids =
          overrides ??
          tasks.filter((t) => t.status === status && !movedIds.has(t.id)).map((t) => t.id)
        for (let i = 0; i < ids.length; i++) {
          entries.push({ id: ids[i], status, order: i })
        }
      }
      await reorderTasks(settings, entries)
    } catch (err) {
      reportError(err, "Couldn't move the task")
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar: search + filters */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks, labels, assignees…"
            className="h-9 pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
            All statuses
          </FilterChip>
          {TASK_STATUSES.map((status) => (
            <FilterChip
              key={status}
              active={statusFilter === status}
              onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
            >
              {STATUS_LABEL[status]}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={priorityFilter === "all"} onClick={() => setPriorityFilter("all")}>
            Any priority
          </FilterChip>
          {TASK_PRIORITIES.map((priority) => (
            <FilterChip
              key={priority}
              active={priorityFilter === priority}
              onClick={() => setPriorityFilter(priorityFilter === priority ? "all" : priority)}
            >
              {priority}
            </FilterChip>
          ))}
        </div>
      </div>

      <Board
        tasks={filtered}
        onMove={handleMove}
        onNew={openNew}
        onTaskClick={(task) => setDialog({ open: true, task })}
      />

      <TaskFormDialog
        open={dialog.open}
        onOpenChange={(open) => {
          if (!open) setDialog({ open: false, task: null })
        }}
        task={dialog.task}
        onSave={handleSave}
        onDelete={
          dialog.task
            ? async () => {
                await deleteTask(settings, dialog.task!.id)
                setDialog({ open: false, task: null })
              }
            : undefined
        }
      />
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`Filter by ${children}`}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  )
}
