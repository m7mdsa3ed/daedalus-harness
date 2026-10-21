import * as React from "react"
import { CalendarIcon, ChevronDown, CornerDownRight, Rocket, Tag } from "lucide-react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
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
import { clearNewTaskDraft, loadNewTaskDraft, saveNewTaskDraft } from "@/lib/task-drafts"
import {
  AssigneeAvatar,
  AssigneePicker,
  CHIP,
  DatePicker,
  LabelChip,
  LabelsPicker,
  NumberPicker,
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
import { AiFormBuilder } from "@/components/settings/ai-form-builder"

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
  serverId,
  onCreate,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  board: Board
  serverId: string
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
  const [another, setAnother] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const [editorKey, setEditorKey] = React.useState(0)

  React.useEffect(() => {
    if (open) {
      const next = loadNewTaskDraft(serverId, board.id) ?? blank()
      setDraft(next)
      // The extra chips are shown when anything behind them already has a value.
      setMore(!!(next.labels?.length || next.sprintId || next.parentId || next.startAt != null || next.estimate != null))
      setError(null)
      setEditorKey((k) => k + 1)
    }
  }, [open, blank, board.id, serverId])

  const patch = (p: Partial<TaskInput>) => {
    const next = { ...draft, ...p }
    setDraft(next)
    saveNewTaskDraft(serverId, board.id, next)
  }
  const parent = draft.parentId ? allTasks.find((t) => t.id === draft.parentId) : undefined

  const submit = async (event: React.FormEvent, another = false) => {
    event.preventDefault()
    const title = draft.title?.trim()
    if (!title || busy) return
    setBusy(true)
    setError(null)
    try {
      const task = await onCreate({ ...draft, title, description: draft.description || null })
      clearNewTaskDraft(serverId, board.id)
      toast.success(`${taskKey(task, board.key)} created`)
      if (another) {
        const nextDraft = { ...blank(), statusId: draft.statusId, type: draft.type, sprintId: draft.sprintId, parentId: draft.parentId }
        setDraft(nextDraft)
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

  const chip = cn(CHIP, "border border-input px-2")
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader className="flex-row items-center gap-2">
          <ResponsiveDialogTitle>New task</ResponsiveDialogTitle>
          <Badge variant="outline" className="font-mono">
            {board.key}
          </Badge>
          <ResponsiveDialogDescription className="sr-only">
            On {board.name}
            {parent ? ` under ${taskKey(parent, board.key)} ${parent.title}` : ""}
          </ResponsiveDialogDescription>
          <span className="ms-auto">
            <AiFormBuilder
              title="task"
              value={draft as Record<string, unknown>}
              onApply={(next) => patch(next as Partial<TaskInput>)}
              schema={{
                type: "object",
                properties: {
                  title: { type: "string", description: "Concise task title.", examples: ["Handle empty API responses"] },
                  description: { type: "string", description: "Context, goal, acceptance criteria, and implementation notes in Markdown." },
                  type: { type: "string", enum: ["task", "bug", "story", "epic"], description: "Task category." },
                  priority: { type: "string", enum: ["lowest", "low", "medium", "high", "urgent"], description: "Urgency." },
                  statusId: { type: "string", enum: statuses.map((status) => status.id), description: "One of the current board status ids." },
                  labels: { type: "array", items: { type: "string" }, description: "Short tags describing area or theme." },
                  assignee: { type: ["string", "null"], enum: [...facets.assignees, null], description: "Assignee name, or null." },
                  estimate: { type: ["integer", "null"], description: "Story-point estimate, or null." },
                },
                required: ["title", "description", "type", "priority", "statusId"],
                additionalProperties: false,
              }}
            />
          </span>
        </ResponsiveDialogHeader>
        {/* The footer is partitioned out of the children, so the buttons hang
            off the form by id rather than by nesting. `contents`, so the
            fields stand in the dialog body's own rhythm. */}
        <form id="new-task-form" onSubmit={(e) => void submit(e, another)} className="contents">
          <Label htmlFor="new-task-title" className="sr-only">
            Title
          </Label>
          <Input
            id="new-task-title"
            autoFocus
            value={draft.title ?? ""}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="What needs doing?"
            className="h-11 rounded-none border-0 bg-transparent px-0 font-heading text-xl leading-snug font-medium md:text-xl shadow-none focus-visible:ring-0 dark:bg-transparent"
          />

          <div className="flex flex-wrap items-center gap-2">
            <TypePicker
              value={draft.type ?? "task"}
              onChange={(type) => patch({ type })}
              trigger={
                <button type="button" className={chip}>
                  <TypeIcon type={draft.type ?? "task"} /> {TYPE_LABEL[draft.type ?? "task"]}
                </button>
              }
            />
            <StatusPicker
              value={draft.statusId}
              statuses={statuses}
              onChange={(statusId) => patch({ statusId })}
              trigger={
                <button type="button" className={chip}>
                  <StatusPill status={statuses.find((s) => s.id === draft.statusId)} />
                </button>
              }
            />
            <PriorityPicker
              value={draft.priority ?? "medium"}
              onChange={(priority) => patch({ priority })}
              trigger={
                <button type="button" className={chip}>
                  <PriorityIcon priority={draft.priority ?? "medium"} /> {PRIORITY_LABEL[draft.priority ?? "medium"]}
                </button>
              }
            />
            <AssigneePicker
              value={draft.assignee ?? null}
              suggestions={facets.assignees}
              onChange={(assignee) => patch({ assignee })}
              trigger={
                <button type="button" className={chip}>
                  <AssigneeAvatar name={draft.assignee ?? null} size="xs" /> <span className="truncate">{draft.assignee ?? "Assignee"}</span>
                </button>
              }
            />
            <DatePicker
              value={draft.dueAt ?? null}
              onChange={(dueAt) => patch({ dueAt })}
              trigger={
                <button type="button" className={chip}>
                  <CalendarIcon className="size-3.5 text-muted-foreground" /> {dueLabel(draft.dueAt ?? null) ?? "Due date"}
                </button>
              }
            />
            {more && (
              <>
                <LabelsPicker
                  value={draft.labels ?? []}
                  suggestions={facets.labels}
                  onChange={(labels) => patch({ labels })}
                  trigger={
                    <button type="button" className={cn(chip, "h-auto min-h-7 flex-wrap py-0.5")}>
                      <Tag className="size-3.5 text-muted-foreground" />
                      {(draft.labels ?? []).length === 0 ? "Labels" : (draft.labels ?? []).map((l) => <LabelChip key={l} label={l} />)}
                    </button>
                  }
                />
                <SprintPicker
                  value={draft.sprintId ?? null}
                  sprints={sprints}
                  onChange={(sprintId) => patch({ sprintId })}
                  trigger={
                    <button type="button" className={chip}>
                      <Rocket className="size-3.5 text-muted-foreground" />
                      <span className="truncate">{sprints.find((s) => s.id === draft.sprintId)?.name ?? "Backlog"}</span>
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
                    <button type="button" className={chip}>
                      {parent ? (
                        <>
                          <TypeIcon type={parent.type} /> {taskKey(parent, board.key)}
                        </>
                      ) : (
                        <>
                          <CornerDownRight className="size-3.5 text-muted-foreground" /> Parent
                        </>
                      )}
                    </button>
                  }
                />
                <DatePicker
                  value={draft.startAt ?? null}
                  onChange={(startAt) => patch({ startAt })}
                  trigger={
                    <button type="button" className={chip}>
                      <CalendarIcon className="size-3.5 text-muted-foreground" />{" "}
                      {draft.startAt != null ? `Starts ${new Date(draft.startAt).toLocaleDateString()}` : "Start date"}
                    </button>
                  }
                />
                <NumberPicker
                  value={draft.estimate ?? null}
                  onChange={(estimate) => patch({ estimate })}
                  trigger={
                    <button type="button" className={chip}>
                      <span className="tabular-nums">{draft.estimate ?? "–"}</span> points
                    </button>
                  }
                />
              </>
            )}
            <button type="button" onClick={() => setMore((m) => !m)} className={cn(CHIP, "text-muted-foreground")} aria-expanded={more}>
              <ChevronDown className={cn("size-3.5 transition-transform", more && "rotate-180")} /> {more ? "Fewer" : "More"}
            </button>
          </div>

          <TaskEditor
            key={editorKey}
            value={draft.description ?? ""}
            onChange={(description) => patch({ description })}
            placeholder="Describe the task… **bold**, `code`, links and lists work."
            className="[&_.ProseMirror]:min-h-[10rem]"
          />

          <ErrorNote error={error} />
        </form>

        <ResponsiveDialogFooter className="flex-row items-center">
          <label className="me-auto flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={another} onCheckedChange={setAnother} />
            Create another
          </label>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-task-form" loading={busy} disabled={!draft.title?.trim()}>
            Create
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
