import * as React from "react"
import { format } from "date-fns"
import { CalendarIcon, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { usePmActions } from "@/components/pm/pm-sidebar-panels"
import { TaskTemplatePicker } from "@/components/pm/settings/template-flows"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Board, Task, TaskCreateInput } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

/* ── Quick create ──
   The fast path onto a board: a title and Enter. Everything else here has a
   default the server would have picked anyway, so the dialog opens ready to
   submit and the rest of a task's shape (description, subtasks, checklists,
   estimates, custom fields) belongs to the task editor.

   The column defaults to where the create was started from — the "+" on a
   kanban lane — and otherwise to the first open column, which is the same
   column the server falls back to.

   A task template (device-local, lib/pm/task-templates) is a saved shape, not a
   saved task: picking one fills the fields this dialog shows and carries the
   rest of its payload — description, checklists, estimates, custom-field values
   — straight into the create, since there is nowhere here to show them. */

const PRIORITY_NAMES = ["None", "Low", "Medium", "High", "Urgent"]

const NO_TYPE = "__none__"

interface Draft {
  title: string
  columnId: string
  typeId: string
  priority: number
  dueDate: number | null
  assignees: string[]
  labelIds: string[]
}

/** The column a fresh draft lands in: the caller's, else the first `open` one,
    else simply the first — a board always has at least one column. */
function initialColumn(board: Board, defaultColumnId?: string): string {
  if (defaultColumnId && board.columns.some((c) => c.id === defaultColumnId)) return defaultColumnId
  const open = board.columns.find((c) => c.category === "open")
  return (open ?? board.columns[0])?.id ?? ""
}

function emptyDraft(board: Board, defaultColumnId?: string): Draft {
  return {
    title: "",
    columnId: initialColumn(board, defaultColumnId),
    typeId: board.issueTypes[0]?.id ?? NO_TYPE,
    priority: 0,
    dueDate: null,
    assignees: [],
    labelIds: [],
  }
}

export interface NewTaskDialogProps {
  board: Board
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional: a caller that already holds Actions passes them; otherwise the
      dialog builds its own the way every router-rendered PM component does. */
  actions?: Actions
  /** Lane the create was started from; defaults to the first open column. */
  defaultColumnId?: string
  /** Backlog lane the create was started from: a sprint id, or `null` for the
      backlog itself. Absent = let the server decide (the backlog). */
  defaultSprintId?: string | null
  /** The created task — pm-page can open the editor on it. */
  onCreated?: (task: Task) => void
}

export function NewTaskDialog({
  board,
  open,
  onOpenChange,
  actions: passed,
  defaultColumnId,
  defaultSprintId,
  onCreated,
}: NewTaskDialogProps) {
  const own = usePmActions()
  const actions = passed ?? own
  const [draft, setDraft] = React.useState<Draft>(() => emptyDraft(board, defaultColumnId))
  /* What a picked template carries that this dialog has no control for
     (description, checklists, points, custom fields). Merged UNDER the draft on
     submit, so anything visible above still wins. */
  const [extras, setExtras] = React.useState<Partial<TaskCreateInput>>({})
  const [assignee, setAssignee] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  /* Every open starts clean — a dialog that reopens holding the last task's
     assignees would file the next one under the wrong person. */
  React.useEffect(() => {
    if (!open) return
    setDraft(emptyDraft(board, defaultColumnId))
    setExtras({})
    setAssignee("")
    setBusy(false)
  }, [open, board, defaultColumnId])

  const addAssignee = () => {
    const name = assignee.trim()
    if (!name) return
    if (!draft.assignees.includes(name)) set({ assignees: [...draft.assignees, name] })
    setAssignee("")
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const title = draft.title.trim()
    if (!title || busy) return
    setBusy(true)
    /* A name typed but not yet turned into a chip is still a name the user
       meant — submitting must not silently drop it. */
    const typed = assignee.trim()
    const assignees =
      typed && !draft.assignees.includes(typed) ? [...draft.assignees, typed] : draft.assignees
    const input: TaskCreateInput = {
      ...extras,
      title,
      columnId: draft.columnId || undefined,
      typeId: draft.typeId === NO_TYPE ? null : draft.typeId,
      priority: draft.priority,
      assignees,
      dueDate: draft.dueDate,
      labelIds: draft.labelIds,
      ...(defaultSprintId === undefined ? {} : { sprintId: defaultSprintId }),
    }
    try {
      const task = await actions.createTask(board.id, input)
      toast.success(`${task.key} created`)
      onOpenChange(false)
      onCreated?.(task)
    } catch (err) {
      reportError(err, "Couldn't create the task")
      setBusy(false)
    }
  }

  const column = board.columns.find((c) => c.id === draft.columnId)
  const type = board.issueTypes.find((t) => t.id === draft.typeId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              In {board.name} · {board.keyPrefix}-{board.nextKey}
            </DialogDescription>
          </DialogHeader>

          {/* Nothing at all when the board has no templates — an empty picker
              is a row of chrome explaining that a feature exists. */}
          <TaskTemplatePicker
            board={board}
            onPick={(input, template) => {
              setExtras(input)
              set({
                title: draft.title.trim() || template.name,
                columnId: input.columnId ?? draft.columnId,
                typeId: input.typeId ?? draft.typeId,
                priority: input.priority ?? draft.priority,
                assignees: input.assignees ?? draft.assignees,
                labelIds: input.labelIds ?? draft.labelIds,
              })
            }}
          />

          <Field label="Title">
            <Input
              autoFocus
              required
              aria-label="Title"
              value={draft.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="What needs doing?"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Status">
              <Select
                value={draft.columnId}
                onValueChange={(columnId) => set({ columnId: String(columnId ?? "") })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{column?.name}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {board.columns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Type">
              <Select
                value={draft.typeId}
                onValueChange={(typeId) => set({ typeId: String(typeId ?? NO_TYPE) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{type?.name ?? "None"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TYPE}>None</SelectItem>
                  {board.issueTypes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Priority">
              <Select
                value={String(draft.priority)}
                onValueChange={(priority) => set({ priority: Number(priority ?? 0) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{PRIORITY_NAMES[draft.priority]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_NAMES.map((name, value) => (
                    <SelectItem key={name} value={String(value)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Due date">
            <div className="flex items-center gap-1.5">
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "justify-start font-normal",
                        draft.dueDate === null && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon />
                      {draft.dueDate === null
                        ? "No due date"
                        : format(new Date(draft.dueDate), "EEE d MMM yyyy")}
                    </Button>
                  }
                />
                <PopoverContent align="start" className="w-auto p-0">
                  <Calendar
                    mode="single"
                    autoFocus
                    selected={draft.dueDate === null ? undefined : new Date(draft.dueDate)}
                    onSelect={(date) => set({ dueDate: date ? date.getTime() : null })}
                  />
                </PopoverContent>
              </Popover>
              {draft.dueDate !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear due date"
                  onClick={() => set({ dueDate: null })}
                >
                  <X />
                </Button>
              )}
            </div>
          </Field>

          <Field label="Assignees" hint="Free-form names — this server has one login, not accounts.">
            <div className="flex flex-wrap items-center gap-1.5">
              {draft.assignees.map((name) => (
                <Badge key={name} variant="outline" className="gap-1 pr-1 font-normal">
                  <span className="max-w-32 truncate">{name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => set({ assignees: draft.assignees.filter((a) => a !== name) })}
                    className="grid size-3.5 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-2.5" />
                  </button>
                </Badge>
              ))}
              <Input
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                onKeyDown={(e) => {
                  /* Enter adds the name; only an empty field lets Enter through
                     to the form, so typing a name never files the task early. */
                  if (e.key === "Enter" && assignee.trim()) {
                    e.preventDefault()
                    addAssignee()
                  }
                }}
                onBlur={addAssignee}
                placeholder="Add someone"
                aria-label="Add assignee"
                className="h-8 w-36 flex-1 text-sm"
              />
            </div>
          </Field>

          {board.labels.length > 0 && (
            <Field label="Labels">
              <div className="flex flex-wrap gap-1.5">
                {board.labels.map((labelDef) => {
                  const on = draft.labelIds.includes(labelDef.id)
                  return (
                    <button
                      key={labelDef.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set({
                          labelIds: on
                            ? draft.labelIds.filter((id) => id !== labelDef.id)
                            : [...draft.labelIds, labelDef.id],
                        })
                      }
                      className={cn(
                        "inline-flex h-6 items-center gap-1.5 rounded-4xl border border-border px-2 text-xs transition-colors",
                        on
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-muted"
                      )}
                    >
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
                        style={labelDef.color ? { backgroundColor: labelDef.color } : undefined}
                      />
                      {labelDef.name}
                    </button>
                  )
                })}
              </div>
            </Field>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || draft.title.trim().length === 0}>
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Local label/hint wrapper — the settings pages' `Field` belongs to their own
    form layout, and the PM dialogs want a plainer one. */
function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  /* A <div>, not a <label>: these rows wrap select triggers, popover buttons
     and chip lists, and a label that owns a click would fight all three. */
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}
