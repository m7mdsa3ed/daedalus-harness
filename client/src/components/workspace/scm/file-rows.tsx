/* ── The status list ──
   A group of changed files and the rows under it, in either shape.

   **A working set is a tree, and the reader chooses.** Twelve files across four
   directories is unreadable as twelve full paths in a 320px column, so the tree
   is the default and single-child chains fold into one row (`src/lib/ide`
   rather than three rows holding one child each). The list is one toggle away
   and is remembered per device (`lib/ide/prefs.ts`), because how a set of files
   is *read* is a property of the reader and not of the panel.

   Nothing here reads or writes: a row reports the paths it is about and the
   section above owns the request, because every read and write names its
   repository and a row does not know which one it is in. */
import * as React from "react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  Folder01Icon,
  MinusSignIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { IconAction, markOf, type Row, type Side } from "@/components/workspace/scm/shared"
import type { FileLayout } from "@/lib/ide/prefs"
import { cn } from "@/lib/utils"
import { basename } from "@/lib/workspace/fs-api"
import type { GitFileState } from "@/lib/workspace/git-api"
import {
  buildPathTree,
  countFiles,
  filesUnder,
  type PathDirNode,
  type PathFileNode,
} from "@/lib/workspace/git-tree"

type Tree = PathDirNode<Row>
type Leaf = PathFileNode<Row>

const LABEL: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Conflict",
  "?": "Untracked",
}

const MARK_CLASS: Record<string, string> = {
  A: "text-emerald-600 dark:text-emerald-400",
  "?": "text-emerald-600 dark:text-emerald-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-600 dark:text-red-400",
  U: "text-red-600 dark:text-red-400",
  R: "text-sky-600 dark:text-sky-400",
}

/* ── One group of rows ──
   Staged, changed, untracked, conflicted. The group is where the tree is built,
   because a file can be in two groups at once (staged *and* changed) and one
   tree over both would have to say which of the two a row was.

   Memoized, and the section above hands it callbacks that are memoized too:
   its props do not change while a commit message is being typed, and without
   this every keystroke in that textarea re-rendered every row and rebuilt
   every path tree. A watch tick brings a new status and so a new `rows`, which
   is a miss — as it should be, since the rows really did change. */
export const Group = React.memo(function Group({
  title,
  side,
  rows,
  layout,
  coarse,
  busy,
  collapsedDirs,
  dirKey,
  onToggleDir,
  onOpen,
  onStage,
  onDiscard,
}: {
  title: string
  side: Side
  rows: Row[]
  layout: FileLayout
  coarse: boolean
  busy: boolean
  collapsedDirs: ReadonlySet<string>
  dirKey: (path: string) => string
  onToggleDir: (path: string) => void
  onOpen: (file: GitFileState, side: Side) => void
  onStage: (paths: string[]) => void
  onDiscard: (paths: string[], what: string) => void
}) {
  const tree = React.useMemo(
    () => (layout === "tree" ? buildPathTree(rows, (row) => row.file.path, { compact: true }) : null),
    [layout, rows]
  )

  const header = (
    <div
      className={cn(
        "flex items-center gap-1 px-1 text-[11px] font-medium text-muted-foreground",
        coarse ? "min-h-10" : "min-h-7"
      )}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="font-mono tabular-nums opacity-70">{rows.length}</span>
      {side !== "index" && (
        <IconAction
          label={`Discard all in ${title.toLowerCase()}`}
          icon={ArrowTurnBackwardIcon}
          disabled={busy}
          className="hover:text-destructive"
          onClick={() =>
            onDiscard(
              rows.map((row) => row.file.path),
              `${rows.length} ${rows.length === 1 ? "file" : "files"}`
            )
          }
        />
      )}
      <IconAction
        label={side === "index" ? "Unstage all" : "Stage all"}
        icon={side === "index" ? MinusSignIcon : PlusSignIcon}
        disabled={busy}
        onClick={() => onStage(rows.map((row) => row.file.path))}
      />
    </div>
  )

  return (
    <div className="mb-1">
      {header}
      {tree ? (
        <TreeRows
          node={tree}
          depth={0}
          side={side}
          coarse={coarse}
          busy={busy}
          collapsedDirs={collapsedDirs}
          dirKey={dirKey}
          onToggleDir={onToggleDir}
          onOpen={onOpen}
          onStage={onStage}
          onDiscard={onDiscard}
        />
      ) : (
        rows.map((row) => (
          <FileRow
            key={row.file.path}
            row={row}
            depth={0}
            showDir
            coarse={coarse}
            busy={busy}
            onOpen={onOpen}
            onStage={onStage}
            onDiscard={onDiscard}
          />
        ))
      )}
    </div>
  )
})

function TreeRows({
  node,
  depth,
  side,
  coarse,
  busy,
  collapsedDirs,
  dirKey,
  onToggleDir,
  onOpen,
  onStage,
  onDiscard,
}: {
  node: Tree
  depth: number
  side: Side
  coarse: boolean
  busy: boolean
  collapsedDirs: ReadonlySet<string>
  dirKey: (path: string) => string
  onToggleDir: (path: string) => void
  onOpen: (file: GitFileState, side: Side) => void
  onStage: (paths: string[]) => void
  onDiscard: (paths: string[], what: string) => void
}) {
  return (
    <>
      {node.dirs.map((dir) => {
        const collapsed = collapsedDirs.has(dirKey(dir.path))
        const under = filesUnder(dir).map((leaf) => leaf.item.file.path)
        return (
          <React.Fragment key={dir.path}>
            <div
              className={cn(
                "group flex items-center gap-1 rounded-md pr-1 text-xs text-muted-foreground hover:bg-accent/40",
                coarse ? "min-h-11" : "min-h-7"
              )}
              style={indent(depth)}
            >
              <button
                type="button"
                onClick={() => onToggleDir(dir.path)}
                aria-expanded={!collapsed}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                title={dir.path}
              >
                <HugeiconsIcon
                  icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
                  strokeWidth={2}
                  className="size-3.5 shrink-0"
                />
                <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono">{dir.name}</span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-60">
                  {countFiles(dir)}
                </span>
              </button>
              {/* A folder acts on everything under it — the reason the tree is
                  worth having on a phone, where twelve taps is not a plan. */}
              <RowActions coarse={coarse}>
                {side !== "index" && (
                  <IconAction
                    label={`Discard everything in ${dir.name}`}
                    icon={ArrowTurnBackwardIcon}
                    disabled={busy}
                    className="hover:text-destructive"
                    onClick={() => onDiscard(under, dir.name)}
                  />
                )}
                <IconAction
                  label={side === "index" ? `Unstage ${dir.name}` : `Stage ${dir.name}`}
                  icon={side === "index" ? MinusSignIcon : PlusSignIcon}
                  disabled={busy}
                  onClick={() => onStage(under)}
                />
              </RowActions>
            </div>
            {!collapsed && (
              <TreeRows
                node={dir}
                depth={depth + 1}
                side={side}
                coarse={coarse}
                busy={busy}
                collapsedDirs={collapsedDirs}
                dirKey={dirKey}
                onToggleDir={onToggleDir}
                onOpen={onOpen}
                onStage={onStage}
                onDiscard={onDiscard}
              />
            )}
          </React.Fragment>
        )
      })}
      {node.files.map((leaf: Leaf) => (
        <FileRow
          key={leaf.path}
          row={leaf.item}
          depth={depth}
          coarse={coarse}
          busy={busy}
          onOpen={onOpen}
          onStage={onStage}
          onDiscard={onDiscard}
        />
      ))}
    </>
  )
}

function FileRow({
  row,
  depth,
  showDir,
  coarse,
  busy,
  onOpen,
  onStage,
  onDiscard,
}: {
  row: Row
  depth: number
  /** The list layout prints the directory beside the name; the tree drew it. */
  showDir?: boolean
  coarse: boolean
  busy: boolean
  onOpen: (file: GitFileState, side: Side) => void
  onStage: (paths: string[]) => void
  onDiscard: (paths: string[], what: string) => void
}) {
  const { file, side } = row
  const mark = markOf(file, side)
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 text-xs hover:bg-accent/50",
        coarse ? "min-h-11" : "min-h-7"
      )}
      style={indent(depth)}
    >
      <button
        type="button"
        onClick={() => onOpen(file, side)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        title={`${LABEL[mark] ?? "Changed"} · ${file.from ? `${file.from} → ${file.path}` : file.path}`}
      >
        <span className={cn("min-w-0 truncate", mark === "D" && "line-through opacity-70")}>
          {basename(file.path)}
        </span>
        {showDir && dir && (
          <span className="hidden min-w-0 shrink truncate text-[10px] text-muted-foreground @panel-sm:block">
            {dir}
          </span>
        )}
        <span className="flex-1" />
        <span className={cn("w-3 shrink-0 text-center font-mono", MARK_CLASS[mark] ?? "text-muted-foreground")}>
          {mark}
        </span>
      </button>
      <RowActions coarse={coarse}>
        {side !== "index" && mark !== "D" && (
          <IconAction
            label="Discard"
            icon={ArrowTurnBackwardIcon}
            disabled={busy}
            className="hover:text-destructive"
            onClick={() => onDiscard([file.path], basename(file.path))}
          />
        )}
        <IconAction
          label={side === "index" ? "Unstage" : "Stage"}
          icon={side === "index" ? MinusSignIcon : PlusSignIcon}
          disabled={busy}
          onClick={() => onStage([file.path])}
        />
      </RowActions>
    </div>
  )
}

/** Row actions: revealed on hover with a mouse, **always shown** on a finger —
    there is no hover to reveal them with, and a button you have to long-press
    to discover is a button that is not there. */
function RowActions({ coarse, children }: { coarse: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center transition-opacity",
        !coarse && "opacity-0 group-hover:opacity-100 has-focus-visible:opacity-100"
      )}
    >
      {children}
    </div>
  )
}

const indent = (depth: number): React.CSSProperties => ({ paddingLeft: `${depth * 12 + 4}px` })
