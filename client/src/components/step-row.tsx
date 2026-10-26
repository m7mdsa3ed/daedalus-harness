/* ── The step row ── the one expandable line every tool, thought, plan and
   compaction draws through, plus the small clipboard/selection helpers the
   transcript rows share. Split out of thread-items so the leaf layouts
   (thread-cards) and the recursive row cluster (thread-items) can both use it
   without importing each other. */
import * as React from "react"
import { AnimatePresence, m, useReducedMotion } from "motion/react"
import { ChevronRightIcon } from "lucide-react"
import { toast } from "@/lib/toast"
import { reportError } from "@/lib/errors"
import { FileBadge, CHIP } from "@/components/tool-parts"
import type { FileRange } from "@/lib/tools"
import { toolVariantOf, useLayoutOptionsContext, type ToolLayout, type ToolVariant } from "@/lib/layout-options"
import { cn } from "@/lib/utils"
import { useRowState } from "@/lib/row-open"
import { dominantTextDir, textDir } from "@/lib/text-direction"

export { textDir } from "@/lib/text-direction"

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

/* ── Direction ── a step reads in the direction of its own text: an Arabic
   title puts the mark on the right and the title flush beside it, as one unit,
   instead of a right-aligned title drifting away from a left-hand mark. A run
   gives every step inside it one direction (`StepDirContext`), so its rail
   stays on one side. The literal caption (a command, a path) keeps its own
   direction and only aligns with the row. */
export const StepDirContext = React.createContext<"rtl" | "ltr" | null>(null)

/* ── One call of a fan-out, marked ──
   The rows a parallel batch sends are drawn on one wash, and the wash alone
   does not say *which* rows ran at the same time or in what order.
   `layoutBatches` has always known each call's place in its batch
   (`index`/`size`) and nothing drew it, so a reader looking at four rows side
   by side had no telling which one the agent's request listed first — and that
   order is the order the results are read in.

   The app's own chip (`CHIP`), wearing the batch's tint instead of `muted`:
   one more thing on a line that already holds a mark, a file badge and a
   command has to look like the things beside it, or it reads as a decoration
   that arrived from somewhere else. `tabular-nums` so 1/10 and 2/3 are the
   same width and a column of them lines up. */
/** The batch's tint on the app's chip — the ONE spelling, worn by the group's
    "n in parallel" chip and by every call's place, so the two can never differ
    by a shade or a size again. */
export const BATCH_CHIP = "shrink-0 bg-primary/10 font-medium tabular-nums text-primary"

export function StepMarker({ label }: { label: string }) {
  return (
    <span
      title={`Call ${label} — one of the calls this request made together`}
      /* A fixed minimum and centred, so "1/2" and "10/12" take the same column
         and every title in the batch starts on one line. */
      className={cn(CHIP, BATCH_CHIP, "min-w-9 justify-center")}
    >
      {label}
    </span>
  )
}

/* Which of the calls on screen are one request's batch, and where each sat in
   it. A map from item id to "2/3", provided by the batch itself (`ToolRun`'s
   `parallel`) and read by every step below it. A context rather than a prop
   handed down: a batch of mixed kinds folds into nested runs, so the calls that
   need numbering are two rows down from the group that knows the numbering —
   the same reason `StepDirContext` above is one. Identity is exact because the
   fold keys a batch by the items the store handed it, and a step never renders
   under a batch it is not part of. */
export const StepMarkerContext = React.createContext<((id: string) => string | undefined) | null>(null)

/* Closing gets its own symmetric curve: the opening ease-out run backwards
   dropped ~70% of the height in the first frame and then crawled. */
export const DISCLOSE_EXIT = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as const }

/** Whether a finished animation was the *open* one. `onAnimationComplete` also
    fires for the exit, and restoring `overflow: visible` there painted every
    row at full size for the frame between "height reached 0" and removal —
    the flash on close. framer passes the target object, never "animate". */
export const finishedOpening = (definition: unknown) =>
  typeof definition === "object" && definition !== null && (definition as { height?: unknown }).height === "auto"

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
export function StepMeta({ parts, className }: { parts: React.ReactNode[]; className?: string }) {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== "")
  if (shown.length === 0) return null
  return (
    <span className={cn("flex h-6 shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground", className)}>
      {shown.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span aria-hidden className="text-muted-foreground">
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
  /* A step that took under a second says how many milliseconds; "0s" read as
     no reading at all. */
  const whole = Math.max(0, Math.round(ms))
  if (whole < 1000) return `${whole}ms`
  if (whole < 60_000) return `${Math.floor(whole / 1000)}s ${whole % 1000}ms`
  return `${Math.floor(whole / 60_000)}m ${Math.floor((whole % 60_000) / 1000)}s`
}

/* A step's clock in the width it has: the millisecond figure on a wide panel,
   a tenth of a second on a narrow one ("3s 120ms" → "3.1s"), where the
   readings share one line with the title and every character comes out of it. */
function ElapsedFigure({ ms }: { ms: number }) {
  const full = formatElapsed(ms)
  const whole = Math.max(0, Math.round(ms))
  const short =
    whole < 1000 || whole >= 60_000
      ? full
      : whole < 10_000
        ? `${(Math.floor(whole / 100) / 10).toFixed(1)}s`
        : `${Math.floor(whole / 1000)}s`
  if (short === full) return full
  return (
    <>
      <span className="@panel-sm:hidden">{short}</span>
      <span className="hidden @panel-sm:inline">{full}</span>
    </>
  )
}

/* Memoized: one per transcript row, and a streaming turn re-renders the whole
   list if nothing stops it. The reducer leaves untouched items referentially
   stable, so memo lets a chunk re-render only the tail. `target`, `label` and
   `metric` arrive as ReactNode from the caller and are rebuilt on every render
   of the kind components below — those wrap this in memo too, so the node props
   they pass are rebuilt once per kind render, not unusably often. */
export const StepRow = React.memo(function StepRow({
  target,
  openTarget,
  caption,
  file,
  filePath,
  fileRange,
  chip,
  label,
  status,
  metric,
  control,
  detail,
  plainBody,
  below,
  firstRow,
  stackMeta = false,
  belowFlush = false,
  startedAt,
  endedAt,
  waitedMs,
  waitingSince,
  mono = true,
  defaultOpen = false,
  openSetting,
  autoOpen,
  plain = false,
  persistKey,
  icon: Icon,
  iconAccent,
  iconChip,
  toolLayout,
  toolVariant,
  dir,
}: {
  /** Overrides the direction read from `target` — a node target (a live
      thought's shimmer) has none of its own. */
  dir?: "rtl" | "ltr"
  target: React.ReactNode
  /** Title content used while the row is expanded. */
  openTarget?: React.ReactNode
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
  /** A chip after the target for what acted rather than what was acted on: the
      MCP integration that took the call (`McpServerChip`). Its own slot beside
      `file` because the two say the same kind of thing — the row, then the thing
      it happened to or through — and a row never has both. */
  chip?: React.ReactNode
  /** The trailing word. Optional: a row whose leading icon already says what
      kind of step it is (every tool, plan and compaction row does) prints
      nothing here, and only a failure claims the column. A node, so a live row
      can hang a dot off its word (see the thought row's `ThinkingLabel`). */
  label?: React.ReactNode
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
  /** The plain shape's body, as a function of disclosure state — so the SAME
      nodes are mounted on both sides of the fold. Rendering two different
      elements for the two states is a swap, and a swap is a remount: whatever
      animates a fold (a thought's block, say) never sees the transition at
      all. Supplying this makes the row expandable on its own. */
  plainBody?: (open: boolean) => React.ReactNode
  /** Content beside the title, on its first row rather than underneath. */
  firstRow?: React.ReactNode
  /** Below `@panel-sm` the readings (clock, tokens, outcome) take a line of
      their own under the title, indented to it, instead of sharing its line
      and leaving it two letters. For a row whose title is a name worth
      reading whole — a subagent or a workflow step. */
  stackMeta?: boolean
  /** A strip under the header that stays whether or not the row is open —
      the step's outcome in chips (the pages a web search returned, the page
      a fetch read). The detail is what you open to read; this is what you
      see without opening it. A render function can vary it with disclosure
      state when the detail contains the same content at greater depth. */
  below?: React.ReactNode | ((open: boolean, setOpen: (open: boolean) => void) => React.ReactNode)
  /** Start `below` at the row's own edge rather than under its title: a strip
      that hangs a rail off the mark (a subagent's latest steps) brings its own
      indent, and the title's on top of it cost a nested worker 22px a level. */
  belowFlush?: boolean
  /** When the step began. With `endedAt` it is a length: while the step is
      live the row ticks from it, and once it has stopped the two together are
      how long it took — the half a replay has to bring with it, since the
      ticking one does not survive a reload. */
  startedAt?: number
  /** When the step stopped. Absent on a step still running, and on one whose
      runtime never said. */
  endedAt?: number
  /** Time the step spent waiting on the reader's approval, taken out of its
      length: `waitedMs` for answered asks, `waitingSince` for one still open
      (the clock stands still until it is answered). */
  waitedMs?: number
  waitingSince?: number
  mono?: boolean
  /** Start expanded — edits show their diff without a click (see ToolStep). */
  defaultOpen?: boolean
  /** The view option behind `defaultOpen`, when one of them is. Changing it
      re-applies `defaultOpen` to a row that is already on screen; see below for
      why that is a separate prop rather than just watching `defaultOpen`. */
  openSetting?: boolean | string
  /** Open for exactly as long as this is true — the row is a *live view*, read
      while it is still being written. Unlike `defaultOpen`, whose latch only
      ever opens, this closes the row again the moment the value goes false; a
      click still outranks it, so a reader who opened the folded detail keeps it
      open. `undefined` leaves the row on the ordinary latch. */
  autoOpen?: boolean
  /** Draw the row like plain transcript prose, without step chrome or gutter. */
  plain?: boolean
  /** The item this row draws, so the reader's open/closed answer survives the
      row going dormant and coming back (`lib/row-open`). */
  persistKey?: string
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
  /** Optional tool-specific layout; non-tool steps keep the transcript default. */
  toolLayout?: ToolLayout
  /** The layout's variant; resolved against `toolLayout`, so a stale one is harmless. */
  toolVariant?: ToolVariant
}) {
  /* The reader's own answer, or `null` while they have not given one. Whatever
     they last clicked outranks everything below until the view option moves. */
  /* Through `useRowState`: a dormant row's revival starts from the answer the
     reader gave before it went (`lib/row-open`), every other mount from null. */
  const [chosen, setChosen] = useRowState<boolean | null>(persistKey, null, openSetting)

  /* "This row opens by itself" is a fact that becomes true and then stays true:
     a streamed call mounts before there is any input to read, so `toolViewOf`
     answers `generic` — and the disclosure it would draw is nothing — until the
     arguments land and it becomes an `edit`. Latched during render rather than
     synced in an effect, so the row is open on the very commit that learns it
     (an effect-driven open depended on this component re-rendering *after* the
     one that raised `defaultOpen`, which is exactly what memo boundaries and
     StrictMode make unreliable). Latched only *toward* opening: a view that
     stops opening by default never closes a row the reader is reading. */
  const [latched, setLatched] = useRowState(persistKey && `${persistKey}:latched`, defaultOpen, openSetting)
  if (defaultOpen && !latched) setLatched(true)
  /* `autoOpen` is a two-way switch where `defaultOpen` is one-way: a live row is
     open while it is being written and folds the moment it stops, and only a
     click by the reader holds it past that. */
  const open = autoOpen === undefined ? (chosen ?? latched) : (chosen ?? autoOpen)
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
  /* Skipped on mount rather than relying on it being a no-op there: a revived
     row mounts holding the reader's remembered answer, which this would undo. */
  const appliedSetting = React.useRef(openSetting)
  React.useEffect(() => {
    if (Object.is(appliedSetting.current, openSetting)) return
    appliedSetting.current = openSetting
    setLatched(latestDefault.current)
    setChosen(null)
  }, [openSetting, setChosen, setLatched])
  const expandable =
    plainBody !== undefined || (detail !== undefined && detail !== null && detail !== false)
  const { calmMotion } = useLayoutOptionsContext()
  const systemReducedMotion = useReducedMotion()
  const reduceMotion = calmMotion || systemReducedMotion
  const detailClipRef = React.useRef<HTMLDivElement>(null)
  const belowContent = typeof below === "function" ? below(open, setOpen) : below
  const active = status === "in_progress" || status === "pending"
  const failed = status === "failed"
  const runStart = (startedAt ?? 0) + (waitedMs ?? 0)
  const waiting = waitingSince !== undefined
  const ticking = useElapsed(runStart, active && startedAt !== undefined && !waiting)
  const elapsedMs = waiting && active && startedAt !== undefined ? Math.max(0, waitingSince - runStart) : ticking
  /* A step that has stopped, whose two ends both came with its updates: the
     figure is the step's own wall time and not this device's guess at it. A
     live counter cannot cover this — it stops ticking with the stream that fed
     it, and a reloaded transcript still has to say how long the step took. Same
     reading either way, so it takes the same gate and formatter below. */
  const settledMs =
    !active && startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
      ? Math.max(0, endedAt - startedAt - (waitedMs ?? 0))
      : null
  const runDir = React.useContext(StepDirContext)
  const d = runDir ?? dir ?? dominantTextDir(typeof target === "string" ? target : caption)
  /* This step's place in the batch it went out with, when it went out with one
     (`StepMarkerContext`): a step outside a batch has no key to look up and a
     batch has none for a row it did not send, so both answer nothing. */
  const places = React.useContext(StepMarkerContext)
  const place = persistKey === undefined ? undefined : places?.(persistKey)
  const variant = toolLayout && toolVariant ? toolVariantOf(toolLayout, toolVariant) : undefined
  const compact = toolLayout === "timeline" && variant === "compact"
  const minimal = toolLayout === "timeline" && variant === "minimal"

  return (
    <div
      dir={d}
      className={cn(
        compact && "-my-0.5",
        minimal && "my-0",
        toolLayout === "rail" &&
          cn(
            "my-1 border-s-2 ps-3",
            failed
              ? "border-destructive"
              : active
                ? "border-primary"
                : status === "completed"
                  ? "border-success"
                  : ""
          )
      )}
    >
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
          // The hover ground is 4px round the 24px line box's 20px disc — the
          // -mx-1/px-1 bleed and py-0.5 put the disc 4px from every edge, so
          // the corner is the disc's 10px + 4px = rounded-xl. The width is
          // calc(100% + 8px) so the bleed cancels on BOTH sides: a `w-full`
          // box only shifts left under a negative start margin, which left the
          // row's content edge 8px shy of the right edge messages run to.
          "group/step -mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-start gap-2 rounded-xl px-1 py-0.5 transition-colors duration-150",
          stackMeta && "flex-wrap @panel-sm:flex-nowrap",
          plain && "mx-0 w-full px-0 py-0 hover:bg-transparent",
          expandable && !plain && "hover:bg-muted",
          compact && "py-0",
          minimal && "py-0",
          toolLayout === "rail" && "mx-0 w-full hover:bg-muted"
        )}
      >
        <button
          type="button"
          disabled={!expandable}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={expandable ? open : undefined}
          className={cn("flex min-w-0 flex-1 items-start gap-2 text-start", plain && "gap-0", stackMeta && "basis-full @panel-sm:basis-0")}
        >
          {!plain && Icon && (
            <span
              className={cn(
                // h-6, not size-3.5: the mark has to occupy a whole line box, or
                // `items-start` would hang it off the top of the text it marks.
                // The row assembles mark → title → command (`harness-part-in`,
                // index.css); the mark is part 0 and states no `--part-i`.
                "harness-part-in relative flex h-6 w-5 shrink-0 items-center justify-center",
                failed
                  ? "text-destructive"
                  : (iconAccent ?? (active ? "text-primary" : "text-muted-foreground"))
              )}
            >
              {/* The accent's tile: a coloured mark wears its own tinted
                  background (`KIND_CHIPS`), and a failed one wears the red a
                  failure claims everywhere else. Absolute so the column's
                  geometry — which the rail is tuned to — does not move. */}
              {/* An opaque disc under the translucent tint: the run's rail
                  meets the mark at its edges, and a see-through mark read as
                  the line broken behind it. It takes the row's hover ground
                  with the row, so the disc never darkens a hovered line. */}
              {iconChip && (
                <span
                  aria-hidden
                  className={cn("absolute size-5 rounded-full bg-background transition-colors duration-150", expandable && "group-hover/step:bg-muted")}
                />
              )}
              {iconChip && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute size-5 rounded-full",
                    failed ? "bg-destructive/10" : (iconChip ?? "bg-muted")
                  )}
                />
              )}
              {Icon && (
                <Icon
                  className={cn(
                    "relative size-3 transition-opacity duration-100",
                    expandable && (open ? "opacity-0" : "group-hover/step:opacity-0")
                  )}
                />
              )}
              {expandable && (
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "absolute size-3.5 text-muted-foreground transition-[opacity,transform] duration-100",
                    d === "rtl" && "-scale-x-100",
                    open
                      ? d === "rtl" ? "-rotate-90 opacity-100" : "rotate-90 opacity-100"
                      : "opacity-0 group-hover/step:opacity-100"
                  )}
                />
              )}
            </span>
          )}
          {plain ? (
            <div className="min-w-0 flex-1 text-start text-sm leading-relaxed text-muted-foreground">
              {plainBody ? plainBody(open) : detail}
            </div>
          ) : (
            <span className="flex min-w-0 flex-1 flex-col">
              <div className="harness-part-in [--part-i:1] flex min-w-0 items-baseline gap-2">
                {place && <StepMarker label={place} />}
                <span
                  className={cn(
                    "min-w-0 truncate text-sm leading-6",
                    mono && "font-mono",
                    failed ? "text-destructive" : "text-muted-foreground",
                    active && "harness-shimmer"
                  )}
                >
                  {open && openTarget !== undefined ? openTarget : target}
                </span>
                {chip}
                {file && <FileBadge file={file} filePath={filePath} range={fileRange} />}
              </div>
              {caption && (
                <span
                  dir={dominantTextDir(caption)}
                  className={cn(
                    "harness-part-in [--part-i:2] -mt-1 min-w-0 truncate text-xs leading-5 text-muted-foreground",
                    dominantTextDir(caption) === "rtl" ? "text-right" : "text-left",
                    mono && "font-mono"
                  )}
                >
                  {caption}
                </span>
              )}
            </span>
          )}

        </button>
        {firstRow}
        {/* Every reading the row has, in one line box. The clock leads (it is
            the one that ticks), the caller's own readings follow, and the
            outcome word ends the line — a failure still claims the column, in
            its own colour, but at the group's size and not its own. */}
        <StepMeta
          className={stackMeta ? "ps-7 @panel-sm:ps-0" : undefined}
          parts={[
            /* A live clock waits two seconds before it ticks (a quick call
               should not flash a counter); a settled step always says how
               long it took, the quick ones included. */
            elapsedMs !== null ? (elapsedMs >= 2000 ? <ElapsedFigure ms={elapsedMs} /> : null) : settledMs !== null ? <ElapsedFigure ms={settledMs} /> : null,
            ...(metric ?? []),
            failed ? <span className="text-destructive">failed</span> : label,
          ]}
        />
        {control}
      </div>

      {/* The disclosure animates its own height so the surrounding transcript
          follows the content into place rather than jumping. Content is clipped
          only during this short transition; once open it returns to natural
          height and can stream or scroll normally. */}
      {belowContent && (
        <div className={cn("harness-fade-in mb-1 min-w-0", !belowFlush && !plain && "ps-7")}>{belowContent}</div>
      )}
      <AnimatePresence initial={false}>
        {expandable && open && !plain && (
          <m.div
            key="step-detail-clip"
            ref={detailClipRef}
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0, transition: reduceMotion ? { duration: 0 } : DISCLOSE_EXIT }}
            transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}
            onAnimationStart={() => {
              if (detailClipRef.current) detailClipRef.current.style.overflow = "hidden"
            }}
            onAnimationComplete={(definition) => {
              if (finishedOpening(definition) && detailClipRef.current) detailClipRef.current.style.overflow = "visible"
            }}
            /* `-mx-1` on the plain row's clip: the header's hover ground
               bleeds 4px past the content edge on each side, so a payload
               narrower than that left the two edges 4px apart. The rail
               layout's row does not bleed, so neither does its detail. */
            className={cn("overflow-hidden", toolLayout !== "rail" && "-mx-1")}
          >
            {/* Spacing lives inside the clip: a margin on the animated box is
                outside its height and snapped away after every collapse.
                Full width, not under the title column like `below`: a
                payload (a diff, a command's output, a JSON well) needs the
                column the mark would otherwise cost it. */}
            <div
              className={cn(
                "mt-1 mb-2 min-w-0 space-y-2",
                compact && "mt-1 mb-1 space-y-1",
                minimal && "mt-0 mb-1 space-y-1",
                toolLayout === "rail" && "mt-1 ps-3"
              )}
            >
              {detail}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  )
})
StepRow.displayName = "StepRow"
import { writeClipboard } from "@/lib/clipboard"
