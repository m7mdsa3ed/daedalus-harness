import * as React from "react"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm, Controller } from "react-hook-form"
import { toast } from "@/lib/toast"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  PRIORITY_LABEL,
  TASK_PRIORITIES,
  type Task,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/tasks-board"
import { COLOR_DOT, type BoardStatus } from "@/lib/boards"
import { cn } from "@/lib/utils"
import { reportError } from "@/lib/errors"
import { TaskEditor } from "./task-editor"

/* `statusId` is a free string, not an enum: the columns are the board's rows
   (lib/boards.ts), so what is valid depends on which board this task is on and
   is checked by the server. The Select only ever offers real ones. */
const schema = z.object({
  title: z.string().trim().min(1, "A title is required").max(500),
  description: z.string().max(50_000).optional(),
  statusId: z.string().min(1, "Pick a column"),
  priority: z.enum(TASK_PRIORITIES),
  labels: z.string().max(200).optional(),
  assignee: z.string().max(200).optional(),
  dueAt: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

const empty = (statusId: string): FormValues => ({
  title: "",
  description: "",
  statusId,
  priority: "medium",
  labels: "",
  assignee: "",
  dueAt: "",
})

function toDateInput(ms: number | null): string {
  if (ms == null) return ""
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toForm(task: Task): FormValues {
  return {
    title: task.title,
    description: task.description ?? "",
    statusId: task.statusId,
    priority: task.priority,
    labels: task.labels.join(", "),
    assignee: task.assignee ?? "",
    dueAt: toDateInput(task.dueAt),
  }
}

/** "YYYY-MM-DD" → epoch ms at noon local (midnight floats across TZ when rendered). */
function fromDateInput(value: string | undefined): number | null {
  if (!value) return null
  const d = new Date(`${value}T12:00:00`)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  statuses,
  defaultStatusId,
  onSave,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The task being edited, or null for a new one. */
  task: Task | null
  /** The board's columns — what the Status select offers. */
  statuses: BoardStatus[]
  /** Column a new task starts in (the one whose "+" was pressed). */
  defaultStatusId: string
  onSave: (input: TaskInput) => Promise<void>
  /** Present when editing: deletes the task and closes the dialog. */
  onDelete?: () => Promise<void>
}) {
  const [busy, setBusy] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const blank = React.useMemo(
    () => empty(defaultStatusId || statuses[0]?.id || ""),
    [defaultStatusId, statuses],
  )
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: blank,
    values: task ? toForm(task) : blank,
  })

  const submit = form.handleSubmit(async (values) => {
    setBusy(true)
    try {
      await onSave({
        title: values.title,
        description: values.description || null,
        statusId: values.statusId,
        priority: values.priority,
        labels: values.labels
          ? values.labels
              .split(",")
              .map((l) => l.trim())
              .filter(Boolean)
          : [],
        assignee: values.assignee || null,
        dueAt: fromDateInput(values.dueAt),
      })
      toast.success(task ? "Task updated" : "Task created")
      onOpenChange(false)
    } catch (err) {
      reportError(err, task ? "Couldn't update the task" : "Couldn't create the task")
    } finally {
      setBusy(false)
    }
  })

  const doDelete = async () => {
    if (!onDelete) return
    setDeleting(true)
    try {
      await onDelete()
      toast.success("Task deleted")
      onOpenChange(false)
    } catch (err) {
      reportError(err, "Couldn't delete the task")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4 pr-14 sm:px-6 sm:py-5">
          <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            {task
              ? "Update the task's details. Board position is unchanged."
              : "Add a task to the board."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <div className="grid min-h-0 overflow-y-auto md:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="grid content-start gap-6 px-5 py-5 sm:px-6 sm:py-6 md:min-h-[30rem]">
              <div className="grid gap-2">
                <Label htmlFor="task-title">Title</Label>
                <Input
                  id="task-title"
                  autoFocus
                  {...form.register("title")}
                  placeholder="What needs doing?"
                  data-invalid={form.formState.errors.title ? true : undefined}
                />
                {form.formState.errors.title && (
                  <p className="text-xs text-destructive" role="alert">
                    {form.formState.errors.title.message}
                  </p>
                )}
              </div>

              <div className="grid gap-2">
                <Label>Description</Label>
                <Controller
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <TaskEditor
                      key={task?.id ?? "new"}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      placeholder="Describe this task… **bold**, `code`, links and lists work."
                      className="[&_.ProseMirror]:min-h-[18rem]"
                    />
                  )}
                />
              </div>
            </div>

            <aside className="grid content-start gap-5 border-t bg-muted/30 px-5 py-5 sm:px-6 md:border-t-0 md:border-l md:px-5 md:py-6">
              <div className="grid gap-2">
                <Label>Status</Label>
                <Controller
                  control={form.control}
                  name="statusId"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={(v) => field.onChange(v as TaskStatus)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {statuses.find((s) => s.id === field.value)?.name ?? "Choose a column"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {statuses.map((status) => (
                          <SelectItem key={status.id} value={status.id}>
                            <span className="inline-flex items-center gap-2">
                              {status.color && (
                                <span className={cn("size-2 rounded-full", COLOR_DOT[status.color])} />
                              )}
                              {status.name}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="grid gap-2">
                <Label>Priority</Label>
                <Controller
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={(v) => field.onChange(v as TaskPriority)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>{PRIORITY_LABEL[field.value]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {TASK_PRIORITIES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {PRIORITY_LABEL[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="task-assignee">Assignee</Label>
                <Input
                  id="task-assignee"
                  {...form.register("assignee")}
                  placeholder="Optional"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="task-labels">Labels</Label>
                <Input
                  id="task-labels"
                  {...form.register("labels")}
                  placeholder="Comma-separated"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="task-due">Due date</Label>
                <Input
                  id="task-due"
                  type="date"
                  {...form.register("dueAt")}
                  className="[&::-webkit-calendar-picker-indicator]:opacity-60"
                />
              </div>
            </aside>
          </div>

          <footer className="flex flex-col-reverse gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              {task && onDelete && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={doDelete}
                  disabled={deleting}
                  className="text-destructive hover:bg-destructive/10"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </Button>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : task ? "Save changes" : "Create task"}
              </Button>
            </div>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}
