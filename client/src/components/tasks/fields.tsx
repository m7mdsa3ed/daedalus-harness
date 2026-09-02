/* The atoms every task view draws with, and the pickers that edit them.
   One place for "what does a priority look like" and "how do you choose a
   status", so the card, the row, the table cell, the detail panel and the
   bulk bar all agree — a new field is one addition here. */
import * as React from "react"
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bug,
  CalendarIcon,
  Check,
  ChevronsDown,
  ChevronsUp,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Layers,
  Minus,
  Plus,
  SquareCheck,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  COLOR_DOT,
  COLOR_TINT,
  type BoardStatus,
  type Sprint,
  type StatusCategory,
} from "@/lib/boards"
import {
  PRIORITY_LABEL,
  TASK_PRIORITIES,
  TASK_TYPES,
  TYPE_LABEL,
  taskKey,
  type Task,
  type TaskPriority,
  type TaskType,
} from "@/lib/tasks-board"
import { dueLabel, hueOf, initialsOf, isOverdue } from "@/lib/tasks-view"

// ---- atoms ----

const TYPE_ICON: Record<TaskType, React.ComponentType<{ className?: string }>> = {
  task: SquareCheck,
  bug: Bug,
  story: BookOpen,
  epic: Layers,
}

const TYPE_COLOR: Record<TaskType, string> = {
  task: "text-blue-500",
  bug: "text-rose-500",
  story: "text-emerald-500",
  epic: "text-violet-500",
}

export function TypeIcon({ type, className }: { type: TaskType; className?: string }) {
  const Icon = TYPE_ICON[type]
  return <Icon className={cn("size-3.5 shrink-0", TYPE_COLOR[type], className)} aria-label={TYPE_LABEL[type]} />
}

const PRIORITY_ICON: Record<TaskPriority, React.ComponentType<{ className?: string }>> = {
  urgent: ChevronsUp,
  high: ArrowUp,
  medium: Minus,
  low: ArrowDown,
  lowest: ChevronsDown,
}

const PRIORITY_COLOR: Record<TaskPriority, string> = {
  urgent: "text-red-500",
  high: "text-orange-500",
  medium: "text-amber-500",
  low: "text-sky-500",
  lowest: "text-slate-400",
}

export function PriorityIcon({ priority, className }: { priority: TaskPriority; className?: string }) {
  const Icon = PRIORITY_ICON[priority]
  return (
    <Icon
      className={cn("size-3.5 shrink-0", PRIORITY_COLOR[priority], className)}
      aria-label={`Priority: ${PRIORITY_LABEL[priority]}`}
    />
  )
}

const CATEGORY_ICON: Record<StatusCategory, React.ComponentType<{ className?: string }>> = {
  todo: CircleDashed,
  in_progress: CircleDot,
  done: CircleCheck,
}

export function StatusPill({
  status,
  className,
  compact,
}: {
  status: BoardStatus | undefined
  className?: string
  compact?: boolean
}) {
  if (!status) return <span className={cn("text-xs text-muted-foreground", className)}>—</span>
  const Icon = CATEGORY_ICON[status.category]
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-pill px-1.5 py-0.5 text-[11px] font-medium leading-4",
        status.color ? COLOR_TINT[status.color] : "bg-muted text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3 shrink-0" />
      {!compact && <span className="truncate">{status.name}</span>}
    </span>
  )
}

export function KeyBadge({ task, boardKey, className }: { task: Task; boardKey: string; className?: string }) {
  return (
    <span className={cn("font-mono text-[11px] tabular-nums text-muted-foreground", className)}>
      {taskKey(task, boardKey)}
    </span>
  )
}

export function AssigneeAvatar({
  name,
  size = "sm",
  className,
}: {
  name: string | null
  size?: "xs" | "sm" | "md"
  className?: string
}) {
  const dim = size === "xs" ? "size-4 text-[9px]" : size === "md" ? "size-7 text-xs" : "size-5 text-[10px]"
  if (!name) {
    return (
      <span
        className={cn("grid shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground", dim, className)}
        title="Unassigned"
      >
        ?
      </span>
    )
  }
  const hue = hueOf(name)
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-full font-semibold text-white", dim, className)}
      style={{ background: `hsl(${hue} 55% 45%)` }}
      title={name}
    >
      {initialsOf(name)}
    </span>
  )
}

export function LabelChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  const hue = hueOf(label)
  return (
    <span
      className="inline-flex max-w-full items-center gap-0.5 rounded-pill px-1.5 py-0.5 text-[10px] font-medium leading-4"
      style={{ background: `hsl(${hue} 60% 50% / 0.14)`, color: `hsl(${hue} 55% 38%)` }}
    >
      <span className="truncate">{label}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="-mr-0.5 rounded-full hover:bg-black/10">
          <X className="size-2.5" />
        </button>
      )}
    </span>
  )
}

export function DueChip({ task, className }: { task: Task; className?: string }) {
  if (task.dueAt == null) return null
  const overdue = isOverdue(task)
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] tabular-nums",
        overdue ? "font-medium text-destructive" : "text-muted-foreground",
        task.completedAt != null && "line-through opacity-70",
        className,
      )}
      title={new Date(task.dueAt).toLocaleString()}
    >
      <CalendarIcon className="size-3" />
      {dueLabel(task.dueAt)}
    </span>
  )
}

export function ProgressBar({ done, total, className }: { done: number; total: number; className?: string }) {
  if (total === 0) return null
  const pct = Math.round((done / total) * 100)
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground", className)} title={`${done}/${total} done`}>
      <span className="h-1 w-10 overflow-hidden rounded-pill bg-muted">
        <span className="block h-full rounded-pill bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </span>
      {done}/{total}
    </span>
  )
}

export function EstimateBadge({ estimate }: { estimate: number | null }) {
  if (estimate == null) return null
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-pill bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground" title={`${estimate} points`}>
      {estimate}
    </span>
  )
}

// ---- pickers ----
/* Every picker is a Popover over a list, the same shape: a trigger that shows
   the current value, and a menu of options that commits on click. `render`
   lets the caller decide what the trigger looks like (a pill in a table cell,
   a labelled row in the detail panel). */

const MENU = "z-50 w-56 gap-0 rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-md"
const ROW =
  "flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"

function PickerShell({
  trigger,
  children,
  open,
  onOpenChange,
  className,
  align = "start",
}: {
  trigger: React.ReactElement
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  align?: "start" | "end" | "center"
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align={align} className={cn(MENU, className)}>
        {children}
      </PopoverContent>
    </Popover>
  )
}

function OptionRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button type="button" onClick={onClick} className={ROW} role="menuitemradio" aria-checked={selected}>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {selected && <Check className="size-3.5 shrink-0 text-primary" />}
    </button>
  )
}

export function StatusPicker({
  value,
  statuses,
  onChange,
  trigger,
}: {
  value: string
  statuses: BoardStatus[]
  onChange: (statusId: string) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <PickerShell trigger={trigger} open={open} onOpenChange={setOpen}>
      {statuses.map((s) => (
        <OptionRow
          key={s.id}
          selected={s.id === value}
          onClick={() => {
            onChange(s.id)
            setOpen(false)
          }}
        >
          <span className={cn("size-2 shrink-0 rounded-full", s.color ? COLOR_DOT[s.color] : "bg-muted-foreground/40")} />
          <span className="truncate">{s.name}</span>
        </OptionRow>
      ))}
    </PickerShell>
  )
}

export function PriorityPicker({
  value,
  onChange,
  trigger,
}: {
  value: TaskPriority
  onChange: (priority: TaskPriority) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <PickerShell trigger={trigger} open={open} onOpenChange={setOpen} className="w-44">
      {[...TASK_PRIORITIES].reverse().map((p) => (
        <OptionRow
          key={p}
          selected={p === value}
          onClick={() => {
            onChange(p)
            setOpen(false)
          }}
        >
          <PriorityIcon priority={p} />
          {PRIORITY_LABEL[p]}
        </OptionRow>
      ))}
    </PickerShell>
  )
}

export function TypePicker({
  value,
  onChange,
  trigger,
}: {
  value: TaskType
  onChange: (type: TaskType) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <PickerShell trigger={trigger} open={open} onOpenChange={setOpen} className="w-44">
      {TASK_TYPES.map((t) => (
        <OptionRow
          key={t}
          selected={t === value}
          onClick={() => {
            onChange(t)
            setOpen(false)
          }}
        >
          <TypeIcon type={t} />
          {TYPE_LABEL[t]}
        </OptionRow>
      ))}
    </PickerShell>
  )
}

/** Free text with suggestions from the board — there is no user directory, so
    "who" is whatever has been typed before. */
export function AssigneePicker({
  value,
  suggestions,
  onChange,
  trigger,
}: {
  value: string | null
  suggestions: string[]
  onChange: (assignee: string | null) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  React.useEffect(() => {
    if (open) setText("")
  }, [open])
  const commit = (name: string | null) => {
    onChange(name && name.trim() ? name.trim() : null)
    setOpen(false)
  }
  const options = suggestions.filter((s) => s.toLowerCase().includes(text.trim().toLowerCase()))
  const exact = options.some((s) => s.toLowerCase() === text.trim().toLowerCase())
  return (
    <PickerShell trigger={trigger} open={open} onOpenChange={setOpen}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          commit(text)
        }}
        className="p-1"
      >
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a name…" className="h-8" />
      </form>
      <div className="max-h-56 overflow-y-auto">
        {text.trim() && !exact && (
          <button type="button" onClick={() => commit(text)} className={ROW}>
            <Plus className="size-3.5" /> Assign to “{text.trim()}”
          </button>
        )}
        {options.map((name) => (
          <OptionRow key={name} selected={name === value} onClick={() => commit(name)}>
            <AssigneeAvatar name={name} size="xs" />
            <span className="truncate">{name}</span>
          </OptionRow>
        ))}
        {value && (
          <button type="button" onClick={() => commit(null)} className={cn(ROW, "text-muted-foreground")}>
            <X className="size-3.5" /> Unassign
          </button>
        )}
      </div>
    </PickerShell>
  )
}

/** Multi-select over the board's labels, with a way to type a new one. */
export function LabelsPicker({
  value,
  suggestions,
  onChange,
  trigger,
}: {
  value: string[]
  suggestions: string[]
  onChange: (labels: string[]) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  React.useEffect(() => {
    if (open) setText("")
  }, [open])
  const toggle = (label: string) =>
    onChange(value.includes(label) ? value.filter((l) => l !== label) : [...value, label])
  const all = Array.from(new Set([...suggestions, ...value])).sort((a, b) => a.localeCompare(b))
  const q = text.trim().toLowerCase()
  const options = all.filter((l) => l.toLowerCase().includes(q))
  const canAdd = q && !all.some((l) => l.toLowerCase() === q)
  return (
    <PickerShell trigger={trigger} open={open} onOpenChange={setOpen}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (canAdd) {
            toggle(text.trim())
            setText("")
          }
        }}
        className="p-1"
      >
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Find or add a label…" className="h-8" />
      </form>
      <div className="max-h-56 overflow-y-auto">
        {canAdd && (
          <button
            type="button"
            onClick={() => {
              toggle(text.trim())
              setText("")
            }}
            className={ROW}
          >
            <Plus className="size-3.5" /> Add “{text.trim()}”
          </button>
        )}
        {options.map((label) => (
          <button key={label} type="button" onClick={() => toggle(label)} className={ROW} role="menuitemcheckbox" aria-checked={value.includes(label)}>
            <span className={cn("grid size-3.5 shrink-0 place-items-center rounded border", value.includes(label) && "border-primary bg-primary text-primary-foreground")}>
              {value.includes(label) && <Check className="size-2.5" />}
            </span>
            <LabelChip label={label} />
          </button>
        ))}
        {options.length === 0 && !canAdd && <p className="px-2 py-2 text-xs text-muted-foreground">No labels yet.</p>}
      </div>
    </PickerShell>
  )
}

export function SprintPicker({
  value,
  sprints,
  onChange,
  trigger,
}: {
  value: string | null
  sprints: Sprint[]
  onChange: (sprintId: string | null) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const pick = (id: string | null) => {
    onChange(id)
    setOpen(false)
  }
  const openSprints = sprints.filter((s) => s.state !== "closed")
  return (
    <PickerShell trigger={trigger} open={open} onOpenChange={setOpen}>
      <OptionRow selected={value === null} onClick={() => pick(null)}>
        Backlog
      </OptionRow>
      {openSprints.map((s) => (
        <OptionRow key={s.id} selected={s.id === value} onClick={() => pick(s.id)}>
          <span className="truncate">{s.name}</span>
          {s.state === "active" && <span className="rounded-pill bg-emerald-500/15 px-1.5 text-[10px] text-emerald-600">Active</span>}
        </OptionRow>
      ))}
      {openSprints.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No open sprints — create one in Sprints.</p>}
    </PickerShell>
  )
}

/** A parent for a task: epics first, then any other task on the board, searched
    by key or title. `exclude` is the task itself and its descendants. */
export function ParentPicker({
  value,
  candidates,
  boardKey,
  exclude,
  onChange,
  trigger,
}: {
  value: string | null
  candidates: Task[]
  boardKey: string
  exclude: Set<string>
  onChange: (parentId: string | null) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  React.useEffect(() => {
    if (open) setText("")
  }, [open])
  const q = text.trim().toLowerCase()
  const options = candidates
    .filter((t) => !exclude.has(t.id) && !t.archived)
    .filter((t) => !q || t.title.toLowerCase().includes(q) || taskKey(t, boardKey).toLowerCase().includes(q))
    .sort((a, b) => (a.type === "epic" ? 0 : 1) - (b.type === "epic" ? 0 : 1) || (a.number ?? 0) - (b.number ?? 0))
    .slice(0, 40)
  const pick = (id: string | null) => {
    onChange(id)
    setOpen(false)
  }
  return (
    <PickerShell trigger={trigger} open={open} onOpenChange={setOpen} className="w-72">
      <div className="p-1">
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by key or title…" className="h-8" />
      </div>
      <div className="max-h-64 overflow-y-auto">
        <OptionRow selected={value === null} onClick={() => pick(null)}>
          <span className="text-muted-foreground">No parent</span>
        </OptionRow>
        {options.map((t) => (
          <OptionRow key={t.id} selected={t.id === value} onClick={() => pick(t.id)}>
            <TypeIcon type={t.type} />
            <KeyBadge task={t} boardKey={boardKey} />
            <span className="truncate">{t.title}</span>
          </OptionRow>
        ))}
      </div>
    </PickerShell>
  )
}

/** "YYYY-MM-DD" ↔ epoch ms at noon local (midnight floats across TZ when rendered). */
export function fromDateInput(value: string | undefined): number | null {
  if (!value) return null
  const d = new Date(`${value}T12:00:00`)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

export function toDateInput(ms: number | null | undefined): string {
  if (ms == null) return ""
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function DatePicker({
  value,
  onChange,
  trigger,
}: {
  value: number | null
  onChange: (ms: number | null) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <PickerShell trigger={trigger} open={open} onOpenChange={setOpen} className="w-auto p-0">
      <Calendar
        mode="single"
        selected={value != null ? new Date(value) : undefined}
        defaultMonth={value != null ? new Date(value) : undefined}
        onSelect={(day) => {
          if (!day) return
          const at = new Date(day)
          at.setHours(12, 0, 0, 0)
          onChange(at.getTime())
          setOpen(false)
        }}
      />
      {value != null && (
        <div className="border-t p-1">
          <button
            type="button"
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
            className={cn(ROW, "text-muted-foreground")}
          >
            <X className="size-3.5" /> Clear date
          </button>
        </div>
      )}
    </PickerShell>
  )
}

/** A number with a clear — used for the estimate. */
export function NumberPicker({
  value,
  onChange,
  trigger,
  placeholder = "Points",
}: {
  value: number | null
  onChange: (n: number | null) => void
  trigger: React.ReactElement
  placeholder?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  React.useEffect(() => {
    if (open) setText(value == null ? "" : String(value))
  }, [open, value])
  const commit = () => {
    const n = text.trim() === "" ? null : Number(text)
    onChange(n == null || Number.isNaN(n) ? null : Math.max(0, Math.round(n)))
    setOpen(false)
  }
  return (
    <PickerShell trigger={trigger} open={open} onOpenChange={setOpen} className="w-44">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          commit()
        }}
        className="flex items-center gap-1 p-1"
      >
        <Input autoFocus inputMode="numeric" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="h-8" />
        <button type="submit" className="grid size-8 shrink-0 place-items-center rounded-lg hover:bg-accent" aria-label="Set">
          <Check className="size-3.5" />
        </button>
      </form>
      <div className="flex flex-wrap gap-1 px-1 pb-1">
        {[1, 2, 3, 5, 8, 13].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => {
              onChange(n)
              setOpen(false)
            }}
            className={cn("rounded-pill border px-2 py-0.5 text-xs tabular-nums hover:bg-accent", value === n && "border-primary bg-primary/10")}
          >
            {n}
          </button>
        ))}
      </div>
    </PickerShell>
  )
}

/** The look of a picker's trigger when it sits in a property list or a table
    cell: a quiet chip that reveals it is editable on hover. */
export const CHIP =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg px-1.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
