/* ── The project's working tree, beside the preview ──
   The left half of the Preview panel: what the project's cwd actually holds,
   read through the project's own file routes, so clicking a name opens that
   file in the preview without anything being invented on the client.

   A directory is asked for when it is first opened and never again unless the
   watch stream says something under it moved (`watchProject` invalidates the
   tree family, which re-reads only the branches on screen). Opening a file from
   a mention reveals it here — every ancestor opens itself, the same courtesy
   the library's folder tree pays the folder you are in.

   The find box is the route the composer's `@` menu already reads, asked from
   here as well: an explorer is only navigable if a name can be jumped to, and a
   cwd with a `node_modules` in it is not browsable at all without one. It lists
   matches across the whole project, including what the tree is not showing.

   Dotfiles and git-ignored directories are off until the reader asks for them
   with the two toggles — the server hides both by default and the choice here
   is the caller's, stated in the request rather than in a second, silent
   exclude list. */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  PackageIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"

import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { previewPrefs, setPreviewPrefs } from "@/lib/preview-prefs"
import { projectTreeFamilyKey } from "@/lib/queries/keys"
import { useProjectTree, type TreeFlags } from "@/lib/queries/workspace-tree"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { dirname, searchFiles, type WorkspaceEntry } from "@/lib/workspace/fs-api"
import { watchProject } from "@/lib/workspace/watch"

/** One row: the library explorer's measurements, so the two trees read alike. */
const ROW =
  "group flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-sm outline-none pointer-coarse:h-9"
const ROW_STATE =
  "hover:bg-muted focus-visible:bg-muted focus-visible:ring-[2px] focus-visible:ring-ring/50 aria-selected:bg-muted aria-selected:font-medium"
/** One level of nesting: the chevron slot (20) plus the gap (4), from a 4px inset. */
const indent = (depth: number) => depth * 24 + 4

/** The file's own line, drawn the same way in the tree and in the find results. */
function FileMark({ type, open }: { type: "dir" | "file"; open?: boolean }) {
  const Icon = type === "dir" ? (open ? FolderOpenIcon : FolderIcon) : FileIcon
  return <Icon className={cn("size-4 shrink-0", type === "dir" ? "text-primary" : "text-muted-foreground")} />
}

export function ProjectFiles({
  projectId,
  selected,
  onOpen,
}: {
  projectId: string
  /** The path the preview is showing — highlighted, and revealed on arrival. */
  selected?: string
  onOpen: (path: string) => void
}) {
  const prefs = previewPrefs.use()
  const flags = React.useMemo<TreeFlags>(() => ({ hidden: prefs.hidden, ignored: prefs.ignored }), [prefs.hidden, prefs.ignored])
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = React.useState("")
  const [needle, setNeedle] = React.useState("")
  const tree = React.useRef<HTMLDivElement>(null)
  const settings = useServer()
  const client = useQueryClient()

  /* A keystroke is not a search: the route walks the project, so the box waits. */
  React.useEffect(() => {
    const timer = setTimeout(() => setNeedle(query.trim()), 200)
    return () => clearTimeout(timer)
  }, [query])

  /* The watch stream says *that* something moved, not which listing it moved
     in, and only the open directories are mounted — invalidating the family
     re-reads what is on screen and nothing else. Coalesced, because a build
     writes in bursts. */
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = watchProject(projectId, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () => void client.invalidateQueries({ queryKey: projectTreeFamilyKey(settings, projectId) }),
        300
      )
    })
    return () => {
      if (timer) clearTimeout(timer)
      stop()
    }
  }, [client, projectId, settings])

  /* Reveal the previewed file: every ancestor opens, once. Read, not watched —
     collapsing a directory by hand has to stick. */
  React.useEffect(() => {
    if (!selected) return
    const parts = selected.split("/").slice(0, -1)
    if (parts.length === 0) return
    setOpen((prev) => {
      const missing = parts.map((_, i) => parts.slice(0, i + 1).join("/")).filter((dir) => !prev.has(dir))
      return missing.length ? new Set([...prev, ...missing]) : prev
    })
  }, [selected])

  /* …and it is scrolled to, so opening a file from a mention lands the tree on
     it rather than leaving it somewhere below the fold. */
  React.useEffect(() => {
    if (!selected) return
    tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" })
  }, [selected, open])

  const toggle = React.useCallback(
    (path: string) =>
      setOpen((prev) => {
        const next = new Set(prev)
        if (!next.delete(path)) next.add(path)
        return next
      }),
    []
  )

  /** A folder found by name is opened in the tree rather than in the preview —
      the answer to "where is it" is the tree, not a viewer that cannot show a
      folder. */
  const reveal = React.useCallback((path: string) => {
    const parts = path.split("/")
    setQuery("")
    setNeedle("")
    setOpen((prev) => new Set([...prev, ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))]))
  }, [])

  const results = useQuery({
    queryKey: projectTreeFamilyKey(settings, projectId).concat(["find", needle]),
    queryFn: ({ signal }) => searchFiles(projectId, needle, { limit: 60, signal }),
    enabled: needle.length > 0,
    staleTime: 30_000,
  })

  /* Arrow keys walk the rows the way they walk a tree; ← and → fold out and in.
     Row focus is the DOM's, so nothing here holds an index that a re-read could
     invalidate. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
    const index = rows.indexOf(event.target as HTMLElement)
    const at = index >= 0 ? rows[index] : undefined
    const path = at?.dataset.path
    const focus = (next: HTMLElement | undefined) => {
      if (!next) return
      event.preventDefault()
      next.focus()
    }
    const level = (row: HTMLElement) => Number(row.getAttribute("aria-level") ?? 1)
    switch (event.key) {
      case "ArrowDown":
        return focus(rows[Math.min(rows.length - 1, index + 1)])
      case "ArrowUp":
        return focus(rows[Math.max(0, index - 1)])
      case "Home":
        return focus(rows[0])
      case "End":
        return focus(rows.at(-1))
      case "ArrowRight":
        if (!path || at?.dataset.type !== "dir") return
        event.preventDefault()
        return open.has(path) ? focus(rows[index + 1]) : toggle(path)
      case "ArrowLeft": {
        if (!path || !at) return
        event.preventDefault()
        if (at.dataset.type === "dir" && open.has(path)) return toggle(path)
        for (let i = index - 1; i >= 0; i--) if (level(rows[i]) < level(at)) return focus(rows[i])
        return
      }
      case "Enter":
      case " ":
        if (!path || !at) return
        event.preventDefault()
        return at.dataset.type === "dir" ? toggle(path) : onOpen(path)
    }
  }

  const row = (entry: WorkspaceEntry, depth: number) => {
    const expanded = entry.type === "dir" && open.has(entry.path)
    return (
      <button
        type="button"
        role="treeitem"
        data-path={entry.path}
        data-type={entry.type}
        aria-level={depth + 1}
        aria-selected={entry.path === selected}
        aria-expanded={entry.type === "dir" ? expanded : undefined}
        title={entry.path}
        style={{ paddingLeft: indent(depth) }}
        className={cn(ROW, ROW_STATE)}
        onClick={() => (entry.type === "dir" ? toggle(entry.path) : onOpen(entry.path))}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {entry.type === "dir" && (
            <ChevronRightIcon className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
          )}
        </span>
        <FileMark type={entry.type} open={expanded} />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex min-h-8 shrink-0 items-center gap-1 border-b px-1 py-1">
        <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-muted-foreground">Files</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-pressed={prefs.hidden}
          title={prefs.hidden ? "Hide dotfiles" : "Show dotfiles"}
          onClick={() => setPreviewPrefs({ hidden: !prefs.hidden })}
        >
          {prefs.hidden ? <EyeIcon /> : <EyeOffIcon />}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-pressed={prefs.ignored}
          title={
            prefs.ignored
              ? "Hide ignored files (node_modules, build output)"
              : "Show ignored files (node_modules, build output)"
          }
          onClick={() => setPreviewPrefs({ ignored: !prefs.ignored })}
        >
          <PackageIcon />
        </Button>
      </div>

      <div className="border-b p-1">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query) return
              event.stopPropagation()
              setQuery("")
            }}
            placeholder="Find a file"
            aria-label="Find a file in this project"
            className="h-7 text-xs"
          />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" title="Clear" onClick={() => setQuery("")}>
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>

      <div
        ref={tree}
        role={needle ? undefined : "tree"}
        aria-label="Project files"
        onKeyDown={needle ? undefined : onKeyDown}
        className="min-h-0 flex-1 overflow-auto p-1 outline-none"
      >
        {needle ? (
          results.isPending ? (
            <Rows depth={0} />
          ) : results.error ? (
            <Note>The project could not be searched.</Note>
          ) : (results.data?.entries.length ?? 0) === 0 ? (
            <Empty size="sm">Nothing here is named like “{needle}”.</Empty>
          ) : (
            results.data?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                title={entry.path}
                onClick={() => (entry.type === "dir" ? reveal(entry.path) : onOpen(entry.path))}
                className={cn(ROW, ROW_STATE, "px-2")}
              >
                <FileMark type={entry.type} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                  {dirname(entry.path) || "project root"}
                </span>
              </button>
            ))
          )
        ) : (
          <Level projectId={projectId} path="" depth={0} flags={flags} open={open} row={row} />
        )}
      </div>
    </div>
  )
}

/** One directory's entries, and below them the directories that are open. The
    recursion is a component because each level owns a read of its own; how a row
    is drawn is the caller's (`row`), so nothing else has to be threaded down. */
function Level({
  projectId,
  path,
  depth,
  flags,
  open,
  row,
}: {
  projectId: string
  path: string
  depth: number
  flags: TreeFlags
  open: ReadonlySet<string>
  row: (entry: WorkspaceEntry, depth: number) => React.ReactNode
}) {
  const listing = useProjectTree(projectId, path, flags)
  if (listing.isPending) return <Rows depth={depth} />
  if (listing.error) return <Note depth={depth}>This folder could not be read.</Note>
  const entries = listing.data?.entries ?? []
  if (entries.length === 0) return <Note depth={depth}>This folder is empty.</Note>
  return (
    <>
      {entries.map((entry) => (
        <React.Fragment key={entry.path}>
          {row(entry, depth)}
          {entry.type === "dir" && open.has(entry.path) && (
            <Level projectId={projectId} path={entry.path} depth={depth + 1} flags={flags} open={open} row={row} />
          )}
        </React.Fragment>
      ))}
      {listing.data?.truncated && <Note depth={depth}>This folder holds more than is listed.</Note>}
    </>
  )
}

function Rows({ depth }: { depth: number }) {
  return (
    <div className="flex flex-col gap-1 py-1" style={{ paddingLeft: indent(depth) }}>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-5 w-3/4" />
      ))}
    </div>
  )
}

function Note({ children, depth = 0 }: { children: React.ReactNode; depth?: number }) {
  return (
    <p style={{ paddingLeft: indent(depth) }} className="py-1 pr-2 text-xs text-muted-foreground">
      {children}
    </p>
  )
}
