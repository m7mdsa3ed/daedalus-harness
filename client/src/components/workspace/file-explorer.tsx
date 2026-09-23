/* ── File explorer ──
   A project's tree, lazily expanded. The harness's own, over the workspace
   routes — not a VS Code view and not a file system provider behind one.

   Split in three, along the seam between reading and doing:

   - **`lib/ide/use-file-tree.ts`** is the directory cache and the watch
     stream — what is listed, what is expanded, and keeping both current.
   - **`lib/ide/tree-rows.ts`** derives the flat, memoizable row array the
     tree is drawn from, which is also what makes it windowable.
   - **this file** is what a person does to the tree and what that looks
     like: open, create, rename, delete, filter.

   The rows are **data before they are JSX**, and selection is deliberately not
   an input to the derivation. This used to recurse into JSX in the middle of
   `render`, so every keystroke in the filter box rebuilt every expanded node —
   each one allocating a fresh context-menu array of six closures on the way
   past, which is why nothing downstream could be memoized. */
import * as React from "react"
import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FilePlusIcon,
  FolderPlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Input } from "@/components/ui/input"
import { useConfirm } from "@/components/confirm-dialog"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { PanelToolbar } from "@/components/workspace/primitives"
import { useWindowedRows } from "@/hooks/use-windowed-rows"
import { describeError, reportError } from "@/lib/errors"
import {
  flattenTree,
  rowLines,
  ROW_HEIGHT,
  type Draft,
  type TreeRow,
} from "@/lib/ide/tree-rows"
import { useFileTree } from "@/lib/ide/use-file-tree"
import { cn } from "@/lib/utils"
import {
  createEntry,
  deleteEntry,
  dirname,
  joinPath,
  renameEntry,
  type WorkspaceEntry,
} from "@/lib/workspace/fs-api"

const ROW = "flex h-7 w-full items-center gap-1 rounded-md pr-1 text-xs"

const indent = (depth: number): React.CSSProperties => ({ paddingLeft: `${depth * 12 + 4}px` })

export function FileExplorer({
  projectId,
  onOpenFile,
  selected,
}: {
  projectId: string
  onOpenFile: (path: string) => void
  /** The tab in front, so the tree marks where you are. */
  selected: string | null
}) {
  const confirm = useConfirm()

  const { dirs, expanded, showHidden, setShowHidden, load, refresh, toggle, setExpanded } =
    useFileTree(projectId)
  const [picked, setPicked] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState("")
  const [draft, setDraft] = React.useState<Draft | null>(null)

  /* ── Mutations ───────────────────────────────────────────────────────────── */

  const commitDraft = async () => {
    if (!draft) return
    const name = draft.value.trim()
    setDraft(null)
    if (!name) return
    try {
      if (draft.kind === "rename" && draft.target) {
        const to = joinPath(dirname(draft.target), name)
        if (to === draft.target) return
        await renameEntry(projectId, draft.target, to)
        await load(dirname(draft.target))
        setPicked(to)
      } else {
        const path = joinPath(draft.dir, name)
        await createEntry(projectId, path, draft.kind === "create-dir" ? "dir" : "file")
        await load(draft.dir)
        setPicked(path)
        if (draft.kind === "create-file") onOpenFile(path)
        else setExpanded((current) => new Set(current).add(path))
      }
    } catch (err) {
      reportError(err, draft.kind === "rename" ? "Couldn't rename that" : "Couldn't create that")
    }
  }

  const remove = React.useCallback(async (entry: WorkspaceEntry) => {
    const ok = await confirm({
      title: `Delete ${entry.name}?`,
      description:
        entry.type === "dir"
          ? "The folder and everything in it is removed from disk. This cannot be undone from here."
          : "The file is removed from disk. This cannot be undone from here.",
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteEntry(projectId, entry.path)
      await load(dirname(entry.path))
    } catch (err) {
      reportError(err, "Couldn't delete that")
    }
  }, [confirm, load, projectId])

  const copyPath = React.useCallback((path: string) => {
    writeClipboard(path).catch((err) => reportError(err, "Couldn't copy the path"))
  }, [])

  /* ── Rendering ───────────────────────────────────────────────────────────── */

  const query = filter.trim().toLowerCase()

  /* The tree is derived **once** per shape change and then drawn. Selection is
     deliberately not an input (`lib/ide/tree-rows.ts`): a click that only moves
     the highlight must not rebuild every row. */
  const rows = React.useMemo(
    () => flattenTree({ dirs, expanded, query, draft }),
    [dirs, expanded, query, draft]
  )
  const win = useWindowedRows({ rows, lineHeight: ROW_HEIGHT, linesOf: rowLines })

  /* One stable bundle of callbacks for every row, so `EntryRow`'s `React.memo`
     can actually hit. Handed down whole rather than as eight props, because a
     row that re-renders when any one of them changes is the same as a row with
     no memo at all — and none of these change. */
  const actions = React.useMemo<RowActions>(
    () => ({
      onOpenFile,
      onPick: setPicked,
      onToggle: toggle,
      onNewFile: (dir) => {
        setExpanded((current) => new Set(current).add(dir))
        setDraft({ kind: "create-file", dir, value: "" })
      },
      onNewDir: (dir) => {
        setExpanded((current) => new Set(current).add(dir))
        setDraft({ kind: "create-dir", dir, value: "" })
      },
      onRename: (entry) =>
        setDraft({ kind: "rename", dir: dirname(entry.path), target: entry.path, value: entry.name }),
      onCopyPath: copyPath,
      onDelete: (entry) => void remove(entry),
    }),
    [onOpenFile, toggle, copyPath, remove]
  )

  const drawRow = (row: TreeRow): React.ReactNode => {
    switch (row.kind) {
      case "entry":
        return (
          <EntryRow
            key={row.key}
            row={row}
            /* The two props that change on a click. Everything else a row needs
               is `actions`, which never changes — so a selection move re-renders
               the row leaving and the row arriving, and nothing else. */
            current={selected === row.entry.path || picked === row.entry.path}
            actions={actions}
          />
        )
      case "draft":
        return (
          draft && (
            <DraftRow
              key={row.key}
              depth={row.depth}
              draft={draft}
              onChange={(value) => setDraft({ ...draft, value })}
              onCommit={() => void commitDraft()}
              onCancel={() => setDraft(null)}
            />
          )
        )
      case "error":
        return (
          <div key={row.key} className="flex items-start gap-1 px-2 py-1" style={indent(row.depth)}>
            <p className="min-w-0 flex-1 text-xs text-destructive">{row.message}</p>
            <CopyButton
              text={row.message}
              size="icon-xs"
              className="shrink-0 text-destructive/70 hover:bg-destructive/15 hover:text-destructive"
            />
          </div>
        )
      case "loading":
        return (
          <div key={row.key} style={indent(row.depth)}>
            <PanelRowsSkeleton rows={4} className="p-0" />
          </div>
        )
      case "note":
        return (
          <p
            key={row.key}
            style={indent(row.depth)}
            className={cn(ROW, "text-muted-foreground/60")}
            title={row.title}
          >
            {row.text}
          </p>
        )
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        <div className="relative min-w-0 flex-1">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter this tree"
            aria-label="Filter files"
            className="h-7 pe-6 text-xs"
          />
          {filter && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Clear filter"
              className="absolute top-1/2 right-1 size-5 -translate-y-1/2"
              onClick={() => setFilter("")}
            >
              <XIcon className="size-3" />
            </Button>
          )}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="New file"
          title="New file"
          className="size-6"
          onClick={() => setDraft({ kind: "create-file", dir: "", value: "" })}
        >
          <FilePlusIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="New folder"
          title="New folder"
          className="size-6"
          onClick={() => setDraft({ kind: "create-dir", dir: "", value: "" })}
        >
          <FolderPlusIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          className="size-6"
          onClick={() => setShowHidden((current) => !current)}
        >
          {showHidden ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh"
          title="Refresh"
          className="size-6"
          onClick={refresh}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </PanelToolbar>
      {/* Only the rows on screen exist; the two spacers stand in for the rest,
          so the scrollbar is the height of the whole tree. */}
      <div ref={win.ref} className="min-h-0 flex-1 overflow-auto p-1">
        <div style={{ height: win.padTop }} />
        {rows.slice(win.start, win.end).map(drawRow)}
        <div style={{ height: win.padBottom }} />
      </div>
    </div>
  )
}

/** Everything a row can do, as one stable object — see `actions` above. */
interface RowActions {
  onOpenFile: (path: string) => void
  onPick: (path: string) => void
  onToggle: (path: string) => void
  onNewFile: (dir: string) => void
  onNewDir: (dir: string) => void
  onRename: (entry: WorkspaceEntry) => void
  onCopyPath: (path: string) => void
  onDelete: (entry: WorkspaceEntry) => void
}

/* One file or folder. Memoized on three props, two of which are stable and one
   of which is a boolean — so scrolling, typing in the filter box and selecting
   another file all leave an untouched row untouched. The context menu is built
   here rather than passed in, which is what stops it being six fresh closures
   per row on every render of the panel. */
const EntryRow = React.memo(function EntryRow({
  row,
  current,
  actions,
}: {
  row: Extract<TreeRow, { kind: "entry" }>
  current: boolean
  actions: RowActions
}) {
  const { entry, depth, expanded } = row
  const items: MenuItemSpec[] = [
    ...(entry.type === "file"
      ? [{ label: "Open", onClick: () => actions.onOpenFile(entry.path) }]
      : [
          { label: "New file…", onClick: () => actions.onNewFile(entry.path) },
          { label: "New folder…", onClick: () => actions.onNewDir(entry.path) },
        ]),
    { type: "separator" },
    { label: "Rename…", onClick: () => actions.onRename(entry) },
    { label: "Copy relative path", onClick: () => actions.onCopyPath(entry.path) },
    { type: "separator" },
    { label: "Delete", destructive: true, onClick: () => actions.onDelete(entry) },
  ]

  return (
    <ItemContextMenu items={items}>
      <button
        type="button"
        style={indent(depth)}
        onClick={() => {
          actions.onPick(entry.path)
          if (entry.type === "dir") actions.onToggle(entry.path)
          else actions.onOpenFile(entry.path)
        }}
        className={cn(
          ROW,
          "text-left transition-colors",
          current
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          entry.ignored && "opacity-60"
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform",
            entry.type === "dir" ? (expanded ? "rotate-90" : "") : "invisible"
          )}
        />
        <span className="truncate">{entry.name}</span>
        {entry.link && <span className="shrink-0 text-[10px] opacity-60">↗</span>}
      </button>
    </ItemContextMenu>
  )
})

function DraftRow({
  depth,
  draft,
  onChange,
  onCommit,
  onCancel,
}: {
  depth: number
  draft: Draft
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  return (
    <div style={indent(depth)} className={cn(ROW, "gap-1")}>
      <ChevronRightIcon aria-hidden className="invisible size-3 shrink-0" />
      <Input
        autoFocus
        value={draft.value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            onCommit()
          } else if (event.key === "Escape") {
            /* Claimed, so the dock's Escape chain does not also fire — naming a
               file should not stop the turn running in the thread next door. */
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
        placeholder={draft.kind === "create-dir" ? "Folder name" : "File name"}
        aria-label={draft.kind === "rename" ? "New name" : "Name"}
        className="h-6 min-w-0 flex-1 px-1 text-xs"
      />
    </div>
  )
}
import { writeClipboard } from "@/lib/clipboard"
