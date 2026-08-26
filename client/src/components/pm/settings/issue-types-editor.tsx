/* ── Issue types ──
   Epic / Story / Task / Bug — extensible, because "everything possible" means
   a board gets to name its own kinds. Two fields carry weight:

     · `isEpic` is not decoration. Epics ARE tasks: a task whose type is an
       epic type collects children through `epicId` and gets a roll-up in the
       editor. Turning it on is what makes that happen.
     · deleting a type is SET NULL on the tasks that had it — they stay on the
       board and simply lose their type, which the confirm says.

   `icon` is a short piece of text (an emoji, usually) — the server takes any
   string, and the client never maps it to a component, so an unknown one can
   never crash a card. */
import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { EditorHeader, NameInput } from "@/components/pm/settings/editor-bits"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { Board, IssueType, IssueTypeInput, Task } from "@/lib/pm/types"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const EMPTY_TASKS: Task[] = []

/** How many live tasks carry each type. */
export function issueTypeCounts(tasks: Task[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (task.deletedAt !== null || task.typeId === null) continue
    counts.set(task.typeId, (counts.get(task.typeId) ?? 0) + 1)
  }
  return counts
}

export const sortIssueTypes = (types: IssueType[]): IssueType[] =>
  [...types].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

export interface IssueTypesEditorProps {
  board: Board
  actions: Actions
  tasks?: Task[]
  className?: string
}

export function IssueTypesEditor({ board, actions, tasks, className }: IssueTypesEditorProps) {
  const confirm = useConfirm()
  const { state } = useStore()
  const [busy, setBusy] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState("")

  const boardTasks = tasks ?? state.pmTasks[board.id] ?? EMPTY_TASKS
  const counts = React.useMemo(() => issueTypeCounts(boardTasks), [boardTasks])
  const types = React.useMemo(() => sortIssueTypes(board.issueTypes), [board.issueTypes])

  const patch = React.useCallback(
    (type: IssueType, next: Partial<IssueTypeInput>) => {
      setBusy(true)
      actions
        .patchIssueType(board.id, type.id, next)
        .catch((err) => reportError(err, `Couldn't save ${type.name}`))
        .finally(() => setBusy(false))
    },
    [actions, board.id]
  )

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await actions.createIssueType(board.id, { name, icon: null, isEpic: false })
      toast.success(`${name} added`)
      setNewName("")
      setCreating(false)
    } catch (err) {
      reportError(err, "Couldn't add the type")
    } finally {
      setBusy(false)
    }
  }

  const remove = React.useCallback(
    async (type: IssueType) => {
      const used = counts.get(type.id) ?? 0
      const ok = await confirm({
        title: `Delete ${type.name}?`,
        description:
          used === 0
            ? "No task uses it."
            : `${used} ${used === 1 ? "task keeps" : "tasks keep"} their place on the board and lose their type.`,
        confirmLabel: "Delete type",
        destructive: true,
      })
      if (!ok) return
      setBusy(true)
      try {
        await actions.deleteIssueType(board.id, type.id)
        toast.success(`${type.name} deleted`)
      } catch (err) {
        reportError(err, "Couldn't delete the type")
      } finally {
        setBusy(false)
      }
    },
    [actions, board.id, confirm, counts]
  )

  return (
    <div className={cn("space-y-3", className)}>
      <EditorHeader
        title="Issue types"
        hint="The kinds of work this board tracks. An epic type collects children through the epic field."
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New type
          </Button>
        }
      />

      {types.length === 0 && !creating && (
        <p className="py-6 text-center text-sm text-muted-foreground">No issue types yet.</p>
      )}

      <div className="space-y-1.5">
        {types.map((type) => (
          <IssueTypeRow
            key={type.id}
            type={type}
            taskCount={counts.get(type.id) ?? 0}
            busy={busy}
            onPatch={patch}
            onDelete={remove}
          />
        ))}
      </div>

      {creating && (
        <form onSubmit={create} className="flex items-center gap-2 border-t border-border pt-3">
          <Input
            autoFocus
            value={newName}
            aria-label="New type name"
            placeholder="Spike"
            onChange={(event) => setNewName(event.target.value)}
            className="h-8 text-[13px]"
          />
          <Button type="submit" size="sm" disabled={busy || newName.trim().length === 0}>
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setCreating(false)
              setNewName("")
            }}
          >
            Cancel
          </Button>
        </form>
      )}
    </div>
  )
}

interface IssueTypeRowProps {
  type: IssueType
  taskCount: number
  busy: boolean
  onPatch(type: IssueType, patch: Partial<IssueTypeInput>): void
  onDelete(type: IssueType): void
}

const IssueTypeRow = React.memo(function IssueTypeRow({
  type,
  taskCount,
  busy,
  onPatch,
  onDelete,
}: IssueTypeRowProps) {
  const [icon, setIcon] = React.useState(type.icon ?? "")
  React.useEffect(() => setIcon(type.icon ?? ""), [type.icon])

  const commitIcon = () => {
    const next = icon.trim()
    if (next === (type.icon ?? "")) return
    onPatch(type, { icon: next === "" ? null : next })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card/40 px-2 py-1.5">
      <Input
        value={icon}
        aria-label={`${type.name} icon`}
        title="A short piece of text — usually an emoji"
        placeholder="🐛"
        disabled={busy}
        onChange={(event) => setIcon(event.target.value)}
        onBlur={commitIcon}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
        }}
        className="h-8 w-12 text-center text-[13px]"
      />
      <NameInput
        value={type.name}
        ariaLabel={`${type.name} name`}
        disabled={busy}
        onCommit={(name) => onPatch(type, { name })}
        className="min-w-32 flex-1"
      />
      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Switch
          checked={type.isEpic}
          disabled={busy}
          aria-label={`${type.name} is an epic type`}
          onCheckedChange={(checked) => onPatch(type, { isEpic: checked === true })}
        />
        Epic
      </label>
      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {taskCount} {taskCount === 1 ? "task" : "tasks"}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        title="Delete type"
        aria-label={`Delete ${type.name}`}
        onClick={() => onDelete(type)}
      >
        <Trash2 />
      </Button>
    </div>
  )
})

export default IssueTypesEditor
