/* ── A scope's files, each with its diff inline ──
   One row per changed file: a viewed tick, the path, its +/− and a flag. A
   click opens the file's diff *under its row* (`DiffTab`, stacked, bounded) —
   the list never gives way to a diff with a back button, so reading the next
   file is one click, not two. Viewed rows fold shut and dim; the mark is keyed
   on the file's fingerprint (`lib/changes-marks.ts`), so a file that moved
   since comes back unread. */
import * as React from "react"
import { ChevronRightIcon, FlagIcon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import type { ReviewAnchor } from "@/components/workspace/diff-editor"
import { DiffTab, type DiffSide } from "@/components/workspace/diff-tab"
import { isViewed, setFlagged, setViewed, useChangesMarks } from "@/lib/changes-marks"
import type { ReviewComment } from "@/lib/review-comments"
import { cn } from "@/lib/utils"
import { projectPath, type ChangedFile } from "@/lib/workspace/git-api"

/** Everything a row needs that is the same for every row of a list. */
export interface FileListContext {
  projectId: string
  sessionId: string
  /** The thread's own checkout, project-relative — `""` for the project. */
  repo: string
  comments: ReviewComment[]
  onComment: (anchor: ReviewAnchor & { path: string }) => void
}

const STATUS_MARK: Record<ChangedFile["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-emerald-600 dark:text-emerald-400" },
  modified: { letter: "M", className: "text-amber-600 dark:text-amber-400" },
  deleted: { letter: "D", className: "text-destructive" },
  renamed: { letter: "R", className: "text-sky-600 dark:text-sky-400" },
}

export function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[10px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
      <span className="text-destructive">−{deletions}</span>
    </span>
  )
}

export function FileList({
  ctx,
  files,
  scopeKey,
  /** The scope routes read (`turn:<id>`, `thread`, …). */
  scope,
  /** The right side is the disk (a running turn, or anything read against
      now) rather than the scope's recorded "after" tree. */
  live,
}: {
  ctx: FileListContext
  files: ChangedFile[]
  scopeKey: string
  scope: string
  live: boolean
}) {
  const [open, setOpen] = React.useState<string | null>(null)
  if (files.length === 0) return <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No files changed.</p>
  return (
    <ul className="divide-y divide-border/40">
      {files.map((file) => (
        <FileRow
          key={file.path}
          ctx={ctx}
          file={file}
          scopeKey={scopeKey}
          scope={scope}
          live={live}
          open={open === file.path}
          onToggle={() => setOpen((current) => (current === file.path ? null : file.path))}
        />
      ))}
    </ul>
  )
}

function FileRow({
  ctx,
  file,
  scopeKey,
  scope,
  live,
  open,
  onToggle,
}: {
  ctx: FileListContext
  file: ChangedFile
  scopeKey: string
  scope: string
  live: boolean
  open: boolean
  onToggle: () => void
}) {
  const marks = useChangesMarks(ctx.sessionId)
  const viewed = isViewed(marks, scopeKey, file)
  const flagged = marks.flagged?.includes(file.path) ?? false
  const path = projectPath(ctx.repo, file.path)
  const slash = file.path.lastIndexOf("/")
  const mark = STATUS_MARK[file.status]

  const left = React.useMemo<DiffSide>(
    () => ({ sessionId: ctx.sessionId, scope, side: "before", path: file.from ?? file.path }),
    [ctx.sessionId, scope, file.path, file.from]
  )
  const right = React.useMemo<DiffSide>(
    () => (live ? "worktree" : { sessionId: ctx.sessionId, scope, side: "after", path: file.path }),
    [ctx.sessionId, scope, file.path, live]
  )
  const { comments, onComment } = ctx
  const review = React.useMemo(
    () => ({
      marks: comments
        .filter((c) => c.path === path)
        .map((c) => ({ side: c.side, line: c.line, endLine: c.endLine })),
      onComment: (anchor: ReviewAnchor) => onComment({ ...anchor, path }),
    }),
    [comments, onComment, path]
  )

  return (
    <li className={cn(viewed && !open && "opacity-60")}>
      <div className="flex min-w-0 items-center gap-1.5 px-1.5 py-1">
        <Checkbox
          checked={viewed}
          onCheckedChange={(next) => {
            setViewed(ctx.sessionId, scopeKey, [file], next === true)
            if (next === true && open) onToggle()
          }}
          aria-label={viewed ? `Mark ${file.path} not viewed` : `Mark ${file.path} viewed`}
          title="Viewed"
        />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs hover:text-foreground"
          title={file.from ? `${file.from} → ${file.path}` : file.path}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
          <span className={cn("w-3 shrink-0 font-mono text-[10px] font-semibold", mark.className)}>{mark.letter}</span>
          <span className="min-w-0 truncate font-mono text-[11px]">
            {slash >= 0 && <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>}
            {file.path.slice(slash + 1)}
          </span>
        </button>
        {file.binary ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">binary</span>
        ) : (
          <Stat additions={file.additions} deletions={file.deletions} />
        )}
        <button
          type="button"
          onClick={() => setFlagged(ctx.sessionId, [file.path], !flagged)}
          aria-pressed={flagged}
          aria-label={flagged ? `Unflag ${file.path}` : `Flag ${file.path} for the agent to fix`}
          title={flagged ? "Flagged for the agent to fix" : "Flag for the agent to fix"}
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-sm hover:bg-muted",
            flagged ? "text-destructive" : "text-muted-foreground/60"
          )}
        >
          <FlagIcon aria-hidden className={cn("size-3", flagged && "fill-current")} />
        </button>
      </div>
      {open && (
        <div className="mb-1.5 ml-1.5 h-80 overflow-hidden rounded-md border border-border/60 @panel-sm:h-96">
          <DiffTab
            projectId={ctx.projectId}
            path={path}
            left={left}
            right={right}
            repo={ctx.repo}
            review={review}
            inline
            active
          />
        </div>
      )}
    </li>
  )
}
