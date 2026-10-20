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

   Everything in the pile is **transient**, and that is the line. What is
   permanently true of the thread — the project it runs in, the tools it
   carries, how full its context is — is the **footer**: one row, always drawn,
   under everything, never a card. A fact that is always true does not belong in
   a pile whose whole mechanism is "which of these do you want in front right
   now" — the project spent its life as a card nobody ever brought forward, and
   then stopped being drawn at all the moment the thread started. The footer is
   also what holds the shelf open between turns, so the strip is a permanent
   object with a pile that comes and goes rather than the other way round.

   What does NOT go here is anything the turn has stopped on. A permission and a
   question are the end of the transcript, not state beside it, and they are
   drawn there (`tool-approval.tsx`, `elicitation-form.tsx`) on a card with room
   for the diff or plan you have to read before answering — a shelf capped at a
   fraction of the panel is the wrong place to read a document. The agent's own
   plan left for the same reason: it belongs at the point in the conversation
   where it was written — which is the whole of the split, because anything
   about the *turn* is at the foot of the transcript where the next thing will
   happen, and everything else is here. The connection that carries the message
   spent time on both sides of that line — a box above the shelf, then a reading
   on its floor — and is a `Notice` at the foot of the transcript now
   (`components/thread-view/thread-status.tsx`), where a sentence with a button belongs.
   So the shelf holds no *status*: everything on it is either a fact about the
   thread (the floor: project, tools, the context ring) or something about the
   message being typed (the pile), and none of it is ever wrong.

   ── The shelf is a selector rail and one reading panel ──
   Several transient concerns used to overlap as a stack of cards, with inactive
   cards reduced to icon-only slivers. The rail now names every active concern
   and its count; selecting a tab replaces the single panel below it. That makes
   the choices discoverable, gives each one a proper touch target, and keeps the
   shelf's height independent of how many rows are waiting.

   Panels stay mounted because their children register the summaries that fill
   the rail. Only the selected panel is visible or in the tab order. A lone row
   skips the selector entirely and keeps its direct, familiar presentation.

   ── Slots ──
   The strip does not know what its children are — that is the point of it — but
   showing one row at a time means knowing which child owns which summary. So
   every child is wrapped in a *slot* that publishes its index, and
   `useStripSummary` reports that index along with the summary. Nothing a row
   writes changes; the mapping is discovered from where the row was mounted.

   ── Motion ──
   The shelf sits under the composer in the layout, so every height change here
   moves the transcript above it. The selected panel is measured and the box
   animates to its height; switching rows or growing content moves the composer
   as one unit. Everything is off under `prefers-reduced-motion` (see
   `.harness-strip-*` in index.css). */
import * as React from "react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

/* ── The shelf's one horizontal inset ──
   Card content, the footer's row and the rail's own tab text all start at the
   same place, and it is one number rather than three. It used to be `px-2` on
   an attachment card, `px-3` on the footer and a `px-1` rail whose tab added
   its own `px-2`, so three left edges disagreed by up to 8px and the shelf
   looked assembled rather than laid out. The rail keeps its 4px of chrome
   gutter (see the tablist) and the tabs their own `px-2`, which lands their
   text on this same line while letting a selected tab's ground inset a hair
   from the corner. Exported so the caller that draws the footer — which lives
   on the other side of the composer's seam, in `draft-config.tsx` — insets by
   the same number rather than its own. */
export const SHELF_PAD = "px-3"

/** One rule for how a count is written wherever the strip draws one — the
    sliver, the footer bubble, the send row's picker. A bubble is 14px, so it
    caps at `9+`; a sliver has the room for `99+`. Never an inline ternary at a
    call site: three of them had already drifted apart. */
export function formatCount(count: number, cap: 9 | 99 = 9): string {
  return count > cap ? `${cap}+` : String(count)
}

/**
 * The count a shelf item wears, wherever it wears it.
 *
 * One chip for all of them: the rail's numeric badge, the corner bubble a
 * reading keeps on a narrow panel (`ReadingBubble` in `composer/indicator.tsx`)
 * and, by the same token, anything else that has to say "how many". It used to
 * be three sizes of the same idea — `9px` on the rail, `9px` padded wider on a
 * sliver, `8px` in the bubble — so the same number measured differently
 * depending on which dress it happened to be in. It is the stock `Badge` at a
 * bubble's size and nothing else: a count is a count, and a second tone on it
 * was a second meaning that did not exist.
 */
export function ChipBadge({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <Badge className={cn("h-4 min-w-4 px-1 text-[10px] tabular-nums", className)}>{children}</Badge>
  )
}

/** What a row tells the strip about itself, so the strip can speak for it. */
type StripSummary = {
  id: string
  /** The words on the row's sliver — as its `title` and its accessible name,
      since the sliver itself is only wide enough for the icon. */
  label: string
  /** Drawn in the sliver. A component, not an element: the strip re-renders it
      itself, so a row can pass `ListChecksIcon` inline without handing the
      effect below a new object on every render. */
  icon?: React.ComponentType<{ className?: string }>
  /** Takes the front while present — the row is a question, not a status. */
  urgent?: boolean
  /** Optional numeric badge shown in the sliver. Rows that track counts
      (attachments, queued messages, subagents) pass their count here so the
      pile surfaces it even when the card is behind. */
  badge?: number
}

/** A summary, plus where the row that reported it is mounted. */
type StripEntry = StripSummary & { slot: number }

type StripContext = {
  register: (entry: StripEntry) => void
  unregister: (id: string) => void
}

/* The order the pile reads in. It cannot be discovered from registration:
   effects run children-first, so mount order is the reverse of DOM order and a
   row that arrives mid-turn would land wherever it happened to mount. Sorting
   by a fixed list keeps a sliver in the same place every time — the pile is
   pointed at, and a control that moves under the cursor is a misclick. Ids not
   listed here sort last, in mount order.

   Only ids a row actually registers belong here — the `useStripSummary`
   callers, which are the pile's whole membership. A stale id costs nothing at
   runtime (it matches no entry) but it lies about what the pile can hold: the
   archive notice and the subagent count both spent time listed here after they
   had moved out of the pile and into the footer / above the strip. */
const SUMMARY_ORDER = [
  "attachments",
  "pastes",
  "history",
  "slash",
  "project-command",
  "mention",
]

function summaryRank(id: string): number {
  const index = SUMMARY_ORDER.indexOf(id)
  return index === -1 ? SUMMARY_ORDER.length : index
}

const StripContext = React.createContext<StripContext | null>(null)
/** Which slot the calling row is mounted in; -1 outside a strip. */
const SlotContext = React.createContext(-1)
/** Which slot is in front of the pile, or -1 — including when there is no pile. */
const OpenSlotContext = React.createContext(-1)

/**
 * True when this row is the card in front.
 *
 * A row with its own disclosure (the checklist, the queue, the agent list)
 * reads it so that bringing its card forward shows the thing the sliver named
 * rather than a second collapsed line to click through: the card in front IS
 * the open one. It is a default, not a lock — the row's own trigger still folds
 * it back — and it is false whenever the shelf is a single card, which is the
 * state the rows were written for and still behave exactly as before in.
 */
function useStripActive(): boolean {
  const slot = React.useContext(SlotContext)
  const open = React.useContext(OpenSlotContext)
  return slot !== -1 && slot === open
}

/**
 * A row's own open/closed, following the pile.
 *
 * Drop-in for the `useState(false)` a row with a disclosure would otherwise
 * hold: it opens when its card comes forward and closes when another card
 * takes the front, and in between it is the row's, so its own chevron still
 * works. The two are not the same disclosure — the pile says *which* row, this
 * says how much of it — but a card brought forward onto a second collapsed line
 * would be asking twice for one answer. It is also the only way to fold the
 * front card away, since a card in front has no sliver of its own to click.
 */
export function useStripDisclosure(): [boolean, (open: boolean) => void] {
  const active = useStripActive()
  const [open, setOpen] = React.useState(false)
  /* Assignment, not `||`: the row closes again when another card takes the
     front, so the next time it is brought forward it comes forward open rather
     than remembering a fold the user made three rows ago. */
  React.useEffect(() => setOpen(active), [active])
  return [open, setOpen]
}

/**
 * Report a row's sliver to the strip.
 *
 * Called by the row itself (only when it renders — a row that returns null
 * never registers, so the pile never holds a card for it). `label` and `icon`
 * are read on every render, so a plan's "2/5" tracks the plan.
 */
export function useStripSummary(summary: StripSummary | null) {
  const strip = React.useContext(StripContext)
  const slot = React.useContext(SlotContext)
  const id = summary?.id
  const label = summary?.label
  const icon = summary?.icon
  const urgent = summary?.urgent
  const badge = summary?.badge

  React.useEffect(() => {
    if (!strip || !id) return
    strip.register({ id, label: label ?? "", icon, urgent, badge, slot })
  }, [strip, id, label, icon, urgent, badge, slot])

  /* Unregistering is its own effect keyed on the id alone: folded into the one
     above it would drop the card off the pile and re-add it on every label
     change, which is a card that flies back in every time a count ticks. */
  React.useEffect(() => {
    if (!strip || !id) return
    return () => strip.unregister(id)
  }, [strip, id])
}

/* The shelf's one ground, everywhere it is seen: the front card, a card behind's
   sliver, the box itself on the way down, and the floor. It used to be a *tone*
   the connection could turn (see the header) — the surface of the unit carried
   the mood of the reading on it — and that went with the reading: a dead
   connection is a `Notice` in the transcript now, so nothing on the shelf is
   ever wrong and the shelf has exactly one colour. `--shelf` is derived from
   `--composer` per mode in index.css, so a generated palette gets it free. */
const GROUND = "bg-shelf"

/* The narrow layout's horizontal selector rail and the gap before its panel. */
const RAIL_HEIGHT = 32
const RAIL_GAP = 8

/* The shelf's own bottom edge, hidden behind the composer. Must stay in step
   with the `pb-4` it is spelled on: the box has to reserve it, and the pile's
   arithmetic has to know it is there. Whoever is *last* wears it — the footer
   when there is one, the cards when there is not. Two things wearing it would
   reserve it twice. */
const TUCK = 16
/* Keep an empty shelf mounted until its measured height has folded away. */
const STOW_MS = 320

export function ComposerStrip({
  className,
  children,
  footer,
  ...props
}: React.ComponentProps<"div"> & {
  /** The one row that is always there, under the pile: what is permanently
      true of the thread (project, tools, the context ring). It is not a card —
      it registers no sliver, never goes behind, and holds the shelf open when
      the pile is empty. See the note at the top of this file. */
  footer?: React.ReactNode
}) {
  const [entries, setEntries] = React.useState<StripEntry[]>([])
  const stripRef = React.useRef<HTMLDivElement>(null)
  const [wideLayout, setWideLayout] = React.useState(false)
  /** The card the user last brought forward. Urgency outranks it; it is
      remembered underneath, so a command menu that comes and goes gives the
      shelf back. */
  const [picked, setPicked] = React.useState<string | null>(null)
  /* The surface every part of the shelf wears — see `GROUND`. */
  const ground = GROUND

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
        current.badge === entry.badge &&
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

  React.useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setWideLayout(entry.contentRect.width >= 560)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* One card is already its own best summary: folding a single checklist behind
     a sliver adds a click to what was a glance. So a shelf holding one row is
     that row, with no sliver above it and its own disclosure (the checklist's,
     the queue's) behaving exactly as it did before the strip learned to hold
     several. */
  const many = entries.length > 1
  /* A row that needs an answer takes the front and holds it: while it is up,
     anything else the shelf could be showing is not the thing waiting on the
     user. The pick underneath it is untouched and comes back when it goes.
     Falling through to the first card is what makes the pile always have a
     front — there is no "nothing open" to reach, because a card in front has no
     sliver to close it with; folding is the row's own disclosure. */
  const urgent = entries.find((entry) => entry.urgent)
  const activeId =
    urgent?.id ??
    (entries.some((entry) => entry.id === picked) ? picked : null) ??
    entries[0]?.id ??
    null
  const activeSlot = entries.find((entry) => entry.id === activeId)?.slot ?? -1

  /* A second card arriving must not bury the one you were reading. A lone card
     is the front card without a sliver, so when the pile forms the card that
     was alone is the card that stays in front — otherwise attaching a file
     mid-checklist would drop the checklist behind and answer a question nobody
     asked. One shot, on the single→pile edge only: keyed on `picked` it would
     bring the card back the moment the user chose another. */
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

  /* The front card's height, measured rather than guessed: the pile animates
     between two *numbers*, which is what makes bringing a twelve-step checklist
     out from behind a three-line queue a move rather than a jump. Observed, so
     a list that gains a step while it is in front grows with the same curve.
     Re-observed when the front changes, because the ref moves with it. */
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
  }, [activeSlot])

  /* The footer's height, measured for the same reason the front card's is: it
     is part of the box's height, and it changes with the row inside it (a
     project name wrapping, the ring appearing on the first usage report). */
  const footerRef = React.useRef<HTMLDivElement>(null)
  const [footerHeight, setFooterHeight] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = footerRef.current
    if (!el) {
      setFooterHeight(0)
      return
    }
    const read = () => setFooterHeight(el.getBoundingClientRect().height)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [!!footer])

  /* Nothing to draw at all. A shelf with a footer is never this: the footer is
     the reason the shelf exists between turns, so it neither folds nor stows. */
  const empty = entries.length === 0 && !footer

  /* Out of the layout once the fold has finished, and back in the frame
     anything registers. Timed rather than driven off `transitionend`: a shelf
     that was already closed never fires one, and the ring and the tucked
     bottom edge of a 0-height shelf would sit behind the composer forever. */
  const [stowed, setStowed] = React.useState(true)
  React.useEffect(() => {
    if (!empty) {
      setStowed(false)
      return
    }
    const timer = setTimeout(() => setStowed(true), STOW_MS)
    return () => clearTimeout(timer)
  }, [empty])

  /* The selector is horizontal in a narrow panel and becomes a vertical rail
     in a wider panel. The measurement follows the panel, not the viewport. */
  const railHeight = many && !wideLayout ? RAIL_HEIGHT + RAIL_GAP : 0
  /* The tuck belongs to whatever is last. With a footer the cards stand ON it
     rather than on the composer, so they stop reserving a bottom edge nothing
     covers — and the footer takes the `pb-4` instead. */
  const tuck = footer ? 0 : TUCK
  const height = (entries.length === 0 ? 0 : railHeight + bodyHeight + tuck) + footerHeight

  const onRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")]
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (index === -1) return
    event.preventDefault()
    const step = event.key === "ArrowRight" ? 1 : -1
    const next = tabs[(index + step + tabs.length) % tabs.length]
    next?.focus()
    next?.click()
  }

  /* Keep every row mounted so it can keep reporting its summary, but show only
     the selected panel. Unlike the old overlapping pile, every panel starts at
     the same place under the selector rail. */
  const cards = React.Children.toArray(children).map((child, index) => {
    const entry = entries.find((item) => item.slot === index)
    const front = entry != null && entry.id === activeId
    return (
      <div
        key={React.isValidElement(child) ? (child.key ?? index) : index}
        id={entry ? `composer-strip-panel-${entry.id}` : undefined}
        role={many && entry ? "tabpanel" : undefined}
        aria-labelledby={many && entry ? `composer-strip-tab-${entry.id}` : undefined}
        data-strip-slot=""
        data-front={front ? "" : undefined}
        hidden={!front}
        className={cn(
          "harness-strip-card absolute inset-x-0 overflow-hidden rounded-t-composer",
          front && cn("backdrop-blur-[var(--app-blur)]", ground)
        )}
        style={{ top: railHeight, bottom: footerHeight + tuck }}
      >
        <div
          ref={front ? bodyRef : undefined}
          data-strip-body=""
          data-front={front ? "" : undefined}
          className={cn(
            "max-h-[calc(var(--panel-h,100svh)*0.45)] overflow-y-auto overscroll-contain sm:max-h-[calc(var(--panel-h,100svh)*0.6)]",
            entry && !front && "hidden"
          )}
        >
          <SlotContext.Provider value={index}>{child}</SlotContext.Provider>
        </div>
      </div>
    )
  })

  return (
    <StripContext.Provider value={context}>
      <div
        ref={stripRef}
        data-slot="composer-strip"
        data-wide={wideLayout ? "" : undefined}
        style={{ height }}
        className={cn(
          // The selector rail and selected panel share one measured height
          // transition, so changing rows does not jump the composer or transcript.
          "harness-strip-panel relative",
          /* The rail's w-32 plus `RAIL_GAP`. */
          many && wideLayout && "pl-34",
          // isolate: the composer is `relative z-10` beside this box. Without a
          // stacking context, the shelf could paint over the thing it attaches to.
          "isolate",
          // -mb-4: the shelf's own bottom four units (the `pb-4` on the footer,
          // or on the panel when there is none — TUCK above) sit behind the composer.
          // The shelf wears its own surface against the composer, preserving
          // the tuck and distinguishing the strip from the input card.
          // Width follows the composer: minus whatever the composer actually is
          // (capped when there is room, 100% of the container when there is not)
          // the strip stays narrower, so it reads as tucked behind rather than
          // flush with it. Fixed px offsets — narrower on mobile (40px) for a
          // more tucked look on cramped screens, tighter on desktop (32px) where
          // the shelf has room. rem values scaled differently across viewport
          // sizes; px keeps the visual gap predictable. Measured against the
          // panel, so a chat squeezed beside a terminal gets the narrow inset
          // the same way a phone does. (16/8px read as flush with the composer;
          // 40/32 is where the tuck is actually visible.)
          "mx-auto -mb-4 w-full max-w-[calc(min(100%,var(--harness-composer-width))_-_40px)] @panel-sm:max-w-[calc(min(100%,var(--harness-composer-width))_-_32px)]",
          // The fold has nothing left to draw — the last card unregistered the
          // frame the shelf emptied — so the box wears the surface itself on
          // the way down. Without it the composer would jump rather than slide.
          // Never with a footer: that surface is already down there, and a
          // second one over it would wash the row it is under.
          empty && !stowed && cn("overflow-hidden rounded-t-composer", ground),
          // Nothing registered and the fold finished: no pile, no shelf.
          stowed && empty && "hidden",
          className
        )}
        {...props}
      >
        {many && (
          <div
            role="tablist"
            aria-label="Composer shelf"
            onKeyDown={onRailKeyDown}
            className={cn(
              "absolute z-20 flex min-w-0 gap-1",
              wideLayout
                ? "inset-y-0 left-0 w-32 flex-col items-stretch overflow-y-auto rounded-tl-composer p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                : "inset-x-0 top-0 h-8 flex-row items-center overflow-x-auto rounded-t-composer px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            )}
          >
            {entries.map((entry) => {
              const Icon = entry.icon
              const selected = entry.id === activeId
              return (
                <button
                  key={entry.id}
                  type="button"
                  id={`composer-strip-tab-${entry.id}`}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`composer-strip-panel-${entry.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setPicked(entry.id)}
                  className={cn(
                    "inline-flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-full px-2 text-left text-xs font-medium transition-colors",
                    wideLayout && "w-full justify-start",
                    selected
                      ? "bg-composer text-foreground ring-1 ring-foreground/10"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  )}
                >
                  {Icon && <Icon className="size-4 shrink-0" />}
                  <span className="max-w-36 truncate">{entry.label}</span>
                  {entry.badge != null && entry.badge > 0 && (
                    <ChipBadge>{formatCount(entry.badge, 99)}</ChipBadge>
                  )}
                </button>
              )
            })}
          </div>
        )}
        <OpenSlotContext.Provider value={many ? activeSlot : -1}>{cards}</OpenSlotContext.Provider>
        {/* The floor of the shelf. It wears the surface the way a card does,
            and squares its top off the moment a card stands on it — a rounded
            corner under a card's square one is a notch of transcript showing
            through the seam. It carries the tuck (`pb-4`) the cards give up,
            so the shelf still ends behind the composer. */}
        {footer && (
          <div
            ref={footerRef}
            data-strip-footer=""
            className={cn(
              "absolute inset-x-0 bottom-0 pb-4",
              /* `--shelf`, never the composer's `--composer`: the strip is a
                 surface of its own, and wearing the box's ground made the two
                 one flat band. The shelf token is derived from the composer and
                 sits a step away from it in both modes (light: darker toward the
                 foreground; dark: darker toward the background), so the strip
                 reads as a distinct object under the box it belongs to. No
                 ring: the difference in ground is what separates them, and the
                 composer's own hairline draws the seam. Every card above it wears the same surface, and so does
                 the box on the way down — one colour for the whole shelf,
                 because nothing on it is ever wrong (see `GROUND`). */
              ground,
              entries.length === 0 && "rounded-t-composer"
            )}
          >
            {footer}
          </div>
        )}
      </div>
    </StripContext.Provider>
  )
}

/** One card in the pile. Rows divide themselves so the strip stays layout-only.
 *
 * `summary` is what this row contributes to the pile, and it is not optional in
 * practice: a row that reports nothing is a row with no card, which is a row
 * that does not appear. Components that own their whole row (the checklist, the
 * queue, the command menu) call `useStripSummary` directly instead. */
export function ComposerStripItem({
  className,
  summary,
  ...props
}: React.ComponentProps<"div"> & { summary?: Omit<StripSummary, "id"> & { id: string } }) {
  useStripSummary(summary ?? null)
  return <div data-slot="composer-strip-item" className={className} {...props} />
}
