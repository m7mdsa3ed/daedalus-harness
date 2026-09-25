/* ── The working set, as one list ──
   Replaces the four groups (Conflicts / Staged / Changes / Untracked) that
   `file-rows.tsx` drew. The reasoning is in `lib/workspace/working-set.ts`:
   git reports four lists, but a path that is staged *and* edited again was two
   rows in two groups with no way to tell they were the same file. Here it is
   one row with an indeterminate tick.

   **The tick is the verb.** Staging is what source control is mostly for, and
   it was two hover-revealed icon buttons per row. A checkbox says what the
   state is and changes it in the same gesture, which is also what makes the
   folder rows work: a folder wears its children's folded answer and ticking it
   stages everything under it.

   The rows are windowed (`hooks/use-windowed-rows.ts`) off a memoized flat
   array, so a rebase with two thousand changed paths costs the rows on screen
   rather than two thousand. */
import * as React from "react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  Folder01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Checkbox } from "@/components/ui/checkbox"
import { IconAction } from "@/components/workspace/scm/shared"
import { useWindowedRows } from "@/hooks/use-windowed-rows"
import { cn } from "@/lib/utils"
import { basename } from "@/lib/workspace/fs-api"
import {
  WORK_ROW_HEIGHT,
  WORK_ROW_HEIGHT_COARSE,
  type Staged,
  type WorkRow,
  type WorkingFile,
} from "@/lib/workspace/working-set"

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

export const MARK_CLASS: Record<string, string> = {
  A: "text-emerald-600 dark:text-emerald-400",
  "?": "text-emerald-600 dark:text-emerald-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-600 dark:text-red-400",
  U: "text-red-600 dark:text-red-400",
  R: "text-sky-600 dark:text-sky-400",
}

const indent = (depth: number): React.CSSProperties => ({ paddingLeft: `${depth * 12 + 4}px` })

/** Everything a row can do, as one stable object — so `Row`'s `React.memo`
    hits while a commit message is being typed above it. */
export interface WorkActions {
  onOpen: (file: WorkingFile) => void
  onToggleDir: (path: string) => void
  /** `stage` false means unstage. Folders hand up everything under them. */
  onStage: (paths: string[], stage: boolean) => void
  onDiscard: (paths: string[], what: string, untracked: boolean) => void
}

export function WorkingList({
  rows,
  collapsed,
  coarse,
  busy,
  actions,
}: {
  rows: WorkRow[]
  collapsed: ReadonlySet<string>
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
        row.kind === "dir" ? (
          <DirRow
            key={row.key}
            row={row}
            collapsed={collapsed.has(row.path)}
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

/** The one tick, in all three states. Base UI reads `indeterminate` separately
    from `checked`, so `partial` is both and not a third value. */
function StageBox({
  staged,
  label,
  disabled,
  onChange,
}: {
  staged: Staged
  label: string
  disabled?: boolean
  onChange: (stage: boolean) => void
}) {
  return (
    <Checkbox
      aria-label={label}
      title={label}
      disabled={disabled}
      checked={staged !== "no"}
      indeterminate={staged === "partial"}
      /* Partly staged ticks to fully staged: the gesture means "put all of
         this in the commit", which is the only reading that is not a guess. */
      onCheckedChange={() => onChange(staged !== "yes")}
      className="size-3.5 shrink-0"
    />
  )
}

const DirRow = React.memo(function DirRow({
  row,
  collapsed,
  coarse,
  busy,
  actions,
}: {
  row: Extract<WorkRow, { kind: "dir" }>
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
      <StageBox
        staged={row.staged}
        label={row.staged === "yes" ? `Unstage ${row.name}` : `Stage ${row.name}`}
        disabled={busy}
        onChange={(stage) => actions.onStage(row.paths, stage)}
      />
      <button
        type="button"
        onClick={() => actions.onToggleDir(row.path)}
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
        <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-60">{row.count}</span>
      </button>
      <RowActions coarse={coarse}>
        <IconAction
          label={`Discard everything in ${row.name}`}
          icon={ArrowTurnBackwardIcon}
          disabled={busy}
          className="hover:text-destructive"
          onClick={() => actions.onDiscard(row.paths, row.name, false)}
        />
      </RowActions>
    </div>
  )
})

const FileRow = React.memo(function FileRow({
  row,
  coarse,
  busy,
  actions,
}: {
  row: Extract<WorkRow, { kind: "file" }>
  coarse: boolean
  busy: boolean
  actions: WorkActions
}) {
  const { file } = row
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md pr-1 text-xs hover:bg-accent/50",
        file.conflicted && "bg-destructive/5",
        coarse ? "min-h-11" : "min-h-7"
      )}
      style={indent(row.depth)}
    >
      {/* A conflicted file cannot be staged until it is resolved, so the tick
          is there to say "not in the commit" and is not a control. */}
      <StageBox
        staged={file.staged}
        label={file.staged === "yes" ? `Unstage ${basename(file.path)}` : `Stage ${basename(file.path)}`}
        disabled={busy || file.conflicted}
        onChange={(stage) => actions.onStage([file.path], stage)}
      />
      <button
        type="button"
        onClick={() => actions.onOpen(file)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
        title={`${LABEL[file.mark] ?? "Changed"} · ${file.from ? `${file.from} → ${file.path}` : file.path}`}
      >
        <span className={cn("min-w-0 truncate", file.mark === "D" && "line-through opacity-70")}>
          {basename(file.path)}
        </span>
        {/* In the flat layout the row has no tree above it to say where the
            file lives, so it says so itself where the panel is wide enough. */}
        {row.depth === 0 && dir && (
          <span className="hidden min-w-0 shrink truncate text-[10px] text-muted-foreground @panel-sm:block">
            {dir}
          </span>
        )}
        <span className="flex-1" />
        <span
          className={cn(
            "w-3 shrink-0 text-center font-mono",
            MARK_CLASS[file.mark] ?? "text-muted-foreground"
          )}
        >
          {file.mark}
        </span>
      </button>
      <RowActions coarse={coarse}>
        {file.mark !== "D" && (
          <IconAction
            label={file.untracked ? "Delete this untracked file" : "Discard"}
            icon={ArrowTurnBackwardIcon}
            disabled={busy}
            className="hover:text-destructive"
            onClick={() => actions.onDiscard([file.path], basename(file.path), file.untracked)}
          />
        )}
      </RowActions>
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
