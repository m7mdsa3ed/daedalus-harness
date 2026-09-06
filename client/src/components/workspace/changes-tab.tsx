/* ── What a turn did ──
   The tab behind the transcript's "N files changed" chip: a turn's files, or
   everything uncommitted, each one openable as a diff.

   What changed is **git's** answer and never the transcript's — the server
   photographs the worktree as a tree at `turn_started` and `turn_ended`, so a
   `sed` in a shell and an Edit tool are measured the same way (server
   `turn-changes.ts`). Both sides of a file come from that scope's own route:
   the before side is the start tree, the after side is the end tree once the
   turn has ended and the **working file itself** while it is still running, so
   a running turn's diff is live.

   The file list is a tree by default — twelve files across four directories is
   unreadable as twelve full paths — with the same tree/list toggle the
   source-control view has, remembered separately because reviewing a turn and
   staging a working set are different readings of a file list. Staging and
   committing are not here: they belong to the working tree as it is now, which
   is the source-control view's subject, not this one's. */
import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Folder01Icon,
  FolderTreeIcon,
  ListIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DiffEditor } from "@/components/workspace/diff-editor"
import { PanelEmptyState, PanelNotice, PanelToolbar } from "@/components/workspace/primitives"
import { useCoarsePointer } from "@/hooks/use-mobile"
import { describeError } from "@/lib/errors"
import { idePrefs, setIdePref } from "@/lib/ide/prefs"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { buildTree, countFiles, type DirNode, type FileNode } from "@/lib/workspace/git-tree"
import { changeFileSide, changedFiles, type ChangedFile } from "@/lib/workspace/git-api"

const STATUS_MARK: Record<ChangedFile["status"], { mark: string; className: string }> = {
  added: { mark: "A", className: "text-emerald-600 dark:text-emerald-400" },
  modified: { mark: "M", className: "text-amber-600 dark:text-amber-400" },
  deleted: { mark: "D", className: "text-red-600 dark:text-red-400" },
  renamed: { mark: "R", className: "text-sky-600 dark:text-sky-400" },
}

export function ChangesTab({ sessionId, scope }: { sessionId: string; scope: string }) {
  const settings = useServer()
  const layout = idePrefs.use().changesLayout
  const coarse = useCoarsePointer()

  const [files, setFiles] = React.useState<ChangedFile[]>([])
  const [unavailable, setUnavailable] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set())
  /* On a phone the list and the diff cannot share the height, so the list is
     the whole tab until a file is picked and the diff is the whole tab after —
     with the toolbar's "Files" taking you back. */
  const [showList, setShowList] = React.useState(true)

  React.useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    changedFiles(settings, sessionId, scope, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setFiles(result.files)
        setUnavailable(result.unavailable ?? null)
        setError(null)
        setSelected((current) =>
          current && result.files.some((file) => file.path === current)
            ? current
            : (result.files[0]?.path ?? null)
        )
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err).title)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [settings, sessionId, scope])

  const tree = React.useMemo(
    () => (layout === "tree" ? buildTree(files, { compact: true }) : null),
    [files, layout]
  )
  const selectedFile = files.find((file) => file.path === selected) ?? null

  const totals = files.reduce(
    (acc, file) => ({ add: acc.add + file.additions, del: acc.del + file.deletions }),
    { add: 0, del: 0 }
  )

  if (unavailable) return <PanelEmptyState>{unavailable}</PanelEmptyState>
  if (error) return <PanelEmptyState>{error}</PanelEmptyState>
  if (loading && files.length === 0) return <PanelEmptyState>Reading what changed…</PanelEmptyState>
  if (files.length === 0)
    return (
      <PanelEmptyState>
        {scope === "uncommitted" ? "Nothing is uncommitted." : "This turn changed nothing on disk."}
      </PanelEmptyState>
    )

  const pick = (path: string) => {
    setSelected(path)
    setShowList(false)
  }

  const rows = (
    <div className="p-1">
      {tree ? (
        <TreeRows
          node={tree}
          depth={0}
          coarse={coarse}
          collapsed={collapsed}
          selected={selected}
          onSelect={pick}
          onToggleDir={(path) =>
            setCollapsed((current) => {
              const next = new Set(current)
              if (next.has(path)) next.delete(path)
              else next.add(path)
              return next
            })
          }
        />
      ) : (
        files.map((file) => (
          <Row
            key={file.path}
            file={file}
            name={file.path}
            depth={0}
            coarse={coarse}
            selected={selected === file.path}
            onSelect={pick}
          />
        ))
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        {/* Below the panel's medium width the list and the diff take turns,
            and this is the way back to the list. */}
        <Button
          variant="ghost"
          size="xs"
          className={cn("@panel-md:hidden", showList && "invisible")}
          onClick={() => setShowList(true)}
        >
          ‹ Files
        </Button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {scope === "uncommitted" ? "Uncommitted changes" : "Turn changes"}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {files.length} {files.length === 1 ? "file" : "files"}{" "}
          <span className="text-emerald-600 dark:text-emerald-400">+{totals.add}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{totals.del}</span>
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className={coarse ? "size-11" : "size-6"}
                aria-label={layout === "tree" ? "View as a list" : "View as a tree"}
                onClick={() => setIdePref("changesLayout", layout === "tree" ? "list" : "tree")}
              >
                <HugeiconsIcon icon={layout === "tree" ? FolderTreeIcon : ListIcon} strokeWidth={2} className="size-3.5" />
              </Button>
            }
          />
          <TooltipContent>{layout === "tree" ? "View as a list" : "View as a tree"}</TooltipContent>
        </Tooltip>
      </PanelToolbar>

      <div className="flex min-h-0 flex-1 flex-col @panel-md:flex-row">
        <ScrollArea
          className={cn(
            "min-h-0 flex-1 @panel-md:w-60 @panel-md:flex-none @panel-md:border-r @panel-md:border-border/60",
            !showList && "hidden @panel-md:block"
          )}
        >
          {rows}
        </ScrollArea>
        <div className={cn("min-h-0 flex-1", showList && "hidden @panel-md:block")}>
          {selectedFile ? (
            <ChangedFileDiff sessionId={sessionId} scope={scope} file={selectedFile} />
          ) : (
            <PanelEmptyState>Pick a file to see what changed in it.</PanelEmptyState>
          )}
        </div>
      </div>
    </div>
  )
}

function ChangedFileDiff({
  sessionId,
  scope,
  file,
}: {
  sessionId: string
  scope: string
  file: ChangedFile
}) {
  const settings = useServer()
  const [sides, setSides] = React.useState<{ before: string; after: string } | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    setSides(null)
    Promise.all([
      /* A rename is one file with two names; the before side is the old one. */
      file.status === "added"
        ? Promise.resolve({ content: "", missing: true })
        : changeFileSide(settings, sessionId, scope, file.from ?? file.path, "before", controller.signal),
      file.status === "deleted"
        ? Promise.resolve({ content: "", missing: true })
        : changeFileSide(settings, sessionId, scope, file.path, "after", controller.signal),
    ])
      .then(([before, after]) => {
        if (controller.signal.aborted) return
        setSides({ before: before.content, after: after.content })
        setError(null)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err).title)
      })
    return () => controller.abort()
  }, [settings, sessionId, scope, file.path, file.from, file.status])

  if (file.binary) return <PanelEmptyState>{file.path} is binary, so there is nothing to read here.</PanelEmptyState>
  if (error) return <PanelEmptyState>{error}</PanelEmptyState>
  if (!sides) return <PanelEmptyState>Reading both sides…</PanelEmptyState>

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelNotice className="font-mono">{file.from ? `${file.from} → ${file.path}` : file.path}</PanelNotice>
      <div className="min-h-0 flex-1 overflow-hidden">
        <DiffEditor original={sides.before} modified={sides.after} filename={file.path} />
      </div>
    </div>
  )
}

function TreeRows({
  node,
  depth,
  coarse,
  collapsed,
  selected,
  onSelect,
  onToggleDir,
}: {
  node: DirNode
  depth: number
  coarse: boolean
  collapsed: ReadonlySet<string>
  selected: string | null
  onSelect: (path: string) => void
  onToggleDir: (path: string) => void
}) {
  return (
    <>
      {node.dirs.map((dir) => {
        const isCollapsed = collapsed.has(dir.path)
        return (
          <React.Fragment key={dir.path}>
            <button
              type="button"
              onClick={() => onToggleDir(dir.path)}
              aria-expanded={!isCollapsed}
              title={dir.path}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md pr-1 text-left text-xs text-muted-foreground hover:bg-accent/50",
                coarse ? "min-h-11" : "min-h-7"
              )}
              style={indent(depth)}
            >
              <HugeiconsIcon
                icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                strokeWidth={2}
                className="size-3.5 shrink-0"
              />
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono">{dir.name}</span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-60">{countFiles(dir)}</span>
            </button>
            {!isCollapsed && (
              <TreeRows
                node={dir}
                depth={depth + 1}
                coarse={coarse}
                collapsed={collapsed}
                selected={selected}
                onSelect={onSelect}
                onToggleDir={onToggleDir}
              />
            )}
          </React.Fragment>
        )
      })}
      {node.files.map((leaf: FileNode) => (
        <Row
          key={leaf.path}
          file={leaf.item}
          name={leaf.name}
          depth={depth}
          coarse={coarse}
          selected={selected === leaf.path}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

function Row({
  file,
  name,
  depth,
  coarse,
  selected,
  onSelect,
}: {
  file: ChangedFile
  /** The bare name in the tree; the whole path in the list. */
  name: string
  depth: number
  coarse: boolean
  selected: boolean
  onSelect: (path: string) => void
}) {
  const mark = STATUS_MARK[file.status]
  return (
    <button
      type="button"
      onClick={() => onSelect(file.path)}
      title={file.from ? `${file.from} → ${file.path}` : file.path}
      style={indent(depth)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md pr-1 text-left text-xs hover:bg-accent/50",
        coarse ? "min-h-11" : "min-h-7",
        selected && "bg-accent"
      )}
    >
      <span className={cn("w-3 shrink-0 font-mono", mark.className)}>{mark.mark}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {file.binary ? "bin" : `+${file.additions} −${file.deletions}`}
      </span>
    </button>
  )
}

const indent = (depth: number): React.CSSProperties => ({ paddingLeft: `${depth * 12 + 4}px` })
