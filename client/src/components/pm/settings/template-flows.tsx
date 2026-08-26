import * as React from "react"
import { useNavigate } from "react-router"
import { Copy, LayoutTemplate, Plus, Save, X } from "lucide-react"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { BoardDot, usePmActions } from "@/components/pm/pm-sidebar-panels"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Board, BoardSummary, Task, TaskCreateInput } from "@/lib/pm/types"
import {
  removeTaskTemplate,
  sanitizeTemplateInput,
  saveTaskTemplate,
  templateFromTask,
  useTaskTemplates,
  type TaskTemplate,
} from "@/lib/pm/task-templates"
import { boardPath } from "@/lib/router"
import { cn } from "@/lib/utils"

/* ── Templates ──
   Two different things share the word, and they are stored in two different
   places on purpose.

   A **board template** is server-side: `POST /api/boards/:id/duplicate` with
   `{ asTemplate: true }` clones the whole configuration — columns, labels,
   issue types, custom fields, sprints, milestones, saved views and automation
   rules, every id remapped — and stamps `templateFor`. Templates are a shelf
   of their own (`GET /api/boards?templates=1`), never the live list, and never
   reserve a key prefix. Instantiating one is the same endpoint run back the
   other way: `{ asTemplate: false, withTasks: true }`, which is what makes the
   starter tasks a template carries actually arrive.

   A **task template** is device-local (lib/pm/task-templates) — there is no
   server table for one, and a private habit should not appear on everyone
   else's board. See that module for what a saved payload does and does not
   keep.

   Both live here because they are the same gesture from the user's side: save
   this shape, start from that shape. */

// ---------------------------------------------------------------------------
// Board templates — the two endpoint flows, callable without the dialog

/** Save a board's configuration as a reusable template. Resolves to the new
    template board, or undefined when the call failed (already reported). */
export async function saveBoardAsTemplate(
  actions: Actions,
  board: Pick<BoardSummary, "id" | "name">,
  opts: { withTasks?: boolean } = {}
): Promise<Board | undefined> {
  try {
    const template = await actions.duplicateBoard(board.id, {
      asTemplate: true,
      withTasks: opts.withTasks === true,
    })
    toast.success(`${board.name} saved as a template`)
    return template
  } catch (err) {
    reportError(err, "Couldn't save the board as a template")
    return undefined
  }
}

/** Start a real board from a template: the same duplicate, minus the template
    stamp, with the template's tasks carried over. */
export async function instantiateTemplate(
  actions: Actions,
  template: Pick<BoardSummary, "id" | "name">
): Promise<Board | undefined> {
  try {
    const board = await actions.duplicateBoard(template.id, {
      asTemplate: false,
      withTasks: true,
    })
    /* The new board belongs on the live shelf, which is the store's `boards`
       list — the duplicate call only upserted it. */
    await actions.refreshBoards().catch(() => {})
    toast.success(`${board.name} created from ${template.name}`)
    return board
  } catch (err) {
    reportError(err, "Couldn't create the board from the template")
    return undefined
  }
}

export interface BoardTemplateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The board offering "Save as template"; omit for the pick-a-template half
      alone (the /tasks hub, which is not on a board). */
  board?: Pick<BoardSummary, "id" | "name"> | null
  actions?: Actions
  /** Called with the board a template was instantiated into; the default is to
      navigate to it. */
  onCreated?: (board: Board) => void
  onSavedAsTemplate?: (template: Board) => void
}

/**
 * The board-template dialog: the templates shelf as a pickable list, plus the
 * "save this board" button when the caller is on one. The list is fetched on
 * open — templates are not in the store (the sidebar and the hub fetch the
 * same shelf the same way) and a stale one would offer a deleted template.
 */
export function BoardTemplateDialog({
  open,
  onOpenChange,
  board,
  actions: passed,
  onCreated,
  onSavedAsTemplate,
}: BoardTemplateDialogProps) {
  const own = usePmActions()
  const actions = passed ?? own
  const navigate = useNavigate()
  const [templates, setTemplates] = React.useState<BoardSummary[] | null>(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(() => {
    setTemplates(null)
    actions
      .refreshBoards({ templates: true })
      .then(setTemplates)
      .catch((err) => {
        setTemplates([])
        reportError(err, "Couldn't load the templates")
      })
  }, [actions])

  /* Every open refetches: a template saved in another tab should be here, and
     one deleted there should not. */
  React.useEffect(() => {
    if (!open) return
    setBusy(false)
    load()
  }, [open, load])

  const create = async (template: BoardSummary) => {
    if (busy) return
    setBusy(true)
    const created = await instantiateTemplate(actions, template)
    setBusy(false)
    if (!created) return
    onOpenChange(false)
    if (onCreated) onCreated(created)
    else void navigate(boardPath(created.id))
  }

  const save = async () => {
    if (!board || busy) return
    setBusy(true)
    const template = await saveBoardAsTemplate(actions, board)
    setBusy(false)
    if (!template) return
    onSavedAsTemplate?.(template)
    load()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Board templates</DialogTitle>
          <DialogDescription>
            A template holds a board's columns, labels, types, custom fields, sprints,
            milestones, saved views and automations. Starting a board from one copies all of
            it, plus the template's tasks.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {templates === null && (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              Loading templates…
            </p>
          )}
          {templates?.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No templates yet. Save a board as a template and it appears here.
            </p>
          )}
          {templates?.map((template) => (
            <div
              key={template.id}
              className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 hover:bg-muted/60"
            >
              <BoardDot color={template.color} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{template.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {template.description || "No description."}
                </span>
              </div>
              <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
                {template.keyPrefix}
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void create(template)}
              >
                <Plus />
                Use
              </Button>
            </div>
          ))}
        </div>

        <DialogFooter className="sm:justify-between">
          {board ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void save()}>
              <Copy />
              Save {board.name} as a template
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The plain button pm-page/pm-overview can drop in a menu or a header — the
    dialog and its state in one export, so a caller needs no `useState`. */
export function BoardTemplateButton({
  board,
  actions,
  label = "Templates",
  variant = "outline",
  size,
  className,
}: {
  board?: Pick<BoardSummary, "id" | "name"> | null
  actions?: Actions
  label?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
      >
        <LayoutTemplate />
        {label}
      </Button>
      <BoardTemplateDialog
        open={open}
        onOpenChange={setOpen}
        board={board}
        actions={actions}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Task templates (device-local — lib/pm/task-templates)

export interface TaskTemplatePickerProps {
  board: Board
  /** The chosen payload, already trimmed against the board's current ids —
      the caller merges it into its draft. */
  onPick: (input: Partial<TaskCreateInput>, template: TaskTemplate) => void
  /** Hide the per-template delete ✕ (a read-only surface). */
  removable?: boolean
  className?: string
}

/**
 * The row of saved shapes above a quick-create form. Renders nothing when the
 * board has no templates — an empty picker is a row of chrome explaining that
 * a feature exists, which the new-task dialog does not have room for.
 */
export function TaskTemplatePicker({
  board,
  onPick,
  removable = true,
  className,
}: TaskTemplatePickerProps) {
  const templates = useTaskTemplates(board.id)
  if (templates.length === 0) return null

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">Start from a template</span>
      <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
        {templates.map((template) => (
          <Badge
            key={template.id}
            variant="outline"
            className="gap-1 border-border bg-muted pr-1 text-muted-foreground"
          >
            <button
              type="button"
              className="max-w-40 truncate hover:text-foreground"
              title={`Use ${template.name}`}
              onClick={() => onPick(sanitizeTemplateInput(board, template.input), template)}
            >
              {template.name}
            </button>
            {removable && (
              <button
                type="button"
                className="rounded-sm p-0.5 hover:text-foreground"
                aria-label={`Delete template ${template.name}`}
                title="Delete template"
                onClick={() => {
                  removeTaskTemplate(board.id, template.id)
                  toast.success(`${template.name} deleted`)
                }}
              >
                <X className="size-3" />
              </button>
            )}
          </Badge>
        ))}
      </div>
    </div>
  )
}

export interface SaveTaskAsTemplateProps {
  board: Pick<Board, "id">
  task: Task
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  label?: string
  className?: string
  onSaved?: (template: TaskTemplate) => void
}

/**
 * "Save as template" on an existing task: a small dialog for the name (it
 * defaults to the task's title, and reusing a name updates that template
 * rather than filing a second identical one).
 */
export function SaveTaskAsTemplateButton({
  board,
  task,
  variant = "ghost",
  size = "sm",
  label = "Save as template",
  className,
  onSaved,
}: SaveTaskAsTemplateProps) {
  const confirm = useConfirm()
  const templates = useTaskTemplates(board.id)
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState(task.title)

  React.useEffect(() => {
    if (open) setName(task.title)
  }, [open, task.title])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const clash = templates.find((t) => t.name.toLowerCase() === trimmed.toLowerCase())
    if (clash) {
      const ok = await confirm({
        title: `Replace ${clash.name}?`,
        description: "A template of that name already exists on this board.",
        confirmLabel: "Replace template",
      })
      if (!ok) return
    }
    const saved = saveTaskTemplate(board.id, trimmed, templateFromTask(task))
    toast.success(`${saved.name} saved as a task template`)
    setOpen(false)
    onSaved?.(saved)
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
      >
        <Save />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Save as a task template</DialogTitle>
              <DialogDescription>
                Keeps this task's description, column, type, priority, assignees, labels,
                estimates, checklists (unticked) and custom-field values. Dates are not kept —
                they belong to the task, not the shape. The template stays on this device.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              required
              aria-label="Template name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Template name"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={name.trim().length === 0}>
                Save template
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
