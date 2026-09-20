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

/* ── A step's trailing columns ──
   The elapsed clock, whatever the row filed as its `metric` (tokens, a stamp,
   a count) and the outcome word are ONE group with one type scale, one line
   box and one separator — not three siblings each bringing its own size and
   its own padding. That is what made a column of steps wobble: a 10px stamp
   beside an 11px figure beside a 24px line box, each aligned by whatever its
   own box happened to be. `h-6` pins the group to the row's FIRST line box, so
   a row that grew a caption keeps its meta on the title's line rather than
   drifting to the middle of two, and `items-center` makes the parts agree
   whatever padding they carry. */
export function StepMeta({ parts }: { parts: React.ReactNode[] }) {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== "")
  if (shown.length === 0) return null
  return (
    <span className="flex h-6 shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground/60">
      {shown.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span aria-hidden className="text-muted-foreground/30">
              ·
            </span>
          )}
          {part}
        </React.Fragment>
      ))}
    </span>
  )
}

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
  control,
  detail,
  below,
  startedAt,
  mono = true,
  defaultOpen = false,
  openSetting,
  icon: Icon,
  iconAccent,
  iconChip,
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
  /** The trailing readings, in the order they are read — a count, a cost, a
      stamp. A LIST, not a node: the row joins them with the one separator and
      the one type scale (`StepMeta`), because a caller building its own
      `{" · "}` chain is a caller inventing its own spacing. Falsy entries are
      dropped, so a call site states what it has and never what it does not. */
  metric?: React.ReactNode[]
  /** A control at the very end of the row — a run's hold toggle. Its own slot
      rather than the tail of `metric`: it is a button, not a reading, so it
      takes the row's gap instead of a separator dot in front of it. */
  control?: React.ReactNode
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
  /** The mark's own colour — a kind accent ("a shell command is zinc, a
      thought is sky, a tool is violet"). When absent the mark keeps the
      neutral voice, so the rows that are not work-bearing steps (a plan, a
      compaction) stay quiet; a failure still claims the column. */
  iconAccent?: string
  /** The accent's tinted tile behind the mark (`KIND_CHIPS`), so a coloured
      icon wears its own background; a failure tints the tile red instead. */
  iconChip?: string
}) {
  /* The reader's own answer, or `null` while they have not given one. Whatever
     they last clicked outranks everything below until the view option moves. */
  const [chosen, setChosen] = React.useState<boolean | null>(null)

  /* "This row opens by itself" is a fact that becomes true and then stays true:
     a streamed call mounts before there is any input to read, so `toolViewOf`
     answers `generic` — and the disclosure it would draw is nothing — until the
     arguments land and it becomes an `edit`. Latched during render rather than
     synced in an effect, so the row is open on the very commit that learns it
     (an effect-driven open depended on this component re-rendering *after* the
     one that raised `defaultOpen`, which is exactly what memo boundaries and
     StrictMode make unreliable). Latched only *toward* opening: a view that
     stops opening by default never closes a row the reader is reading. */
  const [latched, setLatched] = React.useState(defaultOpen)
  if (defaultOpen && !latched) setLatched(true)
  const open = chosen ?? latched
  const setOpen = (value: boolean | ((previous: boolean) => boolean)) =>
    setChosen(typeof value === "function" ? value(open) : value)

  /* The view option is the one thing that takes a row back from the reader —
     which is why "Show thinking" and "Expand tool output" appeared to do
     nothing before there was any re-sync at all: the context update reached
     every row and every row ignored it.

     Keyed on the option, NOT on the whole `defaultOpen`: the other half of that
     expression settles on its own mid-stream, and re-applying it here would
     re-open, behind the reader's back, every row they had closed while it
     streamed. Turning the setting *off* re-latches from `defaultOpen` too, which
     lands on the natural default rather than closing everything: an edit goes
     back to showing its diff, a read goes back to folded. */
  const latestDefault = React.useRef(defaultOpen)
  latestDefault.current = defaultOpen
  React.useEffect(() => {
    // Same values on mount, so React bails out without a second render.
    setLatched(latestDefault.current)
    setChosen(null)
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
                // The row assembles mark → title → command (`harness-part-in`,
                // index.css); the mark is part 0 and states no `--part-i`.
                "harness-part-in relative flex h-6 w-3.5 shrink-0 items-center justify-center",
                failed
                  ? "text-destructive"
                  : (iconAccent ?? (active ? "text-primary" : "text-muted-foreground/60"))
              )}
            >
              {/* The accent's tile: a coloured mark wears its own tinted
                  background (`KIND_CHIPS`), and a failed one wears the red a
                  failure claims everywhere else. Absolute so the column's
                  geometry — which the rail is tuned to — does not move. */}
              {iconChip && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute size-3.5 rounded-sm",
                    failed ? "bg-destructive/10" : iconChip
                  )}
                />
              )}
              <Icon
                className={cn(
                  "relative size-3.5 transition-opacity duration-100",
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
            {/* The title and the file it acted on are one part, not two: the
                chip is the object of the verb beside it, so they sharpen
                together or the row reads as "Read" … "package.json". */}
            <span className="harness-part-in [--part-i:1] flex min-w-0 items-baseline gap-1.5">
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
                  "harness-part-in [--part-i:2] -mt-1 min-w-0 truncate text-[11px] leading-5 text-muted-foreground/60",
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

        </button>
        {/* Every reading the row has, in one line box. The clock leads (it is
            the one that ticks), the caller's own readings follow, and the
            outcome word ends the line — a failure still claims the column, in
            its own colour, but at the group's size and not its own. */}
        <StepMeta
          parts={[
            elapsedMs !== null && elapsedMs >= 2000 ? formatElapsed(elapsedMs) : null,
            ...(metric ?? []),
            failed ? <span className="text-destructive">failed</span> : label,
          ]}
        />
        {control}
      </div>

      {/* Both bodies fade rather than rise, and neither animates its height.
          The diff of an edit, the output of a command and a search's answers
          all arrive well after the row that heads them — the call is drawn the
          moment it opens and filled in as its result streams — so mounting them
          with nothing at all is the pop that ends an otherwise smooth row.
          `harness-fade-in` and not `harness-item-in`: a rise would slide a
          block into space that did not exist a frame ago, and the height is the
          one thing that must land in a single frame (index.css — `scrollHeight`
          is what the autoscroll pin chases). So the space appears at once and
          only the content resolves into it, which is the accepted cost already
          documented there rather than a new one.
          It also covers the click: opening a row by hand used to pop too. */}
      {below && <div className="harness-fade-in mb-1 min-w-0 pl-[1.375rem]">{below}</div>}
      {expandable && open && (
        <div className="harness-fade-in mt-1 mb-2.5 min-w-0 space-y-2">{detail}</div>
      )}
    </div>
  )
})
StepRow.displayName = "StepRow"
import { writeClipboard } from "@/lib/clipboard"
