/* ── The step row ── the one expandable line every tool, thought, plan and
   compaction draws through, plus the small clipboard/selection helpers the
   transcript rows share. Split out of thread-items so the leaf layouts
   (thread-cards) and the recursive row cluster (thread-items) can both use it
   without importing each other. */
import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import { toast } from "@/lib/toast"
import { reportError } from "@/lib/errors"
import { FileBadge } from "@/components/tool-parts"
import type { FileRange } from "@/lib/tools"
import { cn } from "@/lib/utils"

/* Right-clicking text the user has selected keeps the browser's own menu —
   native Copy works there. Ours only claims clicks on unselected content.
   stopPropagation keeps Base UI's document-level listener from cancelling
   the native menu. */
export function yieldToTextSelection(event: React.MouseEvent & { preventBaseUIHandler?: () => void }) {
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    event.preventBaseUIHandler?.()
    event.stopPropagation()
  }
}

export function copyText(text: string) {
  writeClipboard(text)
    .then(() => toast.success("Copied"))
    .catch((err) => reportError(err, "Couldn't copy"))
}

/* Steps read as one timeline: a hairline rail down the gutter with a node per
   step (rail geometry in index.css). The thing acted on is the headline, and
   the kind of step is the leading icon — it was also a word in the right-hand
   column, which spent a column of every row repeating what the mark beside it
   already said. Only a failure claims that column now. Everything a step
   produced is collapsed behind the row until clicked. */

/** The nested-transcript rail: a hairline down the gutter with the child rows
    indented off it. Here rather than in thread-items because both the rows
    inside a subagent (`SubagentTranscript`) and the steps inside a run
    (`workflow-run`) hang off it, and those two files may not import each other
    (see the header comment on workflow-run). */
export const RAIL_CLASS = "mt-0.5 ml-[calc(0.75rem-1px)] space-y-0.5 border-l border-border/60 pl-2.5"

export function useElapsed(startedAt: number, active: boolean): number | null {
  const [ms, setMs] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (!active) {
      setMs(null)
      return
    }
    const tick = () => setMs(Date.now() - startedAt)
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [startedAt, active])
  return ms
}

export function formatElapsed(ms: number): string {
  return ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/* Memoized: one per transcript row, and a streaming turn re-renders the whole
   list if nothing stops it. The reducer leaves untouched items referentially
   stable, so memo lets a chunk re-render only the tail. `target`, `label` and
   `metric` arrive as ReactNode from the caller and are rebuilt on every render
   of the kind components below — those wrap this in memo too, so the node props
   they pass are rebuilt once per kind render, not unusably often. */
export const StepRow = React.memo(function StepRow({
  target,
  caption,
  file,
  filePath,
  fileRange,
  label,
  status,
  metric,
  detail,
  below,
  startedAt,
  mono = true,
  defaultOpen = false,
  openSetting,
  icon: Icon,
}: {
  target: React.ReactNode
  /** A second, quieter line under the target — the literal thing invoked when
      the target is the agent's prose *about* it (see `toolHeading`). */
  caption?: string
  /** A file the row acted on, drawn as a badge chip next to the target — the
      path is elided to its basename so "Read /path/to/file" reads as "Read" +
      a `file` chip rather than an elided mono line. */
  file?: string
  /** The full path behind the badge, for its tooltip. */
  filePath?: string
  /** The lines the row was about, so opening the badge lands on them and tints
      them rather than opening the file at the top. */
  fileRange?: FileRange
  /** The trailing word. Optional: a row whose leading icon already says what
      kind of step it is (every tool, plan and compaction row does) prints
      nothing here, and only a failure claims the column. */
  label?: string
  status: string | null
  metric?: React.ReactNode
  detail?: React.ReactNode
  /** A strip under the header that stays whether or not the row is open —
      the step's outcome in chips (the pages a web search returned, the page
      a fetch read). The detail is what you open to read; this is what you
      see without opening it. */
  below?: React.ReactNode
  startedAt?: number
  mono?: boolean
  /** Start expanded — edits show their diff without a click (see ToolStep). */
  defaultOpen?: boolean
  /** The view option behind `defaultOpen`, when one of them is. Changing it
      re-applies `defaultOpen` to a row that is already on screen; see below for
      why that is a separate prop rather than just watching `defaultOpen`. */
  openSetting?: boolean
  /** Leading mark. On an expandable row it swaps for a chevron on hover, so
      the disclosure affordance appears where the eye already is instead of at
      the far end of the line. */
  icon?: React.ComponentType<{ className?: string }>
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  /* `useState` reads its argument once, so a `defaultOpen` that later changes
     is thrown away — which is why "Show thinking" and "Expand tool output"
     appeared to do nothing: the context update reached every row and every row
     ignored it, so only steps that mounted *after* the flip honoured it.

     The re-sync is keyed on the option, NOT on `defaultOpen`. `defaultOpen` for
     a tool is `showToolDetails || toolOpensByDefault(item)`, and the second
     half flips on its own mid-stream — a call is `generic` until its input
     arrives and an `edit` once it does — so watching the whole expression would
     yank rows open as they stream and re-open ones you had just collapsed.
     Watching the setting means a row you closed by hand stays closed until you
     actually change the setting again. Turning the setting *off* re-applies
     `defaultOpen` too, which lands on the natural default rather than closing
     everything: an edit goes back to showing its diff, a read goes back to
     folded. */
  const latestDefault = React.useRef(defaultOpen)
  latestDefault.current = defaultOpen
  React.useEffect(() => {
    // Same value on mount, so React bails out without a second render.
    setOpen(latestDefault.current)
  }, [openSetting])
  const expandable = detail !== undefined && detail !== null && detail !== false
  const active = status === "in_progress" || status === "pending"
  const failed = status === "failed"
  const elapsedMs = useElapsed(startedAt ?? 0, active && startedAt !== undefined)

  return (
    <div>
      {/* The row is the wrapper, not the button. The trailing columns — the
          metric and the label — sit OUTSIDE the disclosure control, because
          the metric is a popover trigger now (a step's tokens carry the same
          breakdown a turn's do) and a button may not hold a button. The
          wrapper keeps every class the button used to carry, `group/step`
          included, so the hover tint still covers the whole line and the
          chevron still swaps in when the pointer is anywhere on it. */}
      <div
        className={cn(
          // items-start, not items-baseline: the target span is `truncate`
          // (overflow: hidden), so its baseline is its bottom edge — baseline
          // alignment lifted the title ~5px above the "edit"/"run" label. Every
          // child is a leading-6 line box (the icon is given the same height),
          // so starting them lines them up exactly — and a row that grew a
          // caption keeps its label and metric pinned to the first line rather
          // than drifting to the middle of two, which `items-center` did.
          // The width is calc(100% + 12px) so the -mx-1.5/px-1.5 hover bleed
          // cancels on BOTH sides: a `w-full` box only shifts left under a
          // negative start margin, which left the row's content edge 12px shy
          // of the right edge that messages run to.
          "group/step -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-start gap-2 rounded-md px-1.5 py-0.5 transition-colors duration-150",
          expandable && "hover:bg-muted/40"
        )}
      >
        <button
          type="button"
          disabled={!expandable}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-start gap-2 text-start"
        >
          {Icon && (
            <span
              className={cn(
                // h-6, not size-3.5: the mark has to occupy a whole line box, or
                // `items-start` would hang it off the top of the text it marks.
                "relative flex h-6 w-3.5 shrink-0 items-center justify-center",
                failed ? "text-destructive" : active ? "text-primary" : "text-muted-foreground/60"
              )}
            >
              <Icon
                className={cn(
                  "size-3.5 transition-opacity duration-100",
                  expandable && (open ? "opacity-0" : "group-hover/step:opacity-0")
                )}
              />
              {expandable && (
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "absolute size-3.5 text-muted-foreground transition-[opacity,transform] duration-100",
                    open ? "rotate-90 opacity-100" : "opacity-0 group-hover/step:opacity-100"
                  )}
                />
              )}
            </span>
          )}
          {/* Steps are what the agent did, not what it said: the whole row sits at
              caption weight so prose stays the thing you read. */}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span
                className={cn(
                  "min-w-0 truncate text-xs leading-6",
                  mono && "font-mono",
                  failed ? "text-destructive" : "text-muted-foreground",
                  active && "harness-shimmer"
                )}
              >
                {target}
              </span>
              {/* The file a step acted on, as a chip: the path is gone in the
                  basename, so the row says "Read" + `package.json` instead of an
                  elided "/var/www/…/package.json". Baseline-aligned with the
                  title so it reads on the same line, never on a second row. */}
              {file && <FileBadge file={file} filePath={filePath} range={fileRange} />}
            </span>
            {/* The command under its description. One notch quieter and one notch
                smaller than the title, and always mono — it is the literal thing
                that ran, so it is read as code even when the line above it is
                prose. `-mt-1` claws back the slack in the two leadings so the
                pair reads as one row rather than as two. */}
            {caption && (
              <span
                className={cn(
                  "-mt-1 min-w-0 truncate text-[11px] leading-5 text-muted-foreground/55",
                  // Mono follows the title: a caption under a command is the
                  // literal thing that ran, but under prose (a subagent's
                  // model, a run's live step) it is prose too.
                  mono && "font-mono"
                )}
              >
                {caption}
              </span>
            )}
          </span>

          {elapsedMs !== null && elapsedMs >= 2000 && (
            <span className="shrink-0 text-[11px] leading-6 tabular-nums text-muted-foreground/60">
              {formatElapsed(elapsedMs)}
            </span>
          )}
        </button>
        {metric && (
          <span className="shrink-0 text-[11px] leading-6 tabular-nums text-muted-foreground/60">
            {metric}
          </span>
        )}
        {(failed || label) && (
          <span
            className={cn(
              "shrink-0 text-[11px] leading-6",
              failed ? "text-destructive" : "text-muted-foreground/50"
            )}
          >
            {failed ? "failed" : label}
          </span>
        )}
      </div>

      {below && <div className="mb-1 min-w-0 pl-[1.375rem]">{below}</div>}
      {expandable && open && <div className="mt-1 mb-2.5 min-w-0 space-y-2">{detail}</div>}
    </div>
  )
})
StepRow.displayName = "StepRow"
import { writeClipboard } from "@/lib/clipboard"
