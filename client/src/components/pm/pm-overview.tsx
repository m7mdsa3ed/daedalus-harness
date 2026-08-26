/* ── /tasks — the board hub ──
   Every board on one page: the live ones as cards (from the store, so free),
   then Templates and Archive as folds that fetch their own shelf the first time
   they are opened — `refreshBoards` only ever lets the live shelf into the
   store, and the hub must not be the thing that breaks that.

   Deliberately cheap: a card shows an open-task count ONLY when that board's
   tasks already happen to be loaded (you have opened it this session). Counting
   the rest would mean fetching every board's tasks to draw a hub. */
import * as React from "react"
import { useNavigate } from "react-router"
import { ChevronRight, Plus, SquareKanban } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { BoardDot, usePmActions } from "@/components/pm/pm-sidebar-panels"
import { reportError } from "@/lib/errors"
import type { Actions } from "@/lib/actions"
import type { BoardSummary, Task } from "@/lib/pm/types"
import { boardPath, pendingCreate } from "@/lib/router"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/* Palette tokens, not hex: a board's colour has to survive every palette and
   every user-made theme (styles/themes.css), and these five are the set the
   charts already draw from. */
const BOARD_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

/** "Task Board" → TB, "Roadmap" → ROAD. Editable afterwards — this is only the
    first guess, and the server rejects a collision with a 400. */
export function deriveKeyPrefix(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length === 0) return ""
  const raw =
    words.length > 1
      ? words.slice(0, 4).map((word) => word[0]).join("")
      : words[0].slice(0, 4)
  return raw.toUpperCase()
}

/** Not done, not archived, not trashed — the number a board card reports. */
const openCount = (tasks: Task[]): number =>
  tasks.filter((task) => !task.completedAt && !task.archivedAt && !task.deletedAt).length

export default function PmOverview() {
  const actions = usePmActions()
  const navigate = useNavigate()
  const { state } = useStore()
  const [loading, setLoading] = React.useState(state.boards.length === 0)
  const [newOpen, setNewOpen] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    actions
      .refreshBoards()
      .catch((err) => reportError(err, "Couldn't load the boards"))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [actions])

  /* ⌘K and the sidebar ask for "new board" by navigating with ?new=board — the
     dialog lives here, so the param is consumed here and stripped. */
  React.useEffect(() => {
    if (pendingCreate(location.search) !== "board") return
    setNewOpen(true)
    void navigate(location.pathname, { replace: true })
  }, [navigate])

  const active = state.boards.filter(
    (board) => !board.templateFor && !board.archivedAt && !board.deletedAt
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10">
      <div className="mx-auto w-full max-w-5xl">
        <div className="flex items-center justify-between gap-3 pb-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">Boards</h2>
            <p className="text-sm text-muted-foreground">
              Every board on this harness. Open one to plan, or start another.
            </p>
          </div>
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus />
            New board
          </Button>
        </div>

        {loading && active.length === 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : active.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SquareKanban />
              </EmptyMedia>
              <EmptyTitle>No boards yet</EmptyTitle>
              <EmptyDescription>
                A board holds columns, labels, issue types and everything on them.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setNewOpen(true)}>
                <Plus />
                New board
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((board) => (
              <BoardCard
                key={board.id}
                board={board}
                tasks={state.pmTasks[board.id]}
                onOpen={() => void navigate(boardPath(board.id))}
              />
            ))}
            <button
              type="button"
              onClick={() => setNewOpen(true)}
              className="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed p-3 text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:bg-accent/40 hover:text-foreground"
            >
              <Plus className="size-4" />
              New board
            </button>
          </div>
        )}

        <Shelf label="Templates" empty="No templates yet." shelf={{ templates: true }} actions={actions} />
        <Shelf label="Archived" empty="Nothing archived." shelf={{ archived: true }} actions={actions} />
      </div>

      <NewBoardDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreate={async (input) => {
          const board = await actions.createBoard(input)
          setNewOpen(false)
          void navigate(boardPath(board.id))
        }}
      />
    </div>
  )
}

function BoardCard({
  board,
  tasks,
  onOpen,
  muted = false,
}: {
  board: BoardSummary
  tasks?: Task[]
  onOpen: () => void
  muted?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "min-h-24 rounded-xl border bg-card p-3 text-left transition-colors hover:border-ring/50 hover:bg-accent/40",
        muted && "opacity-80"
      )}
    >
      <div className="flex items-center gap-2">
        <BoardDot color={board.color} />
        <span className="truncate text-sm font-medium">{board.name}</span>
        <span className="ml-auto shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {board.keyPrefix}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs text-pretty text-muted-foreground">
        {board.description || "No description."}
      </p>
      {/* Only when this board's tasks are already in the store — the hub does
          not fetch a board's tasks just to print a number. */}
      {tasks && (
        <p className="mt-2 text-[11px] tabular-nums text-muted-foreground/70">
          {openCount(tasks)} open
        </p>
      )}
    </button>
  )
}

/** A fold over a shelf the store does not keep — fetched when first opened. */
function Shelf({
  label,
  empty,
  shelf,
  actions,
}: {
  label: string
  empty: string
  shelf: { archived?: boolean; templates?: boolean }
  actions: Actions
}) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [boards, setBoards] = React.useState<BoardSummary[] | null>(null)

  React.useEffect(() => {
    if (!open || boards) return
    let cancelled = false
    actions
      .refreshBoards(shelf)
      .then((rows) => {
        if (!cancelled) setBoards(rows)
      })
      .catch((err) => reportError(err, `Couldn't load ${label.toLowerCase()}`))
    return () => {
      cancelled = true
    }
    // `shelf` is a literal at the call site; the fold is identified by `label`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, boards, actions, label])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-6">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase transition-colors hover:text-foreground"
          />
        }
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-90")}
        />
        <span>{label}</span>
        {boards && <span className="ml-auto tabular-nums opacity-70">{boards.length}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="harness-collapse">
        <div className="pt-3">
          {boards === null ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-24 rounded-xl" />
              <Skeleton className="h-24 rounded-xl" />
            </div>
          ) : boards.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">{empty}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {boards.map((board) => (
                <BoardCard
                  key={board.id}
                  board={board}
                  muted
                  onOpen={() => void navigate(boardPath(board.id))}
                />
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function NewBoardDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: { name: string; keyPrefix: string; color: string | null }) => Promise<void>
}) {
  const [name, setName] = React.useState("")
  const [prefix, setPrefix] = React.useState("")
  // Once the prefix has been typed in by hand, the name stops overwriting it.
  const [prefixTouched, setPrefixTouched] = React.useState(false)
  const [color, setColor] = React.useState<string | null>(BOARD_COLORS[0])
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setName("")
    setPrefix("")
    setPrefixTouched(false)
    setColor(BOARD_COLORS[0])
    setBusy(false)
  }, [open])

  const effectivePrefix = prefixTouched ? prefix : deriveKeyPrefix(name)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !effectivePrefix) return
    setBusy(true)
    try {
      await onCreate({ name: name.trim(), keyPrefix: effectivePrefix, color })
    } catch (err) {
      reportError(err, "Couldn't create the board")
      setBusy(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>New board</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              It starts with the default columns — rename them later in the board's settings.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <div className="space-y-1.5">
            <label htmlFor="pm-board-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="pm-board-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Product roadmap"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="pm-board-prefix" className="text-sm font-medium">
              Key prefix
            </label>
            <Input
              id="pm-board-prefix"
              value={effectivePrefix}
              onChange={(event) => {
                setPrefixTouched(true)
                setPrefix(event.target.value.toUpperCase())
              }}
              placeholder="PROD"
              className="font-mono uppercase"
            />
            <p className="text-xs text-muted-foreground">
              Task keys read {effectivePrefix || "KEY"}-1, {effectivePrefix || "KEY"}-2. It has to be
              unique across boards.
            </p>
          </div>

          <div className="space-y-1.5">
            <span className="text-sm font-medium">Colour</span>
            <div className="flex flex-wrap items-center gap-2">
              {BOARD_COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`Colour ${value}`}
                  aria-pressed={color === value}
                  onClick={() => setColor(value)}
                  style={{ backgroundColor: value }}
                  className={cn(
                    "size-6 rounded-full ring-offset-2 ring-offset-background transition-shadow",
                    color === value && "ring-2 ring-ring"
                  )}
                />
              ))}
              <button
                type="button"
                aria-label="No colour"
                aria-pressed={color === null}
                onClick={() => setColor(null)}
                className={cn(
                  "size-6 rounded-full border border-dashed ring-offset-2 ring-offset-background",
                  color === null && "ring-2 ring-ring"
                )}
              />
            </div>
          </div>

          <ResponsiveDialogFooter className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !effectivePrefix}>
              Create board
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
