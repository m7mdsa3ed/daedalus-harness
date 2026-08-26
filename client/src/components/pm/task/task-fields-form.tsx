/* The left half of the task editor: the fields, then the markdown body.
   There is no Save button — a task editor that can lose work is worse than one
   that writes a field at a time, and the server's mutation pipeline already
   treats a no-op patch as a no-op (no activity row, no updatedAt churn), so a
   blur that changed nothing costs nothing.

   react-hook-form + zod are the codebase's existing deps, so the form is real:
   every field is a Controller, and a commit runs `trigger(field)` — the zod
   resolver — before anything reaches the wire. Text that fails validation
   (letters in story points) simply never becomes a patch.

   Status is the one field that is NOT a patch: a column change is a move, so
   it ranks, it stamps completedAt from the target column's category, and it
   goes through `actions.moveTask` like a kanban drop does. */
import * as React from "react"
import { useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { reportError } from "@/lib/errors"
import type { Actions } from "@/lib/actions"
import type { Board, Task, TaskPatch } from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { CustomFieldValues } from "@/components/pm/task/custom-field-renderer"
import { RecurrenceEditor } from "@/components/pm/task/recurrence-editor"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/** Select has no empty value, so "no type" needs a token of its own. */
const NONE = "__none"

export const PRIORITY_NAMES = ["None", "Low", "Medium", "High", "Urgent"]

/* Everything is a string here on purpose: an `<input>` holds text, and zod is
   what turns text into a number or refuses to. */
const formSchema = z.object({
  descriptionMd: z.string(),
  typeId: z.string(),
  priority: z.string(),
  assignees: z.string(),
  labelIds: z.array(z.string()),
  startDate: z.string(),
  dueDate: z.string(),
  storyPoints: z.string().regex(/^\d*$/, "Whole numbers only"),
  estimateMinutes: z.string().regex(/^\d*$/, "Minutes, whole numbers only"),
})

type FormValues = z.infer<typeof formSchema>
type FieldName = keyof FormValues

function toDateInput(ms: number | null): string {
  if (ms === null) return ""
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fromDateInput(value: string): number | null {
  if (!value) return null
  const [year, month, day] = value.split("-").map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day).getTime()
}

function toForm(task: Task): FormValues {
  return {
    descriptionMd: task.descriptionMd ?? "",
    typeId: task.typeId ?? NONE,
    priority: String(task.priority),
    assignees: task.assignees.join(", "),
    labelIds: task.labelIds,
    startDate: toDateInput(task.startDate),
    dueDate: toDateInput(task.dueDate),
    storyPoints: task.storyPoints === null ? "" : String(task.storyPoints),
    estimateMinutes: task.estimateMinutes === null ? "" : String(task.estimateMinutes),
  }
}

/** One form field → the TaskPatch fragment it stands for. */
function patchFor(field: FieldName, values: FormValues): TaskPatch {
  switch (field) {
    case "descriptionMd":
      return { descriptionMd: values.descriptionMd.trim() === "" ? null : values.descriptionMd }
    case "typeId":
      return { typeId: values.typeId === NONE ? null : values.typeId }
    case "priority":
      return { priority: Number(values.priority) }
    case "assignees":
      return {
        assignees: values.assignees
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      }
    case "labelIds":
      return { labelIds: values.labelIds }
    case "startDate":
      return { startDate: fromDateInput(values.startDate) }
    case "dueDate":
      return { dueDate: fromDateInput(values.dueDate) }
    case "storyPoints":
      return { storyPoints: values.storyPoints === "" ? null : Number(values.storyPoints) }
    case "estimateMinutes":
      return {
        estimateMinutes: values.estimateMinutes === "" ? null : Number(values.estimateMinutes),
      }
  }
}

function FieldRow({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="min-w-0">
        {children}
        {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
      </div>
    </div>
  )
}

export function TaskFieldsForm({
  board,
  task,
  actions,
}: {
  board: Board
  task: Task
  actions: Actions
}) {
  const { state } = useStore()
  const [preview, setPreview] = React.useState(false)
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: toForm(task),
    mode: "onChange",
  })
  const { control, getValues, trigger, reset, formState } = form

  /* A fresh task is a fresh form; a same-task update (our own patch coming
     back, or another client's write arriving on focus) refreshes only the
     fields the user is not in the middle of editing. */
  const taskId = task.id
  const updatedAt = task.updatedAt
  React.useEffect(() => {
    reset(toForm(task), { keepDirtyValues: true })
    // `task` is intentionally read fresh but not depended on: identity changes
    // on every store write, and updatedAt is the honest "it changed" signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, updatedAt, reset])

  const commit = async (field: FieldName) => {
    if (!(await trigger(field))) return
    const patch = patchFor(field, getValues())
    try {
      await actions.patchTask(board.id, task.id, patch)
    } catch (error) {
      reportError(error, "Couldn't save the task")
    }
  }

  /* Status is a move, and a move needs a position: append to the end of the
     target column, which is what the server does for a patch-driven change. */
  const changeColumn = async (columnId: string) => {
    if (columnId === task.columnId) return
    const index = (state.pmTasks[board.id] ?? []).filter(
      (row) => row.columnId === columnId && row.deletedAt === null && row.archivedAt === null
    ).length
    try {
      await actions.moveTask(board.id, task.id, { columnId, index })
    } catch {
      // moveTask already rolled the card back and reported it.
    }
  }

  const errors = formState.errors
  const type = board.issueTypes.find((entry) => entry.id === task.typeId)

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <FieldRow label="Status">
          <Select value={task.columnId} onValueChange={(value) => void changeColumn(String(value))}>
            <SelectTrigger className="w-full">
              <SelectValue>
                {board.columns.find((column) => column.id === task.columnId)?.name ?? "—"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {board.columns.map((column) => (
                <SelectItem key={column.id} value={column.id}>
                  {column.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>

        <FieldRow label="Type">
          <Controller
            control={control}
            name="typeId"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(String(value ?? NONE))
                  void commit("typeId")
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{type?.name ?? "No type"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No type</SelectItem>
                  {board.issueTypes.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FieldRow>

        <FieldRow label="Priority">
          <Controller
            control={control}
            name="priority"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(String(value ?? "0"))
                  void commit("priority")
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{PRIORITY_NAMES[Number(field.value)] ?? "None"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_NAMES.map((name, value) => (
                    <SelectItem key={name} value={String(value)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FieldRow>

        <FieldRow label="Assignees">
          <Controller
            control={control}
            name="assignees"
            render={({ field }) => (
              <Input
                value={field.value}
                onChange={field.onChange}
                onBlur={() => void commit("assignees")}
                placeholder="Comma-separated names"
                className="h-8 text-[13px]"
              />
            )}
          />
        </FieldRow>

        <FieldRow label="Labels">
          <Controller
            control={control}
            name="labelIds"
            render={({ field }) => (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="sm" className="w-full justify-start font-normal" />
                  }
                >
                  {field.value.length === 0 ? (
                    <span className="text-muted-foreground">No labels</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {field.value.map((id) => {
                        const label = board.labels.find((entry) => entry.id === id)
                        return (
                          <Badge key={id} variant="secondary" className="text-[10px]">
                            {label?.name ?? id}
                          </Badge>
                        )
                      })}
                    </span>
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {board.labels.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      This board has no labels yet.
                    </div>
                  )}
                  {board.labels.map((label) => (
                    <DropdownMenuCheckboxItem
                      key={label.id}
                      checked={field.value.includes(label.id)}
                      onCheckedChange={(checked) => {
                        const next = checked
                          ? [...field.value, label.id]
                          : field.value.filter((id) => id !== label.id)
                        field.onChange(next)
                        void commit("labelIds")
                      }}
                    >
                      {label.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          />
        </FieldRow>

        <FieldRow label="Start">
          <Controller
            control={control}
            name="startDate"
            render={({ field }) => (
              <Input
                type="date"
                value={field.value}
                onChange={(event) => {
                  field.onChange(event.target.value)
                  void commit("startDate")
                }}
                className="h-8 text-[13px]"
              />
            )}
          />
        </FieldRow>

        <FieldRow label="Due">
          <Controller
            control={control}
            name="dueDate"
            render={({ field }) => (
              <Input
                type="date"
                value={field.value}
                onChange={(event) => {
                  field.onChange(event.target.value)
                  void commit("dueDate")
                }}
                className="h-8 text-[13px]"
              />
            )}
          />
        </FieldRow>

        <FieldRow label="Points" error={errors.storyPoints?.message}>
          <Controller
            control={control}
            name="storyPoints"
            render={({ field }) => (
              <Input
                inputMode="numeric"
                value={field.value}
                onChange={field.onChange}
                onBlur={() => void commit("storyPoints")}
                placeholder="—"
                className="h-8 w-24 text-[13px]"
              />
            )}
          />
        </FieldRow>

        <FieldRow label="Estimate" error={errors.estimateMinutes?.message}>
          <Controller
            control={control}
            name="estimateMinutes"
            render={({ field }) => (
              <Input
                inputMode="numeric"
                value={field.value}
                onChange={field.onChange}
                onBlur={() => void commit("estimateMinutes")}
                placeholder="minutes"
                className="h-8 w-24 text-[13px]"
              />
            )}
          />
        </FieldRow>

        {/* Repeats: spawn-on-complete. Not a form field — the recurrence is a
            json object the editor writes whole through its own patch. */}
        <FieldRow label="Repeats">
          <RecurrenceEditor task={task} actions={actions} />
        </FieldRow>

        {/* Whatever this board has added. Generic in `type`, never in name:
            the renderer switches on CustomFieldDef.type and writes through
            `customFieldValues`, so a new field needs no code here. */}
        <CustomFieldValues board={board} task={task} actions={actions} />
      </div>

      <section className="space-y-2">
        <header className="flex items-center gap-2">
          <Label className="text-xs font-medium text-muted-foreground">Description</Label>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground"
            onClick={() => setPreview((on) => !on)}
          >
            {preview ? "Edit" : "Preview"}
          </Button>
        </header>
        <Controller
          control={control}
          name="descriptionMd"
          render={({ field }) =>
            preview ? (
              <div
                className="prose prose-sm min-h-24 max-w-none rounded-xl border p-3 text-[13px]"
                onDoubleClick={() => setPreview(false)}
              >
                {field.value.trim() === "" ? (
                  <p className="text-muted-foreground">No description.</p>
                ) : (
                  <Markdown remarkPlugins={[remarkGfm]}>{field.value}</Markdown>
                )}
              </div>
            ) : (
              <Textarea
                value={field.value}
                onChange={field.onChange}
                onBlur={() => void commit("descriptionMd")}
                rows={8}
                placeholder="Markdown supported…"
                className="resize-y text-[13px]"
              />
            )
          }
        />
      </section>
    </div>
  )
}
