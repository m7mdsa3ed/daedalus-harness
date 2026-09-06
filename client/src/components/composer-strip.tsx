/* ── Composer strip ──
   The shelf attached to the top of the composer. It is narrower than the
   composer and tucks its bottom edge behind it, so it reads as part of the
   same object rather than as a card floating above one — which is why the
   composer itself no longer needs a border to hold the two together.

   Generic on purpose: it is a stack, not a plan bar. Anything that is *state
   you consult while typing* goes here — the checklist, the queue of messages
   waiting on the turn, what is running. Add a child; the strip hides itself
   when every child renders nothing, so a shelf with nothing on it costs no
   pixels.

   What does NOT go here is anything the turn has stopped on. A permission and a
   question are the end of the transcript, not state beside it, and they are
   drawn there (`tool-approval.tsx`, `elicitation-form.tsx`) on a card with room
   for the diff or plan you have to read before answering — a shelf capped at a
   fraction of the panel is the wrong place to read a document. The agent's own
   plan left for the same reason: it belongs at the point in the conversation
   where it was written.

   ── The shelf shows one row, and holding several is a rail of tabs ──
   Left to itself the shelf grew a row per concern — archive notice, draft
   scope, todo list, history notice, command menu — and stacked rows push the
   composer up the screen and turn a glance into a read. The first fix was one
   collapsed line of middot-joined labels that opened the whole stack at once,
   which traded one problem for two: the closed line was a sentence nobody could
   click a *part* of, and opening it put every row on screen at the same time,
   which is the stack again with an extra click in front of it.

   So a shelf holding more than one thing is a **rail of chips, one per row**,
   and **at most one row is open under it**. Each row reports a one-line
   `summary` (`useStripSummary`); the strip turns each into a chip you can point
   at, and opening one closes the last. The shelf is therefore always the rail
   plus at most one row tall, whatever is on it — a queue, a checklist and a
   file list cost the same height as any one of them, and the thing you asked
   for is the thing you get. A single row skips the rail entirely and stays open
   flat: it is already its own summary, and folding it behind a chip would add a
   click to what was a glance. Rows that must be acted on right now (the command
   menu you are typing into) declare themselves urgent and take the rail over
   while they are up, handing it back to whatever you had picked when they go.

   ── Slots ──
   The strip does not know what its children are — that is the point of it — but
   showing one row at a time means knowing which child owns which summary. So
   every child is wrapped in a *slot* that publishes its index, and
   `useStripSummary` reports that index along with the summary. Nothing a row
   writes changes; the mapping is discovered from where the row was mounted.
   Hidden slots keep their children **mounted** (`hidden`, never unmounted):
   the children are what register the summaries the rail is made of, and a row
   that unmounts when it is not the open one would delete its own chip.

   ── Motion ──
   The shelf sits under the composer in the layout, so every height change here
   moves the transcript above it. They are all one measured transition: the open
   row's height is observed and animated, which covers opening, closing,
   switching between rows of different heights, and a row that grows under you
   (a checklist gaining a step). The rail's active pill slides between chips
   rather than blinking on, a chip pops in as its row arrives, and the row
   itself rises as it takes the panel. Everything is off under
   `prefers-reduced-motion` (see `.harness-strip-*` in index.css). */
import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { useCoarsePointer } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

/** What a row tells the strip about itself, so the strip can speak for it. */
type StripSummary = {
  id: string
  /** The words on the row's chip. Short: the rail is one line of them. */
  label: string
  /** Drawn before the label on the chip. A component, not an element: the
      strip re-renders it itself, so a row can pass `ListChecksIcon` inline
      without handing the effect below a new object on every render. */
  icon?: React.ComponentType<{ className?: string }>
  /** Takes the rail while present — the row is a question, not a status. */
  urgent?: boolean
}

/** A summary, plus where the row that reported it is mounted. */
type StripEntry = StripSummary & { slot: number }

type StripContext = {
  register: (entry: StripEntry) => void
  unregister: (id: string) => void
}

/* The order the rail reads in. It cannot be discovered from registration:
   effects run children-first, so mount order is the reverse of DOM order and a
   row that arrives mid-turn would land wherever it happened to mount. Sorting
   by a fixed list keeps a chip in the same place every time — the rail is
   pointed at, and a control that moves under the cursor is a misclick. Ids not
   listed here sort last, in mount order. */
const SUMMARY_ORDER = [
  "archived",
  "scope",
  "todos",
  "agents",
  "queue",
  "attachments",
  "history",
  "slash",
  "mention",
]

function summaryRank(id: string): number {
  const index = SUMMARY_ORDER.indexOf(id)
  return index === -1 ? SUMMARY_ORDER.length : index
}

const StripContext = React.createContext<StripContext | null>(null)
/** Which slot the calling row is mounted in; -1 outside a strip. */
const SlotContext = React.createContext(-1)
/** Which slot the rail has opened, or -1 — including when there is no rail. */
const OpenSlotContext = React.createContext(-1)

/**
 * True when the rail opened *this* row.
 *
 * A row with its own disclosure (the checklist, the queue, the agent list)
 * reads it so that picking its chip shows the thing the chip named rather than
 * a second collapsed line to click through: the chip IS the collapsed line. It
 * is a default, not a lock — the row's own trigger still folds it back — and it
 * is false whenever the shelf is flat (one row, no rail), which is the state
 * the rows were written for and still behave exactly as before in.
 */
function useStripActive(): boolean {
  const slot = React.useContext(SlotContext)
  const open = React.useContext(OpenSlotContext)
  return slot !== -1 && slot === open
}

/**
 * A row's own open/closed, following the rail.
 *
 * Drop-in for the `useState(false)` a row with a disclosure would otherwise
 * hold: it opens when the rail picks this row and closes when the rail moves
 * on, and in between it is the row's, so its own chevron still works. The two
 * are not the same disclosure — the chip says *which* row, this says how much
 * of it — but a chip that opened a row onto a second collapsed line would be
 * asking twice for one answer.
 */
export function useStripDisclosure(): [boolean, (open: boolean) => void] {
  const active = useStripActive()
  const [open, setOpen] = React.useState(false)
  /* Assignment, not `||`: the row closes again when the rail moves to another
     chip, so the next time it is picked it is picked open rather than
     remembering a fold the user made three rows ago. */
  React.useEffect(() => setOpen(active), [active])
  return [open, setOpen]
}

/**
 * Report a row's chip to the strip.
 *
 * Called by the row itself (only when it renders — a row that returns null
 * never registers, so the rail never mentions it). `label` and `icon` are read
 * on every render, so a plan's "2/5" tracks the plan.
 */
export function useStripSummary(summary: StripSummary | null) {
  const strip = React.useContext(StripContext)
  const slot = React.useContext(SlotContext)
  const id = summary?.id
  const label = summary?.label
  const icon = summary?.icon
  const urgent = summary?.urgent

  React.useEffect(() => {
    if (!strip || !id) return
    strip.register({ id, label: label ?? "", icon, urgent, slot })
  }, [strip, id, label, icon, urgent, slot])

  /* Unregistering is its own effect keyed on the id alone: folded into the one
     above it would drop the row off the rail and re-add it on every label
     change, which is a chip that pops in again every time a count ticks. */
  React.useEffect(() => {
    if (!strip || !id) return
    return () => strip.unregister(id)
  }, [strip, id])
}

/** Where the rail's active pill is, in the rail's own coordinates. `first` is
    the placement that must not animate — sliding in from the left edge on the
    frame the rail appears is a swipe nobody asked for. */
type Pill = { x: number; y: number; w: number; h: number; first: boolean }

/* How long the shelf takes to fold away before it is taken out of the layout.
   A little longer than the panel's own transition (`.harness-strip-panel`,
   280ms) — the stow is what keeps a 0-height shelf from leaving its ring and
   its tucked padding behind the composer, and taking it away early cuts the
   fold off halfway. */
const STOW_MS = 320

export function ComposerStrip({ className, children, ...props }: React.ComponentProps<"div">) {
  const [entries, setEntries] = React.useState<StripEntry[]>([])
  /** The chip the user last picked. Urgency outranks it; it is remembered
      underneath, so a command menu that comes and goes gives the shelf back. */
  const [picked, setPicked] = React.useState<string | null>(null)
  const coarse = useCoarsePointer()
  const panelId = React.useId()

  const register = React.useCallback((entry: StripEntry) => {
    setEntries((prev) => {
      const index = prev.findIndex((s) => s.id === entry.id)
      if (index === -1) {
        return [...prev, entry].sort((a, b) => summaryRank(a.id) - summaryRank(b.id))
      }
      const current = prev[index]
      if (
        current.label === entry.label &&
        current.icon === entry.icon &&
        current.urgent === entry.urgent &&
        current.slot === entry.slot
      ) {
        return prev
      }
      const next = [...prev]
      next[index] = entry
      return next
    })
  }, [])

  const unregister = React.useCallback((id: string) => {
    setEntries((prev) => (prev.some((s) => s.id === id) ? prev.filter((s) => s.id !== id) : prev))
  }, [])

  const context = React.useMemo(() => ({ register, unregister }), [register, unregister])

  /* One row is already its own best summary: folding a single checklist behind
     a "Todos 2/5" chip adds a click to what was a glance. So the rail is only
     drawn when the shelf is holding more than one thing — a single row stays
     open flat, and its own disclosure (the checklist's, the queue's) behaves
     exactly as it did before the strip learned to hold several. */
  const many = entries.length > 1
  /* A row that needs an answer takes the panel and holds it: while it is up,
     anything else the shelf could be showing is not the thing waiting on the
     user. The pick underneath it is untouched and comes back when it goes. */
  const urgent = entries.find((entry) => entry.urgent)
  const activeId = many
    ? (urgent?.id ?? (entries.some((entry) => entry.id === picked) ? picked : null))
    : (entries[0]?.id ?? null)
  const activeSlot = entries.find((entry) => entry.id === activeId)?.slot ?? -1

  /* A second row arriving must not close the one you were reading. A flat shelf
     is an open row without a chip, so when the rail appears the row that was
     flat is the row that stays open — otherwise attaching a file mid-checklist
     would fold the checklist away and answer a question nobody asked. One shot,
     on the flat→rail edge only: keyed on `picked` it would re-open the row the
     moment the user closed it. */
  const lone = many ? null : (entries[0]?.id ?? null)
  const lastLone = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (lone) lastLone.current = lone
  }, [lone])
  const wasFlat = React.useRef(true)
  React.useEffect(() => {
    if (many && wasFlat.current && lastLone.current) setPicked(lastLone.current)
    wasFlat.current = !many
  }, [many])

  /* The open row's height, measured rather than guessed: the panel animates
     between two *numbers*, which is what makes switching from a three-line
     queue to a twelve-step checklist a move rather than a jump. Observed, so a
     list that gains a step while it is open grows with the same curve. */
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const [bodyHeight, setBodyHeight] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const read = () => setBodyHeight(el.getBoundingClientRect().height)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* Out of the layout once the fold has finished, and back in the frame
     anything registers. Timed rather than driven off `transitionend`: a shelf
     that was already closed never fires one, and the ring and the tucked
     bottom edge of a 0-height shelf would sit behind the composer forever. */
  const [stowed, setStowed] = React.useState(true)
  React.useEffect(() => {
    if (entries.length > 0) {
      setStowed(false)
      return
    }
    const timer = setTimeout(() => setStowed(true), STOW_MS)
    return () => clearTimeout(timer)
  }, [entries.length])

  /* The pill behind the active chip. Measured off the chip itself so it is the
     chip's exact box whatever the label says, and re-measured when the rail
     resizes — a panel dragged narrower rewraps the labels under it. */
  const railRef = React.useRef<HTMLDivElement>(null)
  const placed = React.useRef(false)
  const [pill, setPill] = React.useState<Pill | null>(null)
  React.useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail || !activeId) {
      placed.current = false
      setPill(null)
      return
    }
    const measure = () => {
      const chip = rail.querySelector<HTMLElement>(`[data-chip="${CSS.escape(activeId)}"]`)
      if (!chip) {
        placed.current = false
        setPill(null)
        return
      }
      const first = !placed.current
      placed.current = true
      setPill({ x: chip.offsetLeft, y: chip.offsetTop, w: chip.offsetWidth, h: chip.offsetHeight, first })
      /* An urgent row picks itself, and the chip it picked may be off the end
         of a rail scrolled sideways in a narrow panel. `nearest` on both axes:
         nothing above this may scroll, least of all a transcript. */
      chip.scrollIntoView({ block: "nearest", inline: "nearest" })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(rail)
    return () => observer.disconnect()
  }, [activeId, entries])

  /* Arrow keys walk the rail, the way they walk any row of tabs. Focus only —
     picking is still a click or a Space/Enter, because moving through the chips
     should not open four rows in a row on the way past. */
  const onRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
    const rail = railRef.current
    if (!rail) return
    const chips = [...rail.querySelectorAll<HTMLElement>("[data-chip]")]
    const index = chips.indexOf(document.activeElement as HTMLElement)
    if (index === -1) return
    event.preventDefault()
    const step = event.key === "ArrowRight" ? 1 : -1
    chips[(index + step + chips.length) % chips.length]?.focus()
  }

  /* One slot per child, in the order they were written. The wrapper is what
     lets the strip hide the rows it is not showing without knowing what any of
     them are; the key is the one `Children.toArray` assigns, which counts the
     conditional children that render nothing — so a notice appearing above the
     scope row shifts nobody's identity and remounts nothing. */
  const slots = React.Children.toArray(children).map((child, index) => (
    <div
      key={React.isValidElement(child) ? (child.key ?? index) : index}
      data-strip-slot=""
      data-active={index === activeSlot ? "" : undefined}
      className={cn(index !== activeSlot && "hidden")}
    >
      <SlotContext.Provider value={index}>{child}</SlotContext.Provider>
    </div>
  ))

  return (
    <StripContext.Provider value={context}>
      <div
        data-slot="composer-strip"
        className={cn(
          // -mb-4/pb-4: the bottom four units sit behind the composer, which is
          // what makes the seam disappear. Keep the two in step.
          // The shelf wears the `--surface` token against the composer's
          // `--composer`, so the two read as separate objects with a visible
          // seam rather than one flat band, and the tucked bottom edge sits
          // behind the card.
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
          "overflow-hidden rounded-t-xl bg-surface/70 pb-4 ring-1 ring-foreground/5 backdrop-blur-xl backdrop-saturate-150 dark:ring-foreground/10",
          // Nothing registered and the fold finished: no rail, no shelf.
          stowed && entries.length === 0 && "hidden",
          className
        )}
        {...props}
      >
        {many && (
          /* The rail. It is the whole shelf when nothing is open, and the
             handle on the open row otherwise — visible either way, so there is
             always somewhere to point at to put a row back. */
          <div
            ref={railRef}
            role="group"
            aria-label="Composer shelf"
            onKeyDown={onRailKeyDown}
            className={cn(
              // px-1.5: half the strip's own gutter, because the chips carry
              // the other half in their own padding and a chip's wash should
              // start where a row's text starts.
              "relative flex items-center gap-1 overflow-x-auto px-1.5 py-1.5",
              "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            )}
          >
            {pill && (
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute left-0 top-0 rounded-lg bg-accent",
                  !pill.first && "harness-strip-pill"
                )}
                style={{
                  transform: `translate3d(${pill.x}px, ${pill.y}px, 0)`,
                  width: pill.w,
                  height: pill.h,
                }}
              />
            )}
            {entries.map((entry) => {
              const open = entry.id === activeId
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-chip={entry.id}
                  aria-expanded={open}
                  aria-controls={panelId}
                  /* The name is stated rather than read off the chip: in a
                     narrow panel every label but the open one is `hidden`,
                     which takes it out of the accessibility tree too and
                     leaves a button called nothing. */
                  aria-label={entry.label}
                  onClick={() => setPicked(open && !entry.urgent ? null : entry.id)}
                  className={cn(
                    "harness-strip-chip relative z-10 flex min-w-0 shrink-0 items-center gap-1.5 rounded-lg text-[11px] transition-colors",
                    coarse ? "h-8 px-2.5" : "h-6 px-2",
                    open
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                    // The waiting row keeps its colour on the rail: "3 commands"
                    // while you are arrow-keying through them is not a status.
                    entry.urgent && "text-primary"
                  )}
                >
                  {entry.icon && <entry.icon className="size-3 shrink-0" />}
                  {/* In a narrow panel the rail has room for one set of words,
                      and four labels sharing it truncated all four into
                      initials. So the open chip — and any row actually waiting
                      on an answer — spends its label there; the rest are their
                      icon, which is what the eye counts anyway. Everything
                      reads in full from `@panel-sm` up. */}
                  <span
                    className={cn(
                      "max-w-40 min-w-0 truncate",
                      !open && !entry.urgent && "hidden @panel-sm:inline"
                    )}
                  >
                    {entry.label}
                  </span>
                  {open && (
                    <ChevronDownIcon
                      aria-hidden
                      className="size-3 shrink-0 rotate-180 text-muted-foreground"
                    />
                  )}
                </button>
              )
            })}
          </div>
        )}
        {/* The one moving part. Height is the open row's, measured; nothing
            below it needs to know which row that is. */}
        <div
          id={panelId}
          className="harness-strip-panel overflow-hidden"
          style={{ height: activeSlot === -1 ? 0 : bodyHeight }}
        >
          {/* The shelf may not eat the screen. An expanded queue of ten
              messages, or a forty-step checklist, is taller than the panel —
              and the strip sits *under* the composer in the layout, so what a
              too-tall shelf pushes off the bottom is the thing you were typing
              into. Capped as a fraction of the panel (`--panel-h`, falling back
              to the viewport outside the dock), the overflow scrolls inside the
              shelf instead. `overscroll-contain` keeps that scroll off the
              transcript. The *fraction* is still the device's: a soft keyboard
              takes half the screen with it. This is also the element the height
              above is read from, so what is animated is the capped height and
              not the content's. */}
          <div
            ref={bodyRef}
            className="max-h-[calc(var(--panel-h,100svh)*0.45)] overflow-y-auto overscroll-contain sm:max-h-[calc(var(--panel-h,100svh)*0.6)]"
          >
            {/* The divider belongs to the rail: it is the seam between "what
                the shelf is holding" and "the row you opened", and has no
                meaning when the shelf is one flat row. */}
            {many && <div className="border-t border-border/40" />}
            {/* -1 while the shelf is flat: a lone row keeps its own default,
                which is closed, because nobody picked it and there is no chip
                saying what it holds. */}
            <OpenSlotContext.Provider value={many ? activeSlot : -1}>
              {slots}
            </OpenSlotContext.Provider>
          </div>
        </div>
      </div>
    </StripContext.Provider>
  )
}

/** One shelf entry. Rows divide themselves so the strip stays layout-only.
 *
 * `summary` is what this row contributes to the rail, and it is not optional in
 * practice: a row that reports nothing is a row with no chip, which on a shelf
 * holding several is a row with no way in. Components that own their whole row
 * (the checklist, the queue, the command menu) call `useStripSummary` directly
 * instead. */
export function ComposerStripItem({
  className,
  summary,
  ...props
}: React.ComponentProps<"div"> & { summary?: Omit<StripSummary, "id"> & { id: string } }) {
  useStripSummary(summary ?? null)
  return <div data-slot="composer-strip-item" className={className} {...props} />
}
