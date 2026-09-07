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
   where it was written.

   ── The shelf is a pile of cards, one in front ──
   Left to itself the shelf grew a row per concern — archive notice, draft
   scope, todo list, history notice, command menu — and stacked rows push the
   composer up the screen and turn a glance into a read. One collapsed line of
   middot-joined labels traded that for a sentence nobody could click a *part*
   of; a rail of chips over one open row fixed the clicking and cost a flat
   34px of chrome whether the shelf held two rows or six, spent on naming rows
   that were already sitting right there.

   So the shelf is a **pile**: every row is a card, they all share one box, and
   the one in front is open. The cards behind are lifted by a **peek** and show
   nothing but their own icon in that sliver — which is the chip, lying down.
   Clicking a sliver brings that card to the front. Two rows cost one peek, and
   the pile stops growing at three behind, so the chrome is 14–42px where the
   rail was always 35 and the "what else is on the shelf" question is answered
   by looking rather than by reading labels.

   The peek is icon-only because 14px is what a pile can afford and a 12px icon
   is the largest thing that fits under a 16.5px line box — so every sliver
   carries `title` and `aria-label`, which is the rule for any icon-only
   control. On a coarse pointer it is 20px, because the sliver is the tap
   target.

   Cards are **height-normalised to the front one** (the trick the toast pile
   uses, `ui/toast.tsx`): a card shorter than the front card would be swallowed
   whole and no amount of lifting would expose it. So every card is the front
   card's height, its own body `hidden` until it is the front — hidden, never
   unmounted, because the children are what register the slivers the pile is
   made of and a row that unmounted when it was not in front would delete its
   own sliver, and `hidden` keeps a card behind out of the tab order too.

   ── Slots ──
   The strip does not know what its children are — that is the point of it — but
   showing one row at a time means knowing which child owns which summary. So
   every child is wrapped in a *slot* that publishes its index, and
   `useStripSummary` reports that index along with the summary. Nothing a row
   writes changes; the mapping is discovered from where the row was mounted.

   ── Motion ──
   The shelf sits under the composer in the layout, so every height change here
   moves the transcript above it. They are all one measured transition: the
   front card's height is observed and animated on the box, which covers
   opening, closing, switching between cards of different heights, and a card
   that grows under you (a checklist gaining a step). The cards themselves ride
   one transform each, so bringing one forward is the pile settling rather than
   four rows redrawing. Everything is off under `prefers-reduced-motion` (see
   `.harness-strip-*` in index.css). */
import * as React from "react"

import { useCoarsePointer } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

/* ── Chip badge ──
   A small count or indicator that sits at the end of a chip label. Used to
   surface live counts (queued messages, attachments, subagents) without
   requiring the row to be open. Renders as a tiny pill with a number inside. */
function ChipBadge({ count, className }: { count?: number; className?: string }) {
  if (count == null || count <= 0) return null
  return (
    <span
      className={cn(
        "inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary/15 px-1 text-[9px] font-semibold tabular-nums leading-none text-primary",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
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
   listed here sort last, in mount order. */
const SUMMARY_ORDER = [
  "archived",
  "agents",
  "attachments",
  "pastes",
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

/* How tall a sliver is. Fine pointer: 14px, the largest peek that still beats
   the rail's flat 35px at three rows, and just enough for the 12px icon.
   Coarse: 20px, because on a touch device the sliver is the tap target. */
const PEEK_FINE = 14
const PEEK_COARSE = 20

/* How deep the pile draws. Past this the cards sit at the same offset — a
   fourth sliver is 14px that says "and more", a seventh is the composer
   halfway up the screen. Base UI's toast pile stops at three for the same
   reason. */
const MAX_DEPTH = 3

/* The shelf's own bottom edge, hidden behind the composer. Must stay in step
   with the `pb-4` it is spelled on: the box has to reserve it, and the pile's
   arithmetic has to know it is there. Whoever is *last* wears it — the footer
   when there is one, the cards when there is not. Two things wearing it would
   reserve it twice. */
const TUCK = 16

/* How long the shelf takes to fold away before it is taken out of the layout.
   A little longer than the box's own transition (`.harness-strip-panel`,
   280ms) — the stow is what keeps a 0-height shelf from leaving its ring and
   its tucked padding behind the composer, and taking it away early cuts the
   fold off halfway. */
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
  /** The card the user last brought forward. Urgency outranks it; it is
      remembered underneath, so a command menu that comes and goes gives the
      shelf back. */
  const [picked, setPicked] = React.useState<string | null>(null)
  const coarse = useCoarsePointer()
  const peek = coarse ? PEEK_COARSE : PEEK_FINE

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

  /* Where each card sits. The front one is at depth 0 and the rest keep their
     rank order behind it — `sort` is stable, so moving one card to the front is
     the only thing this comparator does. `z` is the raw position, not the
     clamped depth: past MAX_DEPTH the cards share an offset, and two cards at
     the same offset still have to paint in an order. */
  const pile = React.useMemo(() => {
    const order = [...entries].sort(
      (a, b) => Number(b.id === activeId) - Number(a.id === activeId)
    )
    return new Map(
      order.map((entry, index) => [
        entry.id,
        { depth: Math.min(index, MAX_DEPTH), z: order.length - index },
      ])
    )
  }, [entries, activeId])

  const behind = Math.min(Math.max(entries.length - 1, 0), MAX_DEPTH)
  /* The tuck belongs to whatever is last. With a footer the cards stand ON it
     rather than on the composer, so they stop reserving a bottom edge nothing
     covers — and the footer takes the `pb-4` instead. */
  const tuck = footer ? 0 : TUCK
  const cardHeight = bodyHeight + tuck
  const height = (entries.length === 0 ? 0 : cardHeight + behind * peek) + footerHeight

  /* Arrow keys walk the slivers, the way they walk any stack. Sorted by where
     they actually are rather than by DOM order — the cards are drawn in pile
     order and mounted in child order, and an Up that went to the sliver *below*
     is a control that lies. Focus only: moving through the pile should not
     bring four cards forward on the way past. */
  const onSliverKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    const box = event.currentTarget
    const slivers = [...box.querySelectorAll<HTMLElement>("[data-chip]")].sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
    )
    const index = slivers.indexOf(document.activeElement as HTMLElement)
    if (index === -1) return
    event.preventDefault()
    const step = event.key === "ArrowDown" ? 1 : -1
    slivers[(index + step + slivers.length) % slivers.length]?.focus()
  }

  /* One card per child, in the order they were written — position is a
     transform, never a reorder of the DOM, so bringing a card forward does not
     remount the row inside it. The key is the one `Children.toArray` assigns,
     which counts the conditional children that render nothing, so a notice
     appearing above the scope row shifts nobody's identity. A child that
     registered nothing has no card: it is a row that returned null. */
  const cards = React.Children.toArray(children).map((child, index) => {
    const entry = entries.find((item) => item.slot === index)
    const place = entry ? pile.get(entry.id) : undefined
    const front = entry != null && entry.id === activeId
    const scale = place ? 1 - place.depth * 0.02 : 1
    /* The lift is the peek *plus* what the scale took off the top: scaling from
       the bottom edge pulls the top edge down by `(1-scale) * height`, and a
       pile that did not add it back would show a sliver thinner than the one
       above it. Same compensation the toast pile spells as `--shrink`. */
    const lift = place ? place.depth * peek + (1 - scale) * cardHeight : 0
    const Icon = entry?.icon
    return (
      <div
        key={React.isValidElement(child) ? (child.key ?? index) : index}
        data-strip-slot=""
        data-front={front ? "" : undefined}
        className={cn(
          "harness-strip-card absolute inset-x-0 origin-bottom overflow-hidden rounded-t-xl",
          !footer && "pb-4",
          /* Only the front card wears the surface. A card behind is covered by
             it everywhere except its own sliver, so tinting the whole box would
             stack three 70% washes into a 97% slab — an opaque one, in an app
             where every raised surface is frosted. The sliver carries the
             surface for the card it belongs to; the rest of that card is a
             transparent box holding a mounted row. */
          front &&
            "bg-surface/70 ring-1 ring-foreground/5 backdrop-blur-xl backdrop-saturate-150 dark:ring-foreground/10",
          !place && "hidden"
        )}
        style={
          place
            ? {
                // The pile stands on the footer, not on the box's floor.
                bottom: footerHeight,
                height: cardHeight,
                zIndex: place.z,
                transform: `translate3d(0, ${-lift}px, 0) scale(${scale})`,
              }
            : undefined
        }
      >
        {/* The sliver. Absolutely placed rather than a header in the flow, so a
            card coming forward does not shove its own contents down by 14px on
            the way. Only a card behind draws one — the front card is the open
            one, and a button to bring forward the card that is already forward
            is a button that does nothing. */}
        {entry && !front && (
          <button
            type="button"
            data-chip={entry.id}
            aria-label={entry.label}
            title={entry.label}
            onClick={() => setPicked(entry.id)}
            style={{ height: peek }}
            className={cn(
              "absolute inset-x-0 top-0 flex items-center gap-1.5 rounded-t-xl px-2.5 text-muted-foreground",
              /* The sliver is the card's surface, since it is the only part of
                 the card anyone sees. `ring-inset` and not the card's outset
                 ring: a ring is a box-shadow drawn *outside* the border box,
                 and the card clips its own children, so an outset one on a
                 sliver pinned to the card's edges is a hairline clipped away to
                 nothing. Inset, its bottom line falls where the card in front
                 begins and reads as the seam between the two. */
              "bg-surface/70 ring-1 ring-foreground/5 ring-inset backdrop-blur-xl backdrop-saturate-150 dark:ring-foreground/10",
              "transition-colors hover:bg-accent/40 hover:text-foreground",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            )}
          >
            {Icon ? (
              <Icon className="size-3 shrink-0" />
            ) : (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
            )}
            {/* A count still reads at this size; the label does not, which is
                what `title` is for. Smaller than the rail's badge on purpose —
                the default 14px pill is the whole sliver. */}
            <ChipBadge count={entry.badge} className="h-3 min-w-3 text-[8px]" />
          </button>
        )}
        {/* The shelf may not eat the screen. An expanded queue of ten messages,
            or a forty-step checklist, is taller than the panel — and the strip
            sits *under* the composer in the layout, so what a too-tall shelf
            pushes off the bottom is the thing you were typing into. Capped as a
            fraction of the panel (`--panel-h`, falling back to the viewport
            outside the dock), the overflow scrolls inside the card instead.
            `overscroll-contain` keeps that scroll off the transcript. The
            *fraction* is still the device's: a soft keyboard takes half the
            screen with it. This is also the element the height above is read
            from, so what is animated is the capped height and not the
            content's.

            `hidden` on a card that is not in front: it keeps the child mounted
            (it is what registers the sliver) while taking its buttons out of
            the tab order and its scroll out of reach — everything below the
            sliver is behind the front card anyway. */}
        <div
          ref={front ? bodyRef : undefined}
          data-strip-body=""
          data-front={front ? "" : undefined}
          className={cn(
            "max-h-[calc(var(--panel-h,100svh)*0.45)] overflow-y-auto overscroll-contain sm:max-h-[calc(var(--panel-h,100svh)*0.6)]",
            !front && "hidden"
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
        data-slot="composer-strip"
        role={many ? "group" : undefined}
        aria-label={many ? "Composer shelf" : undefined}
        onKeyDown={many ? onSliverKeyDown : undefined}
        style={{ height }}
        className={cn(
          // harness-strip-panel: the box's height, which is the front card's
          // plus one peek per card behind it. Everything above the shelf moves
          // with it, so it is one transition rather than four.
          "harness-strip-panel relative",
          // isolate: the cards carry a z-index and the composer is `relative
          // z-10` beside this box. Without a stacking context of its own the
          // pile would paint over the thing it is attached to.
          "isolate",
          // -mb-4: the shelf's own bottom four units (the `pb-4` on the footer,
          // or on the cards when there is none — TUCK above) sit behind the
          // composer, which is what makes the seam disappear. Keep the three in
          // step.
          // The shelf wears the `--surface` token against the composer's
          // `--composer`, so the two read as separate objects with a visible
          // seam rather than one flat band.
          // Width follows the composer: minus whatever the composer actually is
          // (capped when there is room, 100% of the container when there is not)
          // the strip stays narrower, so it reads as tucked behind rather than
          // flush with it. The inset is 3rem of a wide composer and 1rem of a
          // cramped one: 3rem of a 360px column is a sixth of the shelf spent on
          // margin, and what it cost was the content — a queued message
          // truncated to three words. Measured against the panel, so a chat
          // squeezed beside a terminal gets the narrow inset the same way a
          // phone does. Half a rem and a rem and a half: enough offset to read
          // as tucked behind, and no more, now that the shelf carries a row
          // that is on screen for the whole life of the thread.
          "mx-auto -mb-4 w-full max-w-[calc(min(100%,var(--harness-composer-width))_-_0.5rem)] @panel-sm:max-w-[calc(min(100%,var(--harness-composer-width))_-_1.5rem)]",
          // The fold has nothing left to draw — the last card unregistered the
          // frame the shelf emptied — so the box wears the surface itself on
          // the way down. Without it the composer would jump rather than slide.
          // Never with a footer: that surface is already down there, and a
          // second one over it would wash the row it is under.
          empty &&
            !stowed &&
            "overflow-hidden rounded-t-xl bg-surface/70 ring-1 ring-foreground/5 dark:ring-foreground/10",
          // Nothing registered and the fold finished: no pile, no shelf.
          stowed && empty && "hidden",
          className
        )}
        {...props}
      >
        {/* -1 while the shelf is one card: a lone row keeps its own default,
            which is closed, because nobody brought it forward and there is no
            sliver saying what it holds. */}
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
              /* `--composer`, not the pile's `--surface`: the footer belongs to
                 the composer, not to the shelf. It says what is permanently
                 true of the thread the box below writes to, so it wears that
                 box's ground and the seam between the two disappears — what is
                 left is one composer unit with a shelf of transient cards on
                 top of it. The two tokens are far enough apart in both modes to
                 read as different objects (light: muted-mixed vs card; dark:
                 card vs background). */
              "bg-composer/70 ring-1 ring-foreground/5 backdrop-blur-xl backdrop-saturate-150 dark:ring-foreground/10",
              entries.length === 0 && "rounded-t-xl"
            )}
          >
            {footer}
          </div>
        )}
      </div>
    </StripContext.Provider>
  )
}

export { ChipBadge }

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
