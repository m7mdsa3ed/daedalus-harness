import * as React from "react"
import { CalendarIcon, ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ErrorNote } from "@/components/error-note"
import { captureError, type InlineError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import type { Board, BoardStatus, Sprint } from "@/lib/boards"
import { PRIORITY_LABEL, TYPE_LABEL, taskKey, type Task, type TaskInput } from "@/lib/tasks-board"
import { dueLabel } from "@/lib/tasks-view"
import {
  AssigneeAvatar,
  AssigneePicker,
  CHIP,
  DatePicker,
  LabelChip,
  LabelsPicker,
  ParentPicker,
  PriorityIcon,
  PriorityPicker,
  SprintPicker,
  StatusPicker,
  StatusPill,
  TypeIcon,
  TypePicker,
} from "./fields"
import { TaskEditor } from "./task-editor"

/**
 * Create a task with the fields that matter up front. The detail panel is
 * where everything else (checklist, links, comments, custom fields) lives, so
 * this stays one screen: title, description, and a row of property chips.
 * `defaults` is where the caller says what the task inherits — the column
 * whose "+" was pressed, the sprint, the epic.
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  board,
  statuses,
  sprints,
  allTasks,
  facets,
  defaults,
  onCreate,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  board: Board
  statuses: BoardStatus[]
  sprints: Sprint[]
  allTasks: Task[]
  facets: { assignees: string[]; labels: string[] }
  defaults: Partial<TaskInput>
  onCreate: (input: TaskInput & { title: string }) => Promise<Task>
  onCreated?: (task: Task) => void
}) {
  const blank = React.useCallback(
    (): TaskInput => ({
      title: "",
      description: "",
      statusId: defaults.statusId ?? statuses[0]?.id,
      type: defaults.type ?? "task",
      priority: defaults.priority ?? "medium",
      labels: defaults.labels ?? [],
      assignee: defaults.assignee ?? null,
      parentId: defaults.parentId ?? null,
      sprintId: defaults.sprintId ?? null,
      estimate: defaults.estimate ?? null,
      startAt: defaults.startAt ?? null,
      dueAt: defaults.dueAt ?? null,
    }),
    [defaults, statuses],
  )
  const [draft, setDraft] = React.useState<TaskInput>(blank)
  const [more, setMore] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const [editorKey, setEditorKey] = React.useState(0)

  React.useEffect(() => {
    if (open) {
      setDraft(blank())
      setError(null)
      setEditorKey((k) => k + 1)
    }
  }, [open, blank])

  const patch = (p: Partial<TaskInput>) => setDraft((d) => ({ ...d, ...p }))
  const parent = draft.parentId ? allTasks.find((t) => t.id === draft.parentId) : undefined

  const submit = async (event: React.FormEvent, another = false) => {
    event.preventDefault()
    const title = draft.title?.trim()
    if (!title || busy) return
    setBusy(true)
    setError(null)
    try {
      const task = await onCreate({ ...draft, title, description: draft.description || null })
      toast.success(`${taskKey(task, board.key)} created`)
      if (another) {
        setDraft({ ...blank(), statusId: draft.statusId, type: draft.type, sprintId: draft.sprintId, parentId: draft.parentId })
        setEditorKey((k) => k + 1)
      } else {
        onOpenChange(false)
        onCreated?.(task)
      }
    } catch (err) {
      setError(captureError(err, "Couldn't create the task"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>New task</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            On <span className="font-medium text-foreground">{board.name}</span>
            {parent ? (
              <>
                {" "}
                under <span className="font-medium text-foreground">{taskKey(parent, board.key)} {parent.title}</span>
              </>
            ) : null}
            .
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {/* The footer is partitioned out of the children, so the buttons hang
            off the form by id rather than by nesting. */}
        <form id="new-task-form" onSubmit={(e) => void submit(e)} className="grid content-start gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="new-task-title" className="sr-only">
                Title
              </Label>
              <Input
                id="new-task-title"
                autoFocus
                value={draft.title ?? ""}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder="What needs doing?"
                className="h-10 text-base font-medium"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <TypePicker
                value={draft.type ?? "task"}
                onChange={(type) => patch({ type })}
                trigger={
                  <button type="button" className={CHIP}>
                    <TypeIcon type={draft.type ?? "task"} /> {TYPE_LABEL[draft.type ?? "task"]}
                  </button>
                }
              />
              <StatusPicker
                value={draft.statusId ?? ""}
                statuses={statuses}
                onChange={(statusId) => patch({ statusId })}
                trigger={
                  <button type="button" className={CHIP}>
                    <StatusPill status={statuses.find((s) => s.id === draft.statusId)} />
                  </button>
                }
              />
              <PriorityPicker
                value={draft.priority ?? "medium"}
                onChange={(priority) => patch({ priority })}
                trigger={
                  <button type="button" className={CHIP}>
                    <PriorityIcon priority={draft.priority ?? "medium"} /> {PRIORITY_LABEL[draft.priority ?? "medium"]}
                  </button>
                }
              />
              <AssigneePicker
                value={draft.assignee ?? null}
                suggestions={facets.assignees}
                onChange={(assignee) => patch({ assignee })}
                trigger={
                  <button type="button" className={CHIP}>
                    <AssigneeAvatar name={draft.assignee ?? null} size="xs" /> {draft.assignee ?? "Assignee"}
                  </button>
                }
              />
              <DatePicker
                value={draft.dueAt ?? null}
                onChange={(dueAt) => patch({ dueAt })}
                trigger={
                  <button type="button" className={CHIP}>
                    <CalendarIcon className="size-3.5 text-muted-foreground" /> {dueLabel(draft.dueAt ?? null) ?? "Due date"}
                  </button>
                }
              />
              <button type="button" onClick={() => setMore((m) => !m)} className={CHIP} aria-expanded={more}>
                <ChevronDown className={`size-3.5 transition-transform ${more ? "rotate-180" : ""}`} /> {more ? "Fewer" : "More"}
              </button>
            </div>

            {more && (
              <div className="flex flex-wrap items-center gap-1 rounded-xl border bg-muted/30 p-2">
                <LabelsPicker
                  value={draft.labels ?? []}
                  suggestions={facets.labels}
                  onChange={(labels) => patch({ labels })}
                  trigger={
                    <button type="button" className={`${CHIP} flex-wrap`}>
                      {(draft.labels ?? []).length === 0 ? "Labels" : (draft.labels ?? []).map((l) => <LabelChip key={l} label={l} />)}
                    </button>
                  }
                />
                <SprintPicker
                  value={draft.sprintId ?? null}
                  sprints={sprints}
                  onChange={(sprintId) => patch({ sprintId })}
                  trigger={
                    <button type="button" className={CHIP}>
                      {sprints.find((s) => s.id === draft.sprintId)?.name ?? "Sprint: backlog"}
                    </button>
                  }
                />
                <ParentPicker
                  value={draft.parentId ?? null}
                  candidates={allTasks}
                  boardKey={board.key}
                  exclude={new Set()}
                  onChange={(parentId) => patch({ parentId })}
                  trigger={
                    <button type="button" className={CHIP}>
                      {parent ? (
                        <>
                          <TypeIcon type={parent.type} /> {taskKey(parent, board.key)}
                        </>
                      ) : (
                        "Parent / epic"
                      )}
                    </button>
                  }
                />
                <DatePicker
                  value={draft.startAt ?? null}
                  onChange={(startAt) => patch({ startAt })}
                  trigger={
                    <button type="button" className={CHIP}>
                      <CalendarIcon className="size-3.5 text-muted-foreground" /> {draft.startAt != null ? `Starts ${new Date(draft.startAt).toLocaleDateString()}` : "Start date"}
                    </button>
                  }
                />
                <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  Points
                  <Input
                    inputMode="numeric"
                    value={draft.estimate ?? ""}
                    onChange={(e) => patch({ estimate: e.target.value === "" ? null : Math.max(0, Math.round(Number(e.target.value)) || 0) })}
                    className="h-7 w-14 text-xs"
                  />
                </label>
              </div>
            )}

            <TaskEditor
              key={editorKey}
              value={draft.description ?? ""}
              onChange={(description) => patch({ description })}
              placeholder="Describe the task… **bold**, `code`, links and lists work."
              className="[&_.ProseMirror]:min-h-[10rem]"
            />

            <ErrorNote error={error} />
          </form>

          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" variant="outline" form="new-task-form" disabled={busy || !draft.title?.trim()} onClick={(e) => void submit(e, true)}>
              Create another
            </Button>
            <Button type="submit" form="new-task-form" disabled={busy || !draft.title?.trim()}>
              {busy ? "Creating…" : "Create task"}
            </Button>
          </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
