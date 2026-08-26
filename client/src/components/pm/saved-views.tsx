/* ── Saved views ──
   A saved view is a named FilterSpec (plus, optionally, the view tab it was
   saved from) living in the board's `savedViews` json column. This is the menu
   the filter bar reserved space for in W2.

   Two rules shape it:

   1. It owns no filter state. `value` is the live FilterSpec the filter bar
      edits and `onChange` is how a pick reaches it — applying a view is
      exactly the same event as ticking a facet, so nothing downstream needs to
      know a saved view exists. A view that also carries a tab (`view`) hands
      it over as `onChange`'s second argument; a caller that only wants filters
      can pass the filter-bar setter straight in and ignore it.
   2. Shelf switches are not filters. `archived`/`trashed` say *which shelf*
      the user is looking at, so applying a view keeps the current ones rather
      than dragging the user out of the archive they opened — the same rule the
      filter bar's Clear button follows.

   The two writes go through `actions.putSavedView` / `actions.deleteSavedView`,
   which are PUT-upsert and DELETE on the board's `savedViews` json column and
   end in a board refetch — what changed, from the board's point of view, is one
   of its arrays. */
import * as React from "react"
import { Bookmark, BookmarkCheck, Check, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { isFilterActive } from "@/lib/pm/filtering"
import type { Board, FilterSpec, SavedView, ViewName } from "@/lib/pm/types"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Pure helpers

/** The FilterSpec keys a saved view remembers — the shelf switches
    (`archived`/`trashed`) are deliberately absent, see the header. */
const SAVED_KEYS = [
  "q",
  "columnIds",
  "assignees",
  "labelIds",
  "typeIds",
  "sprint",
  "epicId",
  "parentId",
  "milestoneId",
  "priorityGte",
  "due",
] as const

/** A comparable copy: only the saved keys, arrays sorted, empties dropped.
    Two specs that narrow the same way must compare equal however they were
    built (chip order is not meaning). */
function normalize(spec: FilterSpec): string {
  const out: Record<string, unknown> = {}
  for (const key of SAVED_KEYS) {
    const value = spec[key]
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      out[key] = [...value].sort()
    } else if (value !== "") {
      out[key] = value
    }
  }
  return JSON.stringify(out, Object.keys(out).sort())
}

/** Is this saved view the one currently applied? */
export function isViewActive(view: SavedView, spec: FilterSpec): boolean {
  return normalize(view.filter) === normalize(spec)
}

/** Strip the shelf switches before saving — a view is a filter, not a shelf. */
export function filterToSave(spec: FilterSpec): FilterSpec {
  const out: FilterSpec = {}
  for (const key of SAVED_KEYS) {
    const value = spec[key]
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  return out
}

/** "3 statuses · 1 label · Due today" — enough to tell two views apart in the
    menu without opening either. Built from the board's own config, so a new
    column or label needs no code here. */
export function describeFilter(spec: FilterSpec, board: Board): string {
  const parts: string[] = []
  if (spec.q) parts.push(`“${spec.q}”`)
  if (spec.columnIds?.length) {
    parts.push(
      spec.columnIds.length === 1
        ? (board.columns.find((c) => c.id === spec.columnIds?.[0])?.name ?? "1 status")
        : `${spec.columnIds.length} statuses`
    )
  }
  if (spec.typeIds?.length) parts.push(`${spec.typeIds.length} type${spec.typeIds.length > 1 ? "s" : ""}`)
  if (spec.labelIds?.length) {
    parts.push(
      spec.labelIds.length === 1
        ? (board.labels.find((l) => l.id === spec.labelIds?.[0])?.name ?? "1 label")
        : `${spec.labelIds.length} labels`
    )
  }
  if (spec.assignees?.length) parts.push(spec.assignees.join(", "))
  if (spec.priorityGte !== undefined) parts.push(`priority ≥ ${spec.priorityGte}`)
  if (spec.sprint !== undefined) {
    parts.push(
      spec.sprint === "none"
        ? "Backlog"
        : (board.sprints.find((s) => s.id === spec.sprint)?.name ?? "1 sprint")
    )
  }
  if (spec.milestoneId !== undefined) {
    parts.push(board.milestones.find((m) => m.id === spec.milestoneId)?.name ?? "1 milestone")
  }
  if (spec.due) {
    parts.push(spec.due === "overdue" ? "Overdue" : spec.due === "today" ? "Due today" : "Due this week")
  }
  return parts.length > 0 ? parts.join(" · ") : "No filters"
}

// ---------------------------------------------------------------------------
// The menu

export interface SavedViewsMenuProps {
  board: Board
  /** The live FilterSpec — the same object the filter bar edits. */
  value: FilterSpec
  /**
   * Applying a saved view. `filter` replaces the live spec (shelf switches
   * preserved); `view` is the tab the saved view carries, `undefined` when it
   * carries none — a caller with no tab to switch can ignore the argument and
   * pass its plain `(spec) => void` setter.
   */
  onChange(filter: FilterSpec, view?: ViewName): void
  actions: Actions
  className?: string
}

export function SavedViewsMenu({ board, value, onChange, actions, className }: SavedViewsMenuProps) {
  const confirm = useConfirm()
  const [busy, setBusy] = React.useState(false)
  /** `null` = closed; `{ id: null }` = save-current; `{ id }` = rename. */
  const [naming, setNaming] = React.useState<{ id: string | null; name: string } | null>(null)

  const views = board.savedViews ?? []
  const active = React.useMemo(
    () => views.find((view) => isViewActive(view, value)) ?? null,
    [views, value]
  )

  const put = React.useCallback(
    async (view: SavedView) => {
      await actions.putSavedView(board.id, view)
    },
    [actions, board.id]
  )

  const apply = React.useCallback(
    (view: SavedView) => {
      onChange(
        { ...view.filter, archived: value.archived, trashed: value.trashed },
        view.view
      )
    },
    [onChange, value.archived, value.trashed]
  )

  const submitName = async (event: React.FormEvent) => {
    event.preventDefault()
    if (naming === null || busy) return
    const name = naming.name.trim()
    if (!name) return
    setBusy(true)
    try {
      if (naming.id === null) {
        // The client mints the id; PUT is an upsert keyed by the path segment.
        await put({ id: crypto.randomUUID(), name, filter: filterToSave(value) })
        toast.success(`${name} saved`)
      } else {
        const existing = views.find((view) => view.id === naming.id)
        if (existing) {
          await put({ ...existing, name })
          toast.success(`Renamed to ${name}`)
        }
      }
      setNaming(null)
    } catch (err) {
      reportError(err, naming.id === null ? "Couldn't save the view" : "Couldn't rename the view")
    } finally {
      setBusy(false)
    }
  }

  const remove = React.useCallback(
    async (view: SavedView) => {
      const ok = await confirm({
        title: `Delete ${view.name}?`,
        description: "The filter itself is not lost — only this shortcut to it.",
        confirmLabel: "Delete view",
        destructive: true,
      })
      if (!ok) return
      setBusy(true)
      try {
        await actions.deleteSavedView(board.id, view.id)
        toast.success(`${view.name} deleted`)
      } catch (err) {
        reportError(err, "Couldn't delete the view")
      } finally {
        setBusy(false)
      }
    },
    [actions, board.id, confirm]
  )

  /** Overwrite the active view with what the bar now says — the one edit that
      is not a rename, and only offered when a view IS active. */
  const update = React.useCallback(async () => {
    if (!active) return
    setBusy(true)
    try {
      await put({ ...active, filter: filterToSave(value) })
      toast.success(`${active.name} updated`)
    } catch (err) {
      reportError(err, "Couldn't update the view")
    } finally {
      setBusy(false)
    }
  }, [active, put, value])

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              title="Saved views"
              className={cn(active ? "text-foreground" : "text-muted-foreground", className)}
            >
              {active ? <BookmarkCheck /> : <Bookmark />}
              <span className="hidden max-w-32 truncate sm:inline">
                {active ? active.name : "Views"}
              </span>
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Saved views</DropdownMenuLabel>
            {views.length === 0 && (
              <DropdownMenuItem disabled className="whitespace-normal text-xs">
                No saved views yet — filter the board, then save it.
              </DropdownMenuItem>
            )}
            {views.map((view) => (
              <DropdownMenuItem
                key={view.id}
                closeOnClick
                onClick={() => apply(view)}
                className="gap-2"
              >
                <Check
                  className={cn("size-3.5 shrink-0", active?.id === view.id ? "opacity-100" : "opacity-0")}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{view.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {describeFilter(view.filter, board)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Rename"
                    aria-label={`Rename ${view.name}`}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation()
                      setNaming({ id: view.id, name: view.name })
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Delete"
                    aria-label={`Delete ${view.name}`}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation()
                      void remove(view)
                    }}
                  >
                    <Trash2 />
                  </Button>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={busy || !isFilterActive(value)}
              onClick={() => setNaming({ id: null, name: "" })}
            >
              <Plus />
              Save current view
            </DropdownMenuItem>
            {active && (
              <DropdownMenuItem disabled={busy} onClick={() => void update()}>
                <BookmarkCheck />
                Update “{active.name}”
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Naming is a dialog, not an inline row: the menu closes on the click
          that opens it, and a prompt() is not available to us. */}
      <Dialog open={naming !== null} onOpenChange={(open) => !open && setNaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={submitName}>
            <DialogHeader>
              <DialogTitle>{naming?.id === null ? "Save view" : "Rename view"}</DialogTitle>
              <DialogDescription>
                {naming?.id === null
                  ? describeFilter(value, board)
                  : "Only the name changes — the filter stays as it was saved."}
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                autoFocus
                required
                aria-label="View name"
                placeholder={`View ${views.length + 1}`}
                value={naming?.name ?? ""}
                onChange={(event) =>
                  setNaming((current) =>
                    current === null ? current : { ...current, name: event.target.value }
                  )
                }
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || (naming?.name ?? "").trim().length === 0}>
                {naming?.id === null ? "Save view" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
