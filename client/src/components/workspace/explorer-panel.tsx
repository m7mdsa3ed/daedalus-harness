/* ── File explorer ──
   A project's tree, lazily expanded.

   Two decisions shape the whole file.

   **Listings are cached per directory, not as a tree.** The state is
   `Map<dirPath, entries>` plus a set of expanded paths, and the rendered tree
   is derived from the two. That is what lets a watch event invalidate exactly
   the directory that changed and leave every other branch — including its
   expansion and its scroll position — untouched. A nested tree object would
   have to be rebuilt from the root, which is the version of this that collapses
   everything you had open every time a build writes a file.

   **The server is the authority on what exists.** Nothing here optimistically
   inserts a row: create, rename and delete re-read the affected directory. A
   tree that shows a file the server would refuse to open is worse than one that
   takes 20ms to catch up. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FilePlusIcon,
  FolderPlusIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useConfirm } from "@/components/confirm-dialog"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { useDock } from "@/components/workspace/dock"
import { describeError, reportError } from "@/lib/errors"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import {
  createEntry,
  deleteEntry,
  dirname,
  joinPath,
  listDir,
  renameEntry,
  type WorkspaceEntry,
} from "@/lib/workspace/fs-api"
import { watchProject } from "@/lib/workspace/watch"

interface DirState {
  entries: WorkspaceEntry[]
  truncated: boolean
  loading: boolean
  error?: string
}

/** An inline row being typed into: a new file/folder, or a rename. */
interface Draft {
  kind: "create-file" | "create-dir" | "rename"
  /** The directory it lives in. */
  dir: string
  /** For a rename, the path being renamed. */
  target?: string
  value: string
}

const ROW = "flex h-7 w-full items-center gap-1 rounded-md pr-1 text-xs"

export function ExplorerPanel({ api, params }: IDockviewPanelProps<{ projectId: string }>) {
  const projectId = params.projectId
  const dock = useDock()
  const confirm = useConfirm()
  const { state } = useStore()
  const project = state.projects.find((candidate) => candidate.id === projectId)

  const [dirs, setDirs] = React.useState<Map<string, DirState>>(() => new Map())
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set([""]))
  const [selected, setSelected] = React.useState<string | null>(null)
  const [showHidden, setShowHidden] = React.useState(false)
  const [filter, setFilter] = React.useState("")
  const [draft, setDraft] = React.useState<Draft | null>(null)

  React.useEffect(() => {
    api.setTitle(project ? `Explorer — ${project.name}` : "Explorer")
  }, [api, project?.name, project])

  /* `load` has to be *stable*. Everything downstream keys off its identity: the
     watch subscription, which would otherwise tear down and re-open the server
     stream every time the dotfile toggle moves, and the on-demand effect, which
     would re-run and duplicate every in-flight request. So the toggle lives in
     a ref that `load` reads, and changing it triggers exactly one refresh. */
  const showHiddenRef = React.useRef(showHidden)
  showHiddenRef.current = showHidden

  /* Staleness is tracked per directory, not globally. A single counter is
     wrong here: expanding four folders at once bumps it four times, so the
     first answer back looks stale against a generation that a *different*
     directory advanced. Each path only races itself. */
  const inflight = React.useRef(new Map<string, number>())
  const load = React.useCallback(
    async (path: string) => {
      const mine = (inflight.current.get(path) ?? 0) + 1
      inflight.current.set(path, mine)
      setDirs((current) => {
        const next = new Map(current)
        next.set(path, { ...(next.get(path) ?? { entries: [], truncated: false }), loading: true })
        return next
      })
      try {
        const listing = await listDir(projectId, path, { hidden: showHiddenRef.current })
        if (inflight.current.get(path) !== mine) return
        setDirs((current) => {
          const next = new Map(current)
          next.set(path, { entries: listing.entries, truncated: listing.truncated, loading: false })
          return next
        })
      } catch (err) {
        if (inflight.current.get(path) !== mine) return
        const { title, detail } = describeError(err)
        setDirs((current) => {
          const next = new Map(current)
          next.set(path, {
            entries: [],
            truncated: false,
            loading: false,
            error: detail ? `${title} — ${detail}` : title,
          })
          return next
        })
      }
    },
    [projectId]
  )

  /** Re-read every directory currently on screen. */
  const expandedRef = React.useRef(expanded)
  expandedRef.current = expanded
  const refresh = React.useCallback(() => {
    for (const path of [...expandedRef.current]) void load(path)
  }, [load])

  // Anything expanded and not yet read, loads. Collapsing keeps the listing
  // cached, so re-expanding is instant and only a refresh goes back to disk.
  const dirsRef = React.useRef(dirs)
  dirsRef.current = dirs
  React.useEffect(() => {
    for (const path of expanded) if (!dirsRef.current.has(path)) void load(path)
  }, [expanded, load])

  const hiddenFirstRun = React.useRef(true)
  React.useEffect(() => {
    // The toggle re-reads what is open rather than clearing it: the tree you
    // were looking at should still be the tree you are looking at.
    if (hiddenFirstRun.current) {
      hiddenFirstRun.current = false
      return
    }
    refresh()
  }, [showHidden, refresh])

  /* Watch events name a path; what they invalidate is the directory that holds
     it. An overflow names nothing, so everything open is re-read — which is
     what "I stopped counting" has to mean. */
  React.useEffect(() => {
    return watchProject(projectId, (batch) => {
      if (batch.overflow) {
        setExpanded((open) => {
          for (const path of open) void load(path)
          return open
        })
        return
      }
      const touched = new Set<string>()
      for (const event of batch.events) touched.add(dirname(event.path))
      setExpanded((open) => {
        for (const dir of touched) if (open.has(dir)) void load(dir)
        return open
      })
    })
  }, [projectId, load])

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const openFile = React.useCallback(
    (path: string, options?: { direction?: "right" }) => {
      dock.openPanel({ kind: "editor", projectId, path }, options)
    },
    [dock, projectId]
  )

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
        if (to !== draft.target) setSelected(to)
      } else {
        const path = joinPath(draft.dir, name)
        await createEntry(projectId, path, draft.kind === "create-dir" ? "dir" : "file")
        await load(draft.dir)
        setSelected(path)
        if (draft.kind === "create-file") openFile(path)
        else setExpanded((current) => new Set(current).add(path))
      }
    } catch (err) {
      reportError(err, draft.kind === "rename" ? "Couldn't rename that" : "Couldn't create that")
    }
  }

  const remove = async (entry: WorkspaceEntry) => {
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
  }

  const copyPath = (path: string) => {
    navigator.clipboard.writeText(path).catch((err) => reportError(err, "Couldn't copy the path"))
  }

  /* ── Rendering ───────────────────────────────────────────────────────────── */

  const query = filter.trim().toLowerCase()

  const menuFor = (entry: WorkspaceEntry): MenuItemSpec[] => [
    ...(entry.type === "file"
      ? [
          { label: "Open", onClick: () => openFile(entry.path) },
          { label: "Open to the side", onClick: () => openFile(entry.path, { direction: "right" }) },
        ]
      : [
          {
            label: "New file…",
            onClick: () => {
              setExpanded((current) => new Set(current).add(entry.path))
              setDraft({ kind: "create-file", dir: entry.path, value: "" })
            },
          },
          {
            label: "New folder…",
            onClick: () => {
              setExpanded((current) => new Set(current).add(entry.path))
              setDraft({ kind: "create-dir", dir: entry.path, value: "" })
            },
          },
        ]),
    { type: "separator" },
    {
      label: "Rename…",
      onClick: () =>
        setDraft({ kind: "rename", dir: dirname(entry.path), target: entry.path, value: entry.name }),
    },
    { label: "Copy relative path", onClick: () => copyPath(entry.path) },
    { type: "separator" },
    { label: "Delete", destructive: true, onClick: () => void remove(entry) },
  ]

  const renderDir = (path: string, depth: number): React.ReactNode[] => {
    const dir = dirs.get(path)
    if (!dir) return []
    const rows: React.ReactNode[] = []

    if (dir.error) {
      rows.push(
        <p key={`${path}:error`} className="px-2 py-1 text-xs text-destructive" style={indent(depth)}>
          {dir.error}
        </p>
      )
      return rows
    }

    const entries = query
      ? dir.entries.filter((entry) => entry.name.toLowerCase().includes(query))
      : dir.entries

    for (const entry of entries) {
      const isOpen = expanded.has(entry.path)
      const renaming = draft?.kind === "rename" && draft.target === entry.path
      rows.push(
        renaming ? (
          <DraftRow
            key={entry.path}
            depth={depth}
            draft={draft}
            onChange={(value) => setDraft({ ...draft, value })}
            onCommit={() => void commitDraft()}
            onCancel={() => setDraft(null)}
          />
        ) : (
          <ItemContextMenu key={entry.path} items={menuFor(entry)}>
            <button
              type="button"
              style={indent(depth)}
              onClick={() => {
                setSelected(entry.path)
                if (entry.type === "dir") toggle(entry.path)
              }}
              onDoubleClick={() => entry.type === "file" && openFile(entry.path)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                if (entry.type === "file") openFile(entry.path)
                else toggle(entry.path)
              }}
              className={cn(
                ROW,
                "text-left transition-colors",
                selected === entry.path
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                entry.ignored && "opacity-60"
              )}
            >
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3 shrink-0 transition-transform",
                  entry.type === "dir" ? (isOpen ? "rotate-90" : "") : "invisible"
                )}
              />
              <span className="truncate">{entry.name}</span>
              {entry.link && <span className="shrink-0 text-[10px] opacity-60">↗</span>}
            </button>
          </ItemContextMenu>
        )
      )

      if (entry.type === "dir" && isOpen) rows.push(...renderDir(entry.path, depth + 1))
    }

    if (draft && draft.kind !== "rename" && draft.dir === path) {
      rows.push(
        <DraftRow
          key={`${path}:draft`}
          depth={depth}
          draft={draft}
          onChange={(value) => setDraft({ ...draft, value })}
          onCommit={() => void commitDraft()}
          onCancel={() => setDraft(null)}
        />
      )
    }

    if (dir.loading && dir.entries.length === 0) {
      rows.push(
        <p key={`${path}:loading`} style={indent(depth)} className={cn(ROW, "text-muted-foreground/60")}>
          Loading…
        </p>
      )
    } else if (!dir.loading && entries.length === 0 && !draft) {
      rows.push(
        <p key={`${path}:empty`} style={indent(depth)} className={cn(ROW, "text-muted-foreground/60")}>
          {query ? "No matches" : "Empty"}
        </p>
      )
    }

    if (dir.truncated) {
      rows.push(
        <p
          key={`${path}:truncated`}
          style={indent(depth)}
          className={cn(ROW, "text-muted-foreground/60")}
          title="This directory has more entries than the server will list at once."
        >
          … more, not shown
        </p>
      )
    }

    return rows
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        This project no longer exists.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-1.5 py-1">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter"
            aria-label="Filter files"
            className="h-7 ps-6 pe-6 text-xs"
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
          className="size-6"
          onClick={() => setDraft({ kind: "create-file", dir: "", value: "" })}
        >
          <FilePlusIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="New folder"
          className="size-6"
          onClick={() => setDraft({ kind: "create-dir", dir: "", value: "" })}
        >
          <FolderPlusIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          className="size-6"
          onClick={() => setShowHidden((current) => !current)}
        >
          {showHidden ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Refresh" className="size-6" onClick={refresh}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">{renderDir("", 0)}</div>
    </div>
  )
}

const indent = (depth: number): React.CSSProperties => ({ paddingLeft: `${depth * 12 + 4}px` })

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
