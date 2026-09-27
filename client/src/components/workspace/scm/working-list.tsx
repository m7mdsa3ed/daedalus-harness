/* ── The working set, grouped ──
   VS Code's source control list: "Merge Changes", "Staged Changes" and
   "Changes", each a collapsible header over its files (`scmGroups` in
   `lib/workspace/working-set.ts` has why this replaced the one ticked list).

   **The verb is on the row, and the group says which verb.** A staged row
   offers − (unstage); a changed row offers ↺ (discard) and + (stage); a
   conflicted row offers + (mark resolved). A header offers the same verbs
   for everything under it, and so does a folder.

   One scroller, windowed (`hooks/use-windowed-rows.ts`) over one flat array —
   headers included — so a rebase with two thousand changed paths costs the
   rows on screen rather than two thousand. */
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

import { IconAction } from "@/components/workspace/scm/shared"
import { useWindowedRows } from "@/hooks/use-windowed-rows"
import { cn } from "@/lib/utils"
import { basename } from "@/lib/workspace/fs-api"
import {
  WORK_ROW_HEIGHT,
  WORK_ROW_HEIGHT_COARSE,
  type GroupId,
  type ScmRow,
  type WorkingFile,
} from "@/lib/workspace/working-set"

export const MARK_CLASS: Record<string, string> = {
  A: "text-emerald-600 dark:text-emerald-400",
  "?": "text-emerald-600 dark:text-emerald-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-600 dark:text-red-400",
  U: "text-red-600 dark:text-red-400",
  R: "text-sky-600 dark:text-sky-400",
}

const indent = (depth: number): React.CSSProperties => ({ paddingLeft: `${depth * 12 + 16}px` })

/** Everything a row can do, as one stable object — so the rows' `React.memo`
    hits while a commit message is being typed above them. */
export interface WorkActions {
  onOpen: (file: WorkingFile, group: GroupId) => void
  /** `key` is `group:path` — a folder's collapse is per group. */
  onToggleDir: (key: string) => void
  onToggleGroup: (group: GroupId) => void
  /** `stage` false means unstage. Headers and folders hand up everything under them. */
  onStage: (paths: string[], stage: boolean) => void
  onDiscard: (paths: string[], what: string, untracked: boolean) => void
}

export function WorkingList({
  rows,
  collapsedDirs,
  collapsedGroups,
  coarse,
  busy,
  actions,
}: {
  rows: ScmRow[]
  collapsedDirs: ReadonlySet<string>
  collapsedGroups: ReadonlySet<GroupId>
  coarse: boolean
  busy: boolean
  actions: WorkActions
}) {
  const lineHeight = coarse ? WORK_ROW_HEIGHT_COARSE : WORK_ROW_HEIGHT
  const win = useWindowedRows({ rows, lineHeight })

  return (
    <div ref={win.ref} className="min-h-0 flex-1 overflow-auto px-1 py-1">
      <div style={{ height: win.padTop }} />
      {rows.slice(win.start, win.end).map((row) =>
        row.kind === "group" ? (
          <GroupRow
            key={row.key}
            row={row}
            collapsed={collapsedGroups.has(row.group)}
            coarse={coarse}
            busy={busy}
            actions={actions}
          />
        ) : row.kind === "dir" ? (
          <DirRow
            key={row.key}
            row={row}
            collapsed={collapsedDirs.has(`${row.group}:${row.path}`)}
            coarse={coarse}
            busy={busy}
            actions={actions}
          />
        ) : (
          <FileRow key={row.key} row={row} coarse={coarse} busy={busy} actions={actions} />
        )
      )}
      <div style={{ height: win.padBottom }} />
    </div>
  )
}

/** The verbs a group offers, for one path or a set of them. The same buttons
    on a header, a folder and a file — only what they apply to changes. */
function Verbs({
  group,
  paths,
  what,
  untracked,
  busy,
  actions,
}: {
  group: GroupId
  paths: string[]
  what: string
  untracked: boolean
  busy: boolean
  actions: WorkActions
}) {
  if (group === "staged")
    return (
      <IconAction
        label={`Unstage ${what}`}
        icon={MinusSignIcon}
        disabled={busy}
        onClick={() => actions.onStage(paths, false)}
      />
    )
  return (
    <>
      {group === "changes" && (
        <IconAction
          label={untracked ? `Delete ${what}` : `Discard ${what}`}
          icon={ArrowTurnBackwardIcon}
          disabled={busy}
          className="hover:text-destructive"
          onClick={() => actions.onDiscard(paths, what, untracked)}
        />
      )}
      <IconAction
        label={group === "merge" ? `Mark ${what} resolved` : `Stage ${what}`}
        icon={PlusSignIcon}
        disabled={busy}
        onClick={() => actions.onStage(paths, true)}
      />
    </>
  )
}

const GroupRow = React.memo(function GroupRow({
  row,
  collapsed,
  coarse,
  busy,
  actions,
}: {
  row: Extract<ScmRow, { kind: "group" }>
  collapsed: boolean
  coarse: boolean
  busy: boolean
  actions: WorkActions
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 pl-0.5 text-[11px] font-semibold text-muted-foreground hover:bg-accent/40",
        coarse ? "min-h-11" : "min-h-7"
      )}
    >
      <button
        type="button"
        onClick={() => actions.onToggleGroup(row.group)}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left"
      >
        <HugeiconsIcon
          icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
          strokeWidth={2}
          className="size-3.5 shrink-0"
        />
        <span className="min-w-0 truncate">{row.title}</span>
      </button>
      <RowActions coarse={coarse}>
        <Verbs
          group={row.group}
          paths={row.paths}
          what={`all ${row.count}`}
          untracked={row.untracked}
          busy={busy}
          actions={actions}
        />
      </RowActions>
      <span className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 tabular-nums">
        {row.count}
      </span>
    </div>
  )
})

const DirRow = React.memo(function DirRow({
  row,
  collapsed,
  coarse,
  busy,
  actions,
}: {
  row: Extract<ScmRow, { kind: "dir" }>
  collapsed: boolean
  coarse: boolean
  busy: boolean
  actions: WorkActions
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md pr-1 text-xs text-muted-foreground hover:bg-accent/40",
        coarse ? "min-h-11" : "min-h-7"
      )}
      style={indent(row.depth)}
    >
      <button
        type="button"
        onClick={() => actions.onToggleDir(`${row.group}:${row.path}`)}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
        title={row.path}
      >
        <HugeiconsIcon
          icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
          strokeWidth={2}
          className="size-3.5 shrink-0"
        />
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">{row.name}</span>
      </button>
      <RowActions coarse={coarse}>
        <Verbs
          group={row.group}
          paths={row.paths}
          what={`everything in ${row.name}`}
          untracked={false}
          busy={busy}
          actions={actions}
        />
      </RowActions>
      <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-60">{row.count}</span>
    </div>
  )
})

const FileRow = React.memo(function FileRow({
  row,
  coarse,
  busy,
  actions,
}: {
  row: Extract<ScmRow, { kind: "file" }>
  coarse: boolean
  busy: boolean
  actions: WorkActions
}) {
  const { file } = row
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""
  const name = basename(file.path)
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md pr-1 text-xs hover:bg-accent/50",
        file.conflicted && "bg-destructive/5",
        coarse ? "min-h-11" : "min-h-7"
      )}
      style={indent(row.depth)}
    >
      <button
        type="button"
        onClick={() => actions.onOpen(file, row.group)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        title={`${file.mark} · ${file.from ? `${file.from} → ${file.path}` : file.path}`}
      >
        <span className={cn("min-w-0 truncate", file.mark === "D" && "line-through opacity-70")}>
          {name}
        </span>
        {/* In the flat layout the row has no tree above it to say where the
            file lives, so it says so itself where the panel is wide enough. */}
        {row.depth === 0 && dir && (
          <span className="hidden min-w-0 shrink truncate text-[10px] text-muted-foreground @panel-sm:block">
            {dir}
          </span>
        )}
      </button>
      <RowActions coarse={coarse}>
        <Verbs
          group={row.group}
          paths={[file.path]}
          what={name}
          untracked={file.untracked}
          busy={busy}
          actions={actions}
        />
      </RowActions>
      <span
        className={cn("w-3 shrink-0 text-center font-mono", MARK_CLASS[file.mark] ?? "text-muted-foreground")}
      >
        {file.mark}
      </span>
    </div>
  )
})

/** Revealed on hover with a mouse, **always shown** on a finger — there is no
    hover to reveal them with, and a button you have to long-press to discover
    is a button that is not there. */
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
