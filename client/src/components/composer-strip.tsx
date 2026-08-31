/* ── Composer strip ──
   The shelf attached to the top of the composer. It is narrower than the
   composer and tucks its bottom edge behind it, so it reads as part of the
   same object rather than as a card floating above one — which is why the
   composer itself no longer needs a border to hold the two together.

   Generic on purpose: it is a stack, not a plan bar. Anything that belongs to
   the *turn* rather than to the message you are typing goes here — the plan,
   the queue of messages waiting on it, a diff summary tomorrow. Add a child; the strip
   hides itself when every child renders nothing (`empty:hidden`), so a shelf
   with nothing on it costs no pixels.

   The shelf shows one row. Left to itself it grew a row per concern — archive
   notice, draft scope, plan, todo list, approval, history notice, command menu
   — and six stacked rows push the composer up the screen and turn a glance
   into a read. So the rows now report a one-line `summary`. When the shelf is
   holding more than one thing the strip prints a single line that says what is
   on it ("Plan 2/5 · Permission needed · 3 commands") and the stack opens on
   click; a single row is already its own summary, so it stays open flat and
   its own disclosure works as before. Rows that must be acted on right now (an
   approval, the command menu you are typing into) declare themselves urgent and
   open the shelf on their own — a summary of a question is not a question. */
import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

/** What a row tells the strip about itself, so the strip can speak for it. */
type StripSummary = {
  id: string
  /** The words on the collapsed line. Short: this shares one line with others. */
  label: string
  /** Drawn before the label on the collapsed line. A component, not an element:
      the strip re-renders it itself, so a row can pass `ListChecksIcon` inline
      without handing the effect below a new object on every render. */
  icon?: React.ComponentType<{ className?: string }>
  /** Opens the shelf while present — the row is a question, not a status. */
  urgent?: boolean
}

type StripContext = {
  register: (summary: StripSummary) => void
  unregister: (id: string) => void
}

/* The order the collapsed line reads in, which is the order the rows are
   rendered in on the shelf. It cannot be discovered from registration: effects
   run children-first, so mount order is the reverse of DOM order and a row that
   arrives mid-turn would land wherever it happened to mount. Sorting by a fixed
   list keeps "Agent · Plan 2/5 · Permission needed" saying the same thing in
   the same places every time. Ids not listed here sort last, in mount order. */
const SUMMARY_ORDER = ["archived", "scope", "plan", "todos", "agents", "approval", "queue", "history", "slash"]

function summaryRank(id: string): number {
  const index = SUMMARY_ORDER.indexOf(id)
  return index === -1 ? SUMMARY_ORDER.length : index
}

const StripContext = React.createContext<StripContext | null>(null)

/**
 * Report a row's collapsed-line summary to the strip.
 *
 * Called by the row itself (only when it renders — a row that returns null
 * never registers, so the summary line never mentions it). `label` and `icon`
 * are read on every render, so a plan's "2/5" tracks the plan.
 */
export function useStripSummary(summary: StripSummary | null) {
  const strip = React.useContext(StripContext)
  const id = summary?.id
  const label = summary?.label
  const icon = summary?.icon
  const urgent = summary?.urgent

  React.useEffect(() => {
    if (!strip || !id) return
    strip.register({ id, label: label ?? "", icon, urgent })
  }, [strip, id, label, icon, urgent])

  /* Unregistering is its own effect keyed on the id alone: folded into the one
     above it would drop the row off the summary line and re-add it on every
     label change, which is a flicker on a line that is meant to be glanced at. */
  React.useEffect(() => {
    if (!strip || !id) return
    return () => strip.unregister(id)
  }, [strip, id])
}

export function ComposerStrip({ className, children, ...props }: React.ComponentProps<"div">) {
  const [summaries, setSummaries] = React.useState<StripSummary[]>([])
  const [open, setOpen] = React.useState(false)

  const register = React.useCallback((summary: StripSummary) => {
    setSummaries((prev) => {
      const index = prev.findIndex((s) => s.id === summary.id)
      if (index === -1) {
        return [...prev, summary].sort((a, b) => summaryRank(a.id) - summaryRank(b.id))
      }
      if (
        prev[index].label === summary.label &&
        prev[index].icon === summary.icon &&
        prev[index].urgent === summary.urgent
      ) {
        return prev
      }
      const next = [...prev]
      next[index] = summary
      return next
    })
  }, [])

  const unregister = React.useCallback((id: string) => {
    setSummaries((prev) => (prev.some((s) => s.id === id) ? prev.filter((s) => s.id !== id) : prev))
  }, [])

  const context = React.useMemo(() => ({ register, unregister }), [register, unregister])

  /* A row that needs an answer forces the shelf open and holds it there: while
     it is up, the collapsed line would be hiding the only thing on screen that
     is waiting on the user. It closes back to a summary when the row goes. */
  const urgent = summaries.some((summary) => summary.urgent)
  /* The children stay mounted in the same spot whether the shelf is one row or
     many — they are what register the summaries the closed line is made of.
     Swapping the wrapper around them would unmount and remount them on every
     transition, which is a flash of an empty shelf. So the outer collapsible is
     always present; only its trigger and the divider between it and the stack
     come and go. */
  const many = summaries.length > 1
  /* One row is already its own best summary: folding a single plan into
     "Plan 2/5" adds a click to what was a glance, and a lone approval is
     something to answer, not to summarise. So the shelf is only collapsible
     when it is holding more than one thing — a single row stays open flat, and
     its own disclosure (the plan's, the approval's buttons) behaves exactly as
     it did before the strip learned to collapse. */
  const expanded = many ? open || urgent : true

  return (
    <StripContext.Provider value={context}>
      <div
        data-slot="composer-strip"
        className={cn(
          // -mb-4/pb-4: the bottom four units sit behind the composer, which is
          // what makes the seam disappear. Keep the two in step.
          // Width follows the composer: minus whatever the composer actually is
          // (capped when there is room, 100% of the container when there is not)
          // the strip stays narrower, so it reads as tucked behind rather than
          // flush with it. The inset is 3rem of a wide composer and 1rem of a
          // cramped one: 3rem of a 360px column is a sixth of the shelf spent on
          // margin, and what it cost was the content — a queued message
          // truncated to three words. Measured against the panel, so a chat
          // squeezed beside a terminal gets the narrow inset the same way a
          // phone does.
          "mx-auto -mb-4 w-full max-w-[calc(min(100%,var(--harness-composer-width))_-_1rem)] @panel-sm:max-w-[calc(min(100%,var(--harness-composer-width))_-_3rem)]",
          "overflow-hidden rounded-t-xl bg-muted/70 pb-4 backdrop-blur-[14px]",
          // Nothing registered means nothing rendered: no summary line, no shelf.
          summaries.length === 0 && "hidden",
          className
        )}
        {...props}
      >
        <Collapsible open={expanded} onOpenChange={setOpen}>
          {many && (
            /* The one line. It is the whole shelf when closed, and the handle on
                the stack when open — kept visible either way so there is always
                somewhere to click to put the rows back. */
            <CollapsibleTrigger
              render={
                <button
                  type="button"
                  /* px-2: the strip's own gutter, the one every row sits in.
                     The taller touch row is the phone's: this is the handle
                     that opens the shelf, so it has to be hittable with a
                     thumb over a composer. */
                  className="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-accent/40 sm:py-1.5"
                />
              }
            >
              {/* One line, however many rows are behind it: each row's own words,
                  separated by a middot the way the transcript separates a step's
                  metadata. It truncates rather than wraps — the shelf stays one
                  row tall, and the stack underneath is where the detail lives. */}
              <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
                {summaries.map((summary, index) => (
                  <React.Fragment key={summary.id}>
                    {index > 0 && (
                      <span aria-hidden className="shrink-0 text-muted-foreground/40">
                        ·
                      </span>
                    )}
                    <span
                      className={cn(
                        "flex min-w-0 shrink items-center gap-1.5",
                        // The waiting row keeps its colour on the collapsed line:
                        // "permission needed" should not read like a status.
                        summary.urgent && "text-primary"
                      )}
                    >
                      {summary.icon && <summary.icon className="size-3 shrink-0" />}
                      {/* In a narrow panel the line has room for one set of
                          words, and three labels sharing it truncated all three
                          into initials. So only the first row — and any row that
                          is actually waiting on an answer — spends its label
                          there; the rest are their icon, which is what the eye
                          counts anyway. Everything reads in full from
                          `@panel-sm` up. */}
                      <span
                        className={cn(
                          "min-w-0 truncate",
                          index > 0 && !summary.urgent && "hidden @panel-sm:inline"
                        )}
                      >
                        {summary.label}
                      </span>
                    </span>
                  </React.Fragment>
                ))}
              </span>
              <span className="grid size-4 shrink-0 place-items-center">
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 text-muted-foreground transition-transform duration-200",
                    expanded && "rotate-180"
                  )}
                />
              </span>
              <span className="sr-only">{expanded ? "Hide details" : "Show details"}</span>
            </CollapsibleTrigger>
          )}
          {/* keepMounted is load-bearing, not a preference: Base UI's panel drops
              its children when closed, and the children are what register the
              summaries the closed line is made of — without it the line would
              empty itself the moment it collapsed and the shelf would flicker
              between "everything" and "nothing". */}
          <CollapsibleContent keepMounted className="harness-collapse">
            {/* The divider belongs to the summary handle: it is the seam between
                "what the shelf is" and "the rows that make it up", and has no
                meaning when the shelf is one flat row. */}
            {many && <div className="border-t border-border/40" />}
            {/* The shelf may not eat the screen. An expanded queue of ten
                messages, or a forty-step checklist, is taller than the panel
                — and the strip sits *under* the composer in the layout, so what
                a too-tall shelf pushes off the bottom is the thing you were
                typing into. Capped as a fraction of the panel (`--panel-h`,
                falling back to the viewport outside the dock), the overflow
                scrolls inside the shelf instead. `overscroll-contain` keeps that
                scroll off the transcript. The *fraction* is still the device's:
                a soft keyboard takes half the screen with it. */}
            <div className="max-h-[calc(var(--panel-h,100svh)*0.45)] overflow-y-auto overscroll-contain sm:max-h-[calc(var(--panel-h,100svh)*0.6)]">
              {children}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </StripContext.Provider>
  )
}

/** One shelf entry. Rows divide themselves so the strip stays layout-only.
 *
 * `summary` is what this row contributes to the collapsed line, and it is not
 * optional in practice: a row that reports nothing is a row that vanishes when
 * the shelf is closed. Components that own their whole row (the checklist, the
 * approval, the command menu) call `useStripSummary` directly instead. */
export function ComposerStripItem({
  className,
  summary,
  ...props
}: React.ComponentProps<"div"> & { summary?: Omit<StripSummary, "id"> & { id: string } }) {
  useStripSummary(summary ?? null)
  return (
    <div
      data-slot="composer-strip-item"
      className={cn("[&+&]:border-t [&+&]:border-border/40", className)}
      {...props}
    />
  )
}
