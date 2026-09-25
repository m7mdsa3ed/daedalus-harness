/* ── A scope's files, each with its diff inline ──
   Drawn the way source control draws a working set (`scm/working-list.tsx`,
   itself VS Code's shape): dense rows of icon, name and a dimmed folder, the
   actions revealed on hover (always shown on a finger), the +/− and the
   status letter at the end. A click opens the file's diff *under its row*, as
   a card the height of the diff (`DiffTab` with `fit`, capped) — never a fixed
   box scrolling inside the list — whose header steps to the previous or next
   file and marks this one viewed on the way to the next, the way a pull
   request is read. The list never gives way to a diff with a back button. Viewed rows
   fold shut and dim; the mark is keyed on the file's fingerprint
   (`lib/changes-marks.ts`), so a file that moved since comes back unread. */
import * as React from "react"
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, FileIcon, FlagIcon, type LucideIcon } from "lucide-react"

import type { ReviewAnchor } from "@/components/workspace/diff-editor"
import { DiffTab, type DiffSide } from "@/components/workspace/diff-tab"
import { MARK_CLASS } from "@/components/workspace/scm/working-list"
import { useCoarsePointer } from "@/hooks/use-device"
import { isViewed, setFlagged, setViewed, useChangesMarks } from "@/lib/changes-marks"
import type { ReviewComment } from "@/lib/review-comments"
import { useStoreSelect } from "@/lib/store"
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

const STATUS: Record<ChangedFile["status"], { letter: string; label: string }> = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
}

export function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[10px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  )
}

/** VS Code's count badge: a pill on the end of a section header. */
export function CountBadge({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 font-medium text-muted-foreground tabular-nums"
    >
      {children}
    </span>
  )
}

/** An icon-only action on a row or a header — `size-5` with a mouse, the
    touch target on a finger. */
export function RowAction({
  icon: Icon,
  label,
  onClick,
  pressed,
  disabled,
  className,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  pressed?: boolean
  disabled?: boolean
  className?: string
}) {
  const coarse = useCoarsePointer()
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      className={cn(
        "grid shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        coarse ? "size-9" : "size-5",
        className
      )}
    >
      <Icon aria-hidden className="size-3.5" />
    </button>
  )
}

/** Revealed on hover with a mouse, always shown on a finger. */
export function HoverActions({ group, children }: { group: "file" | "section"; children: React.ReactNode }) {
  const coarse = useCoarsePointer()
  return (
    <span
      className={cn(
        "flex shrink-0 items-center transition-opacity",
        !coarse &&
          (group === "file"
            ? "opacity-0 group-hover/file:opacity-100 has-focus-visible:opacity-100"
            : "opacity-0 group-hover/section:opacity-100 has-focus-visible:opacity-100")
      )}
    >
      {children}
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
  if (files.length === 0) return <p className="py-1 pr-2 pl-7 text-[11px] text-muted-foreground">No files changed.</p>
  return (
    <ul>
      {files.map((file, index) => (
        <FileRow
          key={file.path}
          ctx={ctx}
          file={file}
          scopeKey={scopeKey}
          scope={scope}
          live={live}
          open={open === file.path}
          onToggle={() => setOpen((current) => (current === file.path ? null : file.path))}
          index={index}
          count={files.length}
          onStep={(delta) => setOpen(files[index + delta]?.path ?? null)}
        />
      ))}
    </ul>
  )
}

/** Another thread had a turn running in this repository when the file was
    written, and nothing this thread ran names it (turn-changes.ts `annotate`,
    `claimShared`) — which of them wrote it is not known. */
function SharedBadge({ threads }: { threads: string[] }) {
  const names = useStoreSelect((state) =>
    threads.map((id) => state.sessions.find((s) => s.id === id)?.title || "another thread").join(", ")
  )
  return (
    <span
      className="shrink-0 rounded-sm bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400"
      title={`Also running in this repository when this was written: ${names}`}
    >
      shared
    </span>
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
  index,
  count,
  onStep,
}: {
  ctx: FileListContext
  file: ChangedFile
  scopeKey: string
  scope: string
  live: boolean
  open: boolean
  onToggle: () => void
  index: number
  count: number
  /** Open the file `delta` rows away — none past either end closes the card. */
  onStep: (delta: number) => void
}) {
  /* Stepping lands on a card that may be below the fold; bring its row up. */
  const rowRef = React.useRef<HTMLLIElement>(null)
  React.useEffect(() => {
    if (open) rowRef.current?.scrollIntoView({ block: "nearest" })
  }, [open])
  const coarse = useCoarsePointer()
  const marks = useChangesMarks(ctx.sessionId)
  const viewed = isViewed(marks, scopeKey, file)
  const flagged = marks.flagged?.includes(file.path) ?? false
  const path = projectPath(ctx.repo, file.path)
  const slash = file.path.lastIndexOf("/")
  const status = STATUS[file.status]

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
    <li ref={rowRef} className="scroll-mt-2">
      <div
        className={cn(
          "group/file flex items-center gap-1.5 pr-1.5 pl-7 text-xs hover:bg-accent/50",
          open && "bg-accent/60 hover:bg-accent/60",
          coarse ? "min-h-11" : "min-h-6"
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left focus-visible:outline-none",
            viewed && !open && "opacity-55"
          )}
          title={`${status.label} · ${file.from ? `${file.from} → ${file.path}` : file.path}`}
        >
          <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 shrink-0 truncate", file.status === "deleted" && "line-through")}>
            {file.path.slice(slash + 1)}
          </span>
          {slash >= 0 && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{file.path.slice(0, slash)}</span>
          )}
        </button>
        <HoverActions group="file">
          {!flagged && (
            <RowAction icon={FlagIcon} label="Flag for the agent to fix" onClick={() => setFlagged(ctx.sessionId, [file.path], true)} />
          )}
          {!viewed && (
            <RowAction
              icon={CheckIcon}
              label="Mark viewed"
              onClick={() => {
                setViewed(ctx.sessionId, scopeKey, [file], true)
                if (open) onToggle()
              }}
            />
          )}
        </HoverActions>
        {/* Set marks stay drawn — they are state, not affordances. */}
        {flagged && (
          <RowAction
            icon={FlagIcon}
            label="Flagged for the agent to fix — click to unflag"
            pressed
            className="text-destructive hover:text-destructive [&_svg]:fill-current"
            onClick={() => setFlagged(ctx.sessionId, [file.path], false)}
          />
        )}
        {viewed && (
          <RowAction
            icon={CheckIcon}
            label="Viewed — click to mark unread"
            pressed
            className="text-primary hover:text-primary"
            onClick={() => setViewed(ctx.sessionId, scopeKey, [file], false)}
          />
        )}
        {file.shared && <SharedBadge threads={file.shared} />}
        {file.binary ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">binary</span>
        ) : (
          <Stat additions={file.additions} deletions={file.deletions} />
        )}
        <span
          className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", MARK_CLASS[status.letter])}
          title={status.label}
        >
          {status.letter}
        </span>
      </div>
      {open && (
        <div className="mx-2 mt-1 mb-2 overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm">
          <div className="flex items-center gap-1 border-b border-border/60 bg-muted/40 px-1.5 py-1 text-[11px]">
            <RowAction icon={ChevronLeftIcon} label="Previous file" disabled={index === 0} onClick={() => onStep(-1)} />
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {index + 1} of {count}
            </span>
            <RowAction icon={ChevronRightIcon} label="Next file" disabled={index >= count - 1} onClick={() => onStep(1)} />
            <span className="min-w-0 flex-1 truncate px-1 font-mono text-muted-foreground" title={path}>
              {file.from ? `${file.from} → ${file.path}` : file.path}
            </span>
            {viewed ? (
              <span className="flex shrink-0 items-center gap-1 px-1 text-primary">
                <CheckIcon aria-hidden className="size-3" />
                Viewed
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setViewed(ctx.sessionId, scopeKey, [file], true)
                  onStep(1)
                }}
                title={index < count - 1 ? "Mark viewed and open the next file" : "Mark viewed and close"}
                className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <CheckIcon aria-hidden className="size-3" />
                Viewed
              </button>
            )}
          </div>
          <DiffTab
            projectId={ctx.projectId}
            path={path}
            left={left}
            right={right}
            repo={ctx.repo}
            review={review}
            inline
            active
            fit={560}
          />
        </div>
      )}
    </li>
  )
}
