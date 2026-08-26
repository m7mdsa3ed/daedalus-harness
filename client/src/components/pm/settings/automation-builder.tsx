/* ── Automation builder ──
   WHEN a trigger fires → IF these conditions hold → THEN do these things.

   The unions rendered here are exactly the ones the server validates
   (`server/src/pm/schema.ts`: AutomationTriggerSchema / AutomationConditionSchema
   / AutomationActionSchema) — the action list in particular is a *whitelist*,
   which is the whole safety story behind the chain-depth cap, so this UI offers
   those ten and nothing else. Anything wider would only earn a 400.

   Nothing about one board's columns, labels, types, sprints or milestones is
   hardcoded: the field/operator/value controls are built from a descriptor
   table keyed by value *kind*, and the options for a kind come out of the board
   handed in. A board with new config needs no code here.

   IMPORTANT (server contract): label changes are journaled under the
   pseudo-field **"labels"**, not "labelIds" — `applyMutation` pushes
   `{ field: "labels", … }` because labels live in a join table. So a
   `field_changed` trigger must name "labels". Conditions are the other way
   round: they read the post-mutation task, where the same thing is exposed as
   the pseudo-field **"labelIds"** (alongside "columnCategory", the current
   column's open/active/done). Both spellings below are deliberate.

   Test is a dry run: `actions.testAutomation` evaluates the rule in the editor
   against a task the user picks and answers { matched, effects } — it applies
   nothing, and neither does this dialog. The writes go through
   `actions.putAutomation` / `actions.deleteAutomation`, which end in a board
   refetch because the board's `automations` array is what changed. */
import * as React from "react"
import { format } from "date-fns"
import {
  CalendarIcon,
  FlaskConical,
  Pencil,
  Plus,
  Trash2,
  X,
  Zap,
} from "lucide-react"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
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
import { Switch } from "@/components/ui/switch"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type {
  AutomationAction,
  AutomationCondition,
  AutomationPatch,
  AutomationRule,
  AutomationTestResult,
  AutomationTrigger,
  Board,
  Task,
} from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// The unions, as data

const PRIORITY_NAMES = ["None", "Low", "Medium", "High", "Urgent"]

/** The four AutomationTrigger members. */
const TRIGGER_TYPES: Array<{ type: AutomationTrigger["type"]; label: string; hint: string }> = [
  { type: "task_created", label: "Task is created", hint: "Fires once, as the task is added." },
  { type: "task_moved", label: "Task moves column", hint: "A move from somewhere — not the initial placement." },
  { type: "task_completed", label: "Task is completed", hint: "The transition into a done column, not every later edit." },
  { type: "field_changed", label: "Field changes", hint: "Fires when the named field appears in the change record." },
]

/** The six AutomationCondition operators. */
const OPS: Array<{ op: AutomationCondition["op"]; label: string }> = [
  { op: "eq", label: "is" },
  { op: "neq", label: "is not" },
  { op: "gte", label: "is at least" },
  { op: "lte", label: "is at most" },
  { op: "set", label: "is set" },
  { op: "unset", label: "is empty" },
]

/** The ten whitelisted AutomationAction members. `arg` names the value control
    the action's single payload needs. */
const ACTION_TYPES: Array<{ type: AutomationAction["type"]; label: string; arg: ValueKind }> = [
  { type: "set_column", label: "Move to column", arg: "column" },
  { type: "set_priority", label: "Set priority", arg: "priority" },
  { type: "set_assignees", label: "Set assignees", arg: "assignees" },
  { type: "add_label", label: "Add label", arg: "label" },
  { type: "remove_label", label: "Remove label", arg: "label" },
  { type: "set_sprint", label: "Set sprint", arg: "sprintOrNone" },
  { type: "set_milestone", label: "Set milestone", arg: "milestoneOrNone" },
  { type: "set_type", label: "Set type", arg: "type" },
  { type: "set_due_date", label: "Set due date", arg: "date" },
  { type: "archive", label: "Archive the task", arg: "none" },
]

/** What kind of value a field or an action payload holds — the only thing the
    generic controls dispatch on. */
type ValueKind =
  | "column"
  | "columnCategory"
  | "label"
  | "type"
  | "sprint"
  | "sprintOrNone"
  | "milestone"
  | "milestoneOrNone"
  | "priority"
  | "assignees"
  | "date"
  | "number"
  | "text"
  | "json"
  | "none"

interface FieldDef {
  name: string
  label: string
  kind: ValueKind
}

/**
 * Fields a `field_changed` trigger may watch: every field `applyMutation`
 * journals a ChangeRecord for (its PATCHABLE list minus the silent rank
 * fields), plus `completedAt`, plus the "labels" pseudo-field — see the
 * header note.
 */
const TRIGGER_FIELDS: FieldDef[] = [
  { name: "columnId", label: "Status column", kind: "column" },
  { name: "labels", label: "Labels", kind: "label" },
  { name: "priority", label: "Priority", kind: "priority" },
  { name: "assignees", label: "Assignees", kind: "assignees" },
  { name: "typeId", label: "Type", kind: "type" },
  { name: "sprintId", label: "Sprint", kind: "sprint" },
  { name: "milestoneId", label: "Milestone", kind: "milestone" },
  { name: "dueDate", label: "Due date", kind: "date" },
  { name: "startDate", label: "Start date", kind: "date" },
  { name: "storyPoints", label: "Story points", kind: "number" },
  { name: "estimateMinutes", label: "Estimate", kind: "number" },
  { name: "epicId", label: "Epic", kind: "text" },
  { name: "parentId", label: "Parent task", kind: "text" },
  { name: "title", label: "Title", kind: "text" },
  { name: "descriptionMd", label: "Description", kind: "text" },
  { name: "checklists", label: "Checklists", kind: "json" },
  { name: "customFieldValues", label: "Custom fields", kind: "json" },
  { name: "recurrence", label: "Recurrence", kind: "json" },
  { name: "completedAt", label: "Completed", kind: "date" },
  { name: "archivedAt", label: "Archived", kind: "date" },
  { name: "deletedAt", label: "Trashed", kind: "date" },
]

/**
 * Fields a condition may read. The task row as stored, plus the two
 * pseudo-fields the server synthesizes: `labelIds` (the join table, read AFTER
 * the mutation) and `columnCategory` (the current column's open/active/done).
 */
const CONDITION_FIELDS: FieldDef[] = [
  { name: "columnId", label: "Status column", kind: "column" },
  { name: "columnCategory", label: "Column category", kind: "columnCategory" },
  { name: "labelIds", label: "Labels", kind: "label" },
  { name: "priority", label: "Priority", kind: "priority" },
  { name: "assignees", label: "Assignees", kind: "assignees" },
  { name: "typeId", label: "Type", kind: "type" },
  { name: "sprintId", label: "Sprint", kind: "sprint" },
  { name: "milestoneId", label: "Milestone", kind: "milestone" },
  { name: "dueDate", label: "Due date", kind: "date" },
  { name: "startDate", label: "Start date", kind: "date" },
  { name: "storyPoints", label: "Story points", kind: "number" },
  { name: "estimateMinutes", label: "Estimate", kind: "number" },
  { name: "epicId", label: "Epic", kind: "text" },
  { name: "parentId", label: "Parent task", kind: "text" },
  { name: "title", label: "Title", kind: "text" },
  { name: "completedAt", label: "Completed", kind: "date" },
  { name: "archivedAt", label: "Archived", kind: "date" },
  { name: "customFieldValues", label: "Custom fields", kind: "json" },
]

/** `gte`/`lte` compare numbers server-side, so they are offered only where the
    value is one; `eq`/`neq` are meaningless on an opaque json blob. */
function opsFor(kind: ValueKind): typeof OPS {
  if (kind === "number" || kind === "priority" || kind === "date") return OPS
  if (kind === "json") return OPS.filter((entry) => entry.op === "set" || entry.op === "unset")
  return OPS.filter((entry) => entry.op !== "gte" && entry.op !== "lte")
}

const fieldDef = (fields: FieldDef[], name: string): FieldDef =>
  fields.find((entry) => entry.name === name) ?? { name, label: name, kind: "text" }

// ---------------------------------------------------------------------------
// Naming things (pure — the row summaries and the dry-run preview)

const NONE = "__none__"

function nameOf(list: Array<{ id: string; name: string }>, id: unknown): string {
  return typeof id === "string" ? (list.find((entry) => entry.id === id)?.name ?? id) : "—"
}

/** Human text for one value of a given kind, using the board's own config. */
export function describeValue(board: Board, kind: ValueKind, value: unknown): string {
  if (value === null || value === undefined) return "nothing"
  switch (kind) {
    case "column":
      return nameOf(board.columns, value)
    case "label":
      return Array.isArray(value)
        ? value.map((id) => nameOf(board.labels, id)).join(", ")
        : nameOf(board.labels, value)
    case "type":
      return nameOf(board.issueTypes, value)
    case "sprint":
    case "sprintOrNone":
      return nameOf(board.sprints, value)
    case "milestone":
    case "milestoneOrNone":
      return nameOf(board.milestones, value)
    case "priority":
      return typeof value === "number" ? (PRIORITY_NAMES[value] ?? String(value)) : String(value)
    case "date":
      return typeof value === "number" ? format(value, "d MMM yyyy") : String(value)
    case "assignees":
      return Array.isArray(value) ? value.join(", ") : String(value)
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value)
  }
}

/** "When a task moves column" / "When Priority changes" — the trigger line in
    the rule list. */
export function triggerSummary(rule: AutomationRule): string {
  if (rule.when.type === "field_changed") {
    return `When ${fieldDef(TRIGGER_FIELDS, rule.when.field).label} changes`
  }
  return `When ${(TRIGGER_TYPES.find((entry) => entry.type === rule.when.type)?.label ?? rule.when.type).toLowerCase()}`
}

/** The whole rule on one line: trigger · N conditions · what it does. */
export function ruleSummary(rule: AutomationRule, board: Board): string {
  const then = rule.then.map((action) => describeAction(action, board)).join(", ")
  const ifs = rule.if.length === 0 ? "" : ` · ${rule.if.length} condition${rule.if.length > 1 ? "s" : ""}`
  return `${triggerSummary(rule)}${ifs} → ${then}`
}

function describeAction(action: AutomationAction, board: Board): string {
  const def = ACTION_TYPES.find((entry) => entry.type === action.type)
  const label = def?.label ?? action.type
  switch (action.type) {
    case "archive":
      return label
    case "set_column":
      return `${label} ${describeValue(board, "column", action.columnId)}`
    case "set_priority":
      return `${label} ${describeValue(board, "priority", action.priority)}`
    case "set_assignees":
      return `${label} ${action.assignees.join(", ") || "nobody"}`
    case "add_label":
    case "remove_label":
      return `${label} ${describeValue(board, "label", action.labelId)}`
    case "set_sprint":
      return `${label} ${action.sprintId === null ? "Backlog" : describeValue(board, "sprint", action.sprintId)}`
    case "set_milestone":
      return `${label} ${action.milestoneId === null ? "none" : describeValue(board, "milestone", action.milestoneId)}`
    case "set_type":
      return `${label} ${describeValue(board, "type", action.typeId)}`
    case "set_due_date":
      return `${label} ${action.dueDate === null ? "cleared" : describeValue(board, "date", action.dueDate)}`
  }
}

/** The patch a dry run says would be applied, as "would set X: A → B" lines.
    `task` is the task the test ran against, so each line can show what it is
    changing FROM. */
export function describePatch(patch: AutomationPatch, board: Board, task?: Task): string[] {
  const lines: string[] = []
  const line = (label: string, kind: ValueKind, to: unknown, from: unknown) =>
    lines.push(
      `would set ${label}: ${describeValue(board, kind, from)} → ${describeValue(board, kind, to)}`
    )
  if (patch.columnId !== undefined) line("status", "column", patch.columnId, task?.columnId)
  if (patch.priority !== undefined) line("priority", "priority", patch.priority, task?.priority)
  if (patch.assignees !== undefined) line("assignees", "assignees", patch.assignees, task?.assignees)
  if (patch.labelIds !== undefined) line("labels", "label", patch.labelIds, task?.labelIds)
  if (patch.sprintId !== undefined) line("sprint", "sprint", patch.sprintId, task?.sprintId)
  if (patch.milestoneId !== undefined)
    line("milestone", "milestone", patch.milestoneId, task?.milestoneId)
  if (patch.typeId !== undefined) line("type", "type", patch.typeId, task?.typeId)
  if (patch.dueDate !== undefined) line("due date", "date", patch.dueDate, task?.dueDate)
  if (patch.archive) lines.push("would archive the task")
  return lines
}

/* AutomationPatch / AutomationTestResult — the dry run's answer, twins of
   `server/src/pm/automations.ts` — live in lib/pm/types with the rest of the
   wire shapes. Re-exported here because this dialog is where they are read. */
export type { AutomationPatch, AutomationTestResult }

// ---------------------------------------------------------------------------
// Drafts

const EMPTY_TASKS: Task[] = []

const firstId = (list: Array<{ id: string }>): string => list[0]?.id ?? ""

function blankRule(board: Board): AutomationRule {
  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: true,
    when: { type: "task_created" },
    if: [],
    then: [actionOf("set_priority", board)],
  }
}

/** A trigger of the picked type, with a sane default field. */
function triggerOf(type: AutomationTrigger["type"], previous: AutomationTrigger): AutomationTrigger {
  if (type !== "field_changed") return { type }
  return { type, field: previous.type === "field_changed" ? previous.field : "columnId" }
}

/** An action of the picked type, with a payload the server will accept. */
function actionOf(type: AutomationAction["type"], board: Board): AutomationAction {
  switch (type) {
    case "set_column":
      return { type, columnId: firstId(board.columns) }
    case "set_priority":
      return { type, priority: 2 }
    case "set_assignees":
      return { type, assignees: [] }
    case "add_label":
    case "remove_label":
      return { type, labelId: firstId(board.labels) }
    case "set_sprint":
      return { type, sprintId: null }
    case "set_milestone":
      return { type, milestoneId: null }
    case "set_type":
      return { type, typeId: firstId(board.issueTypes) }
    case "set_due_date":
      return { type, dueDate: null }
    case "archive":
      return { type }
  }
}

/** Swap an action's payload without changing its type. */
function withActionValue(action: AutomationAction, value: unknown): AutomationAction {
  switch (action.type) {
    case "set_column":
      return { ...action, columnId: String(value ?? "") }
    case "set_priority":
      return { ...action, priority: Number(value ?? 0) }
    case "set_assignees":
      return { ...action, assignees: Array.isArray(value) ? (value as string[]) : [] }
    case "add_label":
    case "remove_label":
      return { ...action, labelId: String(value ?? "") }
    case "set_sprint":
      return { ...action, sprintId: value === null || value === undefined ? null : String(value) }
    case "set_milestone":
      return { ...action, milestoneId: value === null || value === undefined ? null : String(value) }
    case "set_type":
      return { ...action, typeId: String(value ?? "") }
    case "set_due_date":
      return { ...action, dueDate: typeof value === "number" ? value : null }
    case "archive":
      return action
  }
}

function actionValue(action: AutomationAction): unknown {
  switch (action.type) {
    case "set_column":
      return action.columnId
    case "set_priority":
      return action.priority
    case "set_assignees":
      return action.assignees
    case "add_label":
    case "remove_label":
      return action.labelId
    case "set_sprint":
      return action.sprintId
    case "set_milestone":
      return action.milestoneId
    case "set_type":
      return action.typeId
    case "set_due_date":
      return action.dueDate
    case "archive":
      return undefined
  }
}

/** A rule is only worth PUTting when the server would accept it: a name, at
    least one action, and no action pointing at config that does not exist. */
function ruleProblem(rule: AutomationRule, board: Board): string | null {
  if (rule.name.trim().length === 0) return "Give the rule a name."
  if (rule.then.length === 0) return "A rule needs at least one action."
  for (const action of rule.then) {
    if (action.type === "set_column" && !board.columns.some((c) => c.id === action.columnId))
      return "Pick a column for the move action."
    if (
      (action.type === "add_label" || action.type === "remove_label") &&
      !board.labels.some((l) => l.id === action.labelId)
    )
      return "Pick a label."
    if (action.type === "set_type" && !board.issueTypes.some((t) => t.id === action.typeId))
      return "Pick an issue type."
  }
  return null
}

// ---------------------------------------------------------------------------
// The dialog

export interface AutomationDialogProps {
  board: Board
  open: boolean
  onOpenChange(open: boolean): void
  actions: Actions
  /** Open straight into editing this rule id (absent = the list). */
  ruleId?: string | null
  /** Tasks the Test picker searches; defaults to the board's cached tasks. */
  tasks?: Task[]
}

export function AutomationDialog({
  board,
  open,
  onOpenChange,
  actions,
  ruleId,
  tasks,
}: AutomationDialogProps) {
  const confirm = useConfirm()
  const { state } = useStore()
  const [draft, setDraft] = React.useState<AutomationRule | null>(null)
  const [busy, setBusy] = React.useState(false)

  const rules = board.automations ?? []
  const boardTasks = tasks ?? state.pmTasks[board.id] ?? EMPTY_TASKS

  /* Every open starts from what it was opened on — reopening on another rule
     must not carry the last one's draft. */
  React.useEffect(() => {
    if (!open) return
    setDraft(ruleId ? (rules.find((rule) => rule.id === ruleId) ?? null) : null)
    setBusy(false)
    // `rules` is board state; keying off the id is what makes reopen honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ruleId])

  const put = React.useCallback(
    async (rule: AutomationRule) => {
      await actions.putAutomation(board.id, { ...rule, name: rule.name.trim() })
    },
    [actions, board.id]
  )

  const save = async () => {
    if (draft === null || busy) return
    const problem = ruleProblem(draft, board)
    if (problem) {
      toast.error(problem)
      return
    }
    setBusy(true)
    try {
      await put(draft)
      toast.success(`${draft.name.trim()} saved`)
      setDraft(null)
    } catch (err) {
      reportError(err, "Couldn't save the automation")
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (rule: AutomationRule, enabled: boolean) => {
    setBusy(true)
    try {
      await put({ ...rule, enabled })
    } catch (err) {
      reportError(err, "Couldn't change the automation")
    } finally {
      setBusy(false)
    }
  }

  const remove = async (rule: AutomationRule) => {
    const ok = await confirm({
      title: `Delete ${rule.name || "this rule"}?`,
      description: "Tasks it already changed stay as they are.",
      confirmLabel: "Delete rule",
      destructive: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await actions.deleteAutomation(board.id, rule.id)
      toast.success("Rule deleted")
      setDraft((current) => (current?.id === rule.id ? null : current))
    } catch (err) {
      reportError(err, "Couldn't delete the automation")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Automations</DialogTitle>
          <DialogDescription>
            {draft === null
              ? `Rules ${board.name} runs on every change. When something happens, if the task looks a certain way, do something to it.`
              : "When this happens, if the task looks like this, do this."}
          </DialogDescription>
        </DialogHeader>

        {draft === null ? (
          <>
            <div className="flex max-h-[55vh] flex-col gap-1 overflow-y-auto">
              {rules.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No automations yet.
                </p>
              )}
              {rules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  board={board}
                  busy={busy}
                  onEdit={() => setDraft(rule)}
                  onToggle={(enabled) => void toggle(rule, enabled)}
                  onDelete={() => void remove(rule)}
                />
              ))}
            </div>
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="outline" onClick={() => setDraft(blankRule(board))}>
                <Plus />
                New rule
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto pr-1">
              <Input
                autoFocus
                aria-label="Rule name"
                placeholder={`Rule ${rules.length + 1}`}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />

              <TriggerSection
                board={board}
                trigger={draft.when}
                onChange={(when) => setDraft({ ...draft, when })}
              />

              <ConditionSection
                board={board}
                conditions={draft.if}
                onChange={(next) => setDraft({ ...draft, if: next })}
              />

              <ActionSection
                board={board}
                rules={draft.then}
                onChange={(next) => setDraft({ ...draft, then: next })}
              />

              <TestSection board={board} rule={draft} tasks={boardTasks} actions={actions} />
            </div>
            <DialogFooter className="sm:justify-between">
              <div className="flex items-center gap-2">
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                  aria-label="Rule enabled"
                />
                <span className="text-xs text-muted-foreground">
                  {draft.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button type="button" disabled={busy} onClick={() => void save()}>
                  Save rule
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// List row

function RuleRow({
  rule,
  board,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: AutomationRule
  board: Board
  busy: boolean
  onEdit(): void
  onToggle(enabled: boolean): void
  onDelete(): void
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 hover:bg-muted/60">
      <Zap
        aria-hidden
        className={cn("size-4 shrink-0", rule.enabled ? "text-primary" : "text-muted-foreground")}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{rule.name || "Untitled rule"}</span>
        <span className="truncate text-xs text-muted-foreground">{ruleSummary(rule, board)}</span>
      </div>
      {!rule.enabled && (
        <Badge variant="outline" className="text-muted-foreground">
          Off
        </Badge>
      )}
      <Switch
        checked={rule.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name || "rule"}`}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        title="Edit"
        aria-label={`Edit ${rule.name || "rule"}`}
        disabled={busy}
        onClick={onEdit}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Delete"
        aria-label={`Delete ${rule.name || "rule"}`}
        disabled={busy}
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WHEN

function TriggerSection({
  board,
  trigger,
  onChange,
}: {
  board: Board
  trigger: AutomationTrigger
  onChange(trigger: AutomationTrigger): void
}) {
  const type = TRIGGER_TYPES.find((entry) => entry.type === trigger.type)
  return (
    <Section title="When" hint={type?.hint}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={trigger.type}
          onValueChange={(value) =>
            onChange(triggerOf(String(value ?? "task_created") as AutomationTrigger["type"], trigger))
          }
        >
          <SelectTrigger className="min-w-48 flex-1">
            <SelectValue>{type?.label ?? trigger.type}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TRIGGER_TYPES.map((entry) => (
              <SelectItem key={entry.type} value={entry.type}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {trigger.type === "field_changed" && (
          <FieldSelect
            fields={TRIGGER_FIELDS}
            value={trigger.field}
            onChange={(field) => onChange({ type: "field_changed", field })}
          />
        )}
      </div>
      {trigger.type === "field_changed" && trigger.field === "labels" && (
        <p className="text-xs text-muted-foreground">
          Label edits are journaled under “labels” — conditions read the same thing as “Labels”
          (labelIds).
        </p>
      )}
      {board.columns.length === 0 && (
        <p className="text-xs text-muted-foreground">This board has no columns yet.</p>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// IF

function ConditionSection({
  board,
  conditions,
  onChange,
}: {
  board: Board
  conditions: AutomationCondition[]
  onChange(conditions: AutomationCondition[]): void
}) {
  const patch = (index: number, next: AutomationCondition) =>
    onChange(conditions.map((entry, i) => (i === index ? next : entry)))

  return (
    <Section title="If" hint="All conditions must hold. No conditions = always.">
      {conditions.map((condition, index) => {
        const def = fieldDef(CONDITION_FIELDS, condition.field)
        const ops = opsFor(def.kind)
        const needsValue = condition.op !== "set" && condition.op !== "unset"
        return (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <FieldSelect
              fields={CONDITION_FIELDS}
              value={condition.field}
              onChange={(field) => {
                const nextDef = fieldDef(CONDITION_FIELDS, field)
                const allowed = opsFor(nextDef.kind)
                patch(index, {
                  field,
                  op: allowed.some((entry) => entry.op === condition.op) ? condition.op : allowed[0].op,
                  value: undefined,
                })
              }}
            />
            <Select
              value={condition.op}
              onValueChange={(value) =>
                patch(index, { ...condition, op: String(value ?? "eq") as AutomationCondition["op"] })
              }
            >
              <SelectTrigger className="w-32">
                <SelectValue>{OPS.find((entry) => entry.op === condition.op)?.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ops.map((entry) => (
                  <SelectItem key={entry.op} value={entry.op}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {needsValue && (
              <ValueControl
                board={board}
                kind={condition.op === "gte" || condition.op === "lte" ? numericKind(def.kind) : def.kind}
                value={condition.value}
                onChange={(value) => patch(index, { ...condition, value })}
              />
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              title="Remove condition"
              aria-label="Remove condition"
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        )
      })}
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        onClick={() =>
          onChange([...conditions, { field: CONDITION_FIELDS[0].name, op: "eq", value: undefined }])
        }
      >
        <Plus />
        Add condition
      </Button>
    </Section>
  )
}

/** `gte`/`lte` always compare raw numbers server-side, so a priority or a date
    under those operators takes its own control, not a picker. */
const numericKind = (kind: ValueKind): ValueKind => (kind === "date" ? "date" : kind === "priority" ? "priority" : "number")

// ---------------------------------------------------------------------------
// THEN

function ActionSection({
  board,
  rules,
  onChange,
}: {
  board: Board
  rules: AutomationAction[]
  onChange(actions: AutomationAction[]): void
}) {
  const patch = (index: number, next: AutomationAction) =>
    onChange(rules.map((entry, i) => (i === index ? next : entry)))

  return (
    <Section title="Then" hint="Each action re-runs the board's rules once, up to four deep.">
      {rules.map((action, index) => {
        const def = ACTION_TYPES.find((entry) => entry.type === action.type)
        return (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Select
              value={action.type}
              onValueChange={(value) =>
                patch(index, actionOf(String(value ?? "archive") as AutomationAction["type"], board))
              }
            >
              <SelectTrigger className="min-w-44 flex-1">
                <SelectValue>{def?.label ?? action.type}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ACTION_TYPES.map((entry) => (
                  <SelectItem key={entry.type} value={entry.type}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {def && def.arg !== "none" && (
              <ValueControl
                board={board}
                kind={def.arg}
                value={actionValue(action)}
                onChange={(value) => patch(index, withActionValue(action, value))}
              />
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              title="Remove action"
              aria-label="Remove action"
              disabled={rules.length === 1}
              onClick={() => onChange(rules.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        )
      })}
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        onClick={() => onChange([...rules, actionOf("set_priority", board)])}
      >
        <Plus />
        Add action
      </Button>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Test — the dry run

function TestSection({
  board,
  rule,
  tasks,
  actions,
}: {
  board: Board
  rule: AutomationRule
  tasks: Task[]
  actions: Actions
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [target, setTarget] = React.useState<Task | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<AutomationTestResult | null>(null)

  /* Matching here, not in cmdk, so the list can be sliced — the same shape
     dependency-picker uses on a 5k-task board. */
  const candidates = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const shown: Task[] = []
    let matched = 0
    for (const task of tasks) {
      if (task.deletedAt !== null) continue
      if (needle && !`${task.key} ${task.title}`.toLowerCase().includes(needle)) continue
      matched += 1
      if (shown.length < 50) shown.push(task)
    }
    return { shown, matched }
  }, [tasks, query])

  const run = async (task: Task) => {
    setBusy(true)
    setResult(null)
    try {
      const answer = await actions.testAutomation(
        board.id,
        {
          id: rule.id,
          name: rule.name.trim() || "Untitled rule",
          // A disabled rule never matches; the dry run is about the shape,
          // so it is tested as if it were on.
          enabled: true,
          when: rule.when,
          if: rule.if,
          then: rule.then,
        },
        task.id
      )
      setResult(answer)
    } catch (err) {
      reportError(err, "Couldn't test the rule")
    } finally {
      setBusy(false)
    }
  }

  const lines = result?.effects.flatMap((effect) => describePatch(effect.patch, board, target ?? undefined)) ?? []

  return (
    <Section title="Test" hint="A dry run against one task. Nothing is applied.">
      <div className="flex flex-wrap items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button variant="outline" size="sm" className="min-w-48 justify-start font-normal">
                <FlaskConical />
                <span className="truncate">
                  {target ? `${target.key} · ${target.title}` : "Pick a task"}
                </span>
              </Button>
            }
          />
          <PopoverContent align="start" className="w-[22rem] gap-0 p-0">
            <Command shouldFilter={false} className="bg-transparent">
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder="Search tasks by key or title…"
              />
              <CommandList className="max-h-64">
                <CommandEmpty>
                  {tasks.length === 0 ? "No tasks on this board yet." : "No task matches."}
                </CommandEmpty>
                <CommandGroup heading="Test against">
                  {candidates.shown.map((task) => (
                    <CommandItem
                      key={task.id}
                      value={task.id}
                      onSelect={() => {
                        setTarget(task)
                        setOpen(false)
                        setResult(null)
                      }}
                      className="gap-2"
                    >
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {task.key}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{task.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                {candidates.matched > candidates.shown.length && (
                  <p className="px-3 pb-2 text-[11px] text-muted-foreground">
                    {candidates.matched - candidates.shown.length} more — keep typing to narrow.
                  </p>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || target === null}
          onClick={() => target && void run(target)}
        >
          Run test
        </Button>
      </div>

      {result && (
        <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
          <p className="font-medium">
            {result.matched ? "The rule would fire." : "The rule would not fire."}
          </p>
          {result.matched && lines.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing would change — the task already looks the way the actions want it.
            </p>
          )}
          {lines.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {lines.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Generic controls

function FieldSelect({
  fields,
  value,
  onChange,
}: {
  fields: FieldDef[]
  value: string
  onChange(field: string): void
}) {
  const def = fieldDef(fields, value)
  return (
    <Select value={value} onValueChange={(next) => onChange(String(next ?? value))}>
      <SelectTrigger className="min-w-40">
        <SelectValue>{def.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {fields.map((entry) => (
          <SelectItem key={entry.name} value={entry.name}>
            {entry.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * The one control every value in the builder goes through. It dispatches on
 * the value's *kind*, and every option list it offers comes out of the board —
 * so a new column, label, type, sprint or milestone appears here with no code
 * change.
 */
function ValueControl({
  board,
  kind,
  value,
  onChange,
}: {
  board: Board
  kind: ValueKind
  value: unknown
  onChange(value: unknown): void
}) {
  switch (kind) {
    case "column":
      return (
        <IdSelect
          options={board.columns}
          value={value}
          placeholder="Column"
          onChange={onChange}
        />
      )
    case "label":
      return (
        <IdSelect
          options={board.labels}
          value={Array.isArray(value) ? value[0] : value}
          placeholder="Label"
          onChange={onChange}
        />
      )
    case "type":
      return (
        <IdSelect options={board.issueTypes} value={value} placeholder="Type" onChange={onChange} />
      )
    case "sprint":
    case "sprintOrNone":
      return (
        <IdSelect
          options={board.sprints}
          value={value}
          placeholder="Sprint"
          noneLabel={kind === "sprintOrNone" ? "Backlog (no sprint)" : undefined}
          onChange={onChange}
        />
      )
    case "milestone":
    case "milestoneOrNone":
      return (
        <IdSelect
          options={board.milestones}
          value={value}
          placeholder="Milestone"
          noneLabel={kind === "milestoneOrNone" ? "No milestone" : undefined}
          onChange={onChange}
        />
      )
    case "columnCategory":
      return (
        <IdSelect
          options={[
            { id: "open", name: "Open" },
            { id: "active", name: "Active" },
            { id: "done", name: "Done" },
          ]}
          value={value}
          placeholder="Category"
          onChange={onChange}
        />
      )
    case "priority":
      return (
        <Select
          value={String(typeof value === "number" ? value : 0)}
          onValueChange={(next) => onChange(Number(next ?? 0))}
        >
          <SelectTrigger className="w-36">
            <SelectValue>{PRIORITY_NAMES[typeof value === "number" ? value : 0]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PRIORITY_NAMES.map((name, index) => (
              <SelectItem key={name} value={String(index)}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case "assignees":
      return (
        <Input
          className="w-52"
          aria-label="Assignees"
          placeholder="Names, comma separated"
          value={Array.isArray(value) ? (value as string[]).join(", ") : ""}
          onChange={(event) =>
            onChange(
              event.target.value
                .split(",")
                .map((name) => name.trim())
                .filter((name) => name.length > 0)
            )
          }
        />
      )
    case "date":
      return <DateValue value={typeof value === "number" ? value : null} onChange={onChange} />
    case "number":
      return (
        <Input
          type="number"
          className="w-28"
          aria-label="Value"
          value={typeof value === "number" ? String(value) : ""}
          onChange={(event) =>
            onChange(event.target.value === "" ? undefined : Number(event.target.value))
          }
        />
      )
    case "none":
    case "json":
      return null
    case "text":
      return (
        <Input
          className="w-52"
          aria-label="Value"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      )
  }
}

/** A picker over anything the board keeps as `{ id, name }`. `noneLabel` adds
    the explicit null the nullable actions (sprint, milestone) accept. */
function IdSelect({
  options,
  value,
  placeholder,
  noneLabel,
  onChange,
}: {
  options: Array<{ id: string; name: string }>
  value: unknown
  placeholder: string
  noneLabel?: string
  onChange(value: string | null): void
}) {
  const current = typeof value === "string" ? value : null
  const label = current === null ? (noneLabel ?? placeholder) : nameOf(options, current)
  return (
    <Select
      value={current ?? NONE}
      onValueChange={(next) => {
        const picked = String(next ?? NONE)
        onChange(picked === NONE ? null : picked)
      }}
    >
      <SelectTrigger className="min-w-40">
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
        {options.length === 0 && !noneLabel && (
          <SelectItem value={NONE} disabled>
            Nothing configured
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  )
}

/** The date idiom the PM dialogs already use: a Popover over the shared
    Calendar with a ✕ back to null (the nullable `set_due_date` payload). */
function DateValue({
  value,
  onChange,
}: {
  value: number | null
  onChange(value: number | null): void
}) {
  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              className={cn("min-w-40 justify-start font-normal", value === null && "text-muted-foreground")}
            >
              <CalendarIcon />
              <span className="truncate">
                {value === null ? "No date" : format(new Date(value), "EEE d MMM yyyy")}
              </span>
            </Button>
          }
        />
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            autoFocus
            selected={value === null ? undefined : new Date(value)}
            onSelect={(date) => onChange(date ? date.getTime() : null)}
          />
        </PopoverContent>
      </Popover>
      {value !== null && (
        <Button variant="ghost" size="icon-sm" aria-label="Clear date" onClick={() => onChange(null)}>
          <X />
        </Button>
      )}
    </div>
  )
}

/** The builder's labelled block — the same plain label/hint row the other PM
    dialogs use, one step wider because a row of controls sits under it. */
function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase">{title}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
