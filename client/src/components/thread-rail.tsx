/* ── Turn rail ──
   A column of thin tick marks down the right edge of the transcript, one per
   user turn: hover to preview it, click to jump to it. A long thread is a
   scroll bar with no landmarks on it — this is the table of contents, and the
   only landmarks that mean anything in a conversation are the times you spoke.

   It is an overlay inside `MessageScroller`'s root (which is `relative`), NOT a
   fixed element measured against the viewport: the dock can have several
   transcripts mounted at once, and a rail positioned against the window would
   belong to whichever one measured last.

   Ported from https://github.com/lcthe/dsh-timeline-rail (MIT), but only the
   idea and the geometry survive the trip. That plugin walks
   `[data-chat-anchor-key]` nodes and mutates `scrollTop` by hand because its
   host gives it nothing else; ours asks the scroller, which already knows every
   message's id (`MessageScrollerItem messageId=…` in thread-view) and which one
   the reader is currently anchored on. Two hooks replace its DOM archaeology. */
import * as React from "react"
import { useMessageScroller, useMessageScrollerVisibility } from "@/components/ui/message-scroller"
import type { ThreadItem } from "@/lib/store"
import { cn } from "@/lib/utils"

/** Vertical pitch, in px. Also each tick's hit height — a 1px line is not a
    click target, so the mark is drawn inside a row that is the whole gap. */
const PITCH = 12

/** Gaussian falloff for the hover magnification, in ticks. Neighbours grow with
    the one under the cursor so the rail bulges rather than flicking one mark. */
const SIGMA = 2.5

interface Tick {
  id: string
  /** 1-based, as the preview card labels it. */
  n: number
  text: string
  /** Everything the agent said before the next user turn — the answer that
      turn got, which is usually how you recognise which turn it was. */
  reply: string
}

/**
 * One tick per user message, each carrying the reply it drew.
 *
 * Reads the same `ThreadItem[]` the transcript renders rather than a second
 * store, so the rail cannot disagree with what is on screen — and the ids are
 * the row ids, which is what `scrollToMessage` is keyed on.
 */
export function railTicks(items: ThreadItem[]): Tick[] {
  const ticks: Tick[] = []
  for (const item of items) {
    if (item.kind === "user") {
      ticks.push({ id: item.id, n: ticks.length + 1, text: item.text, reply: "" })
    } else if (item.kind === "agent" && !item.parentId && ticks.length > 0) {
      // The thread's own reply — a subagent's prose is its report, not the answer.
      const tick = ticks[ticks.length - 1]
      tick.reply = tick.reply ? `${tick.reply}\n${item.text}` : item.text
    }
  }
  return ticks
}

const scaleAt = (index: number, hover: number | null): number =>
  hover === null ? 1 : 1 + 0.7 * Math.exp(-((index - hover) ** 2) / (2 * SIGMA * SIGMA))

/** How wide the tick strip is. The marks are drawn inside it, so it is also
    what the fallback below has to subtract to keep the rail off the scrollbar. */
const RAIL_W = "1.5rem"

/** Gap between the reading column and the rail. */
const COLUMN_GAP = "0.75rem"

/**
 * Where the rail's leading edge sits when the window is too narrow to place it
 * beside the column — measured so its *trailing* edge still clears the
 * scrollbar, not its leading one.
 *
 * `scrollbar-gutter-stable` on the viewport (see ui/message-scroller) reserves
 * the track at the pane's edge and index.css draws it 6px wide. A rail sitting
 * in that strip is a rail you cannot drag the scrollbar past — so this is the
 * rail's own width plus the track plus 6px of daylight, and the leading edge
 * goes that far in.
 */
const EDGE_GAP = `calc(${RAIL_W} + 6px + 6px)`

/** Breathing room between the preview card and the top/bottom of the pane. */
const CARD_INSET = 8

export function ThreadRail({ items, wide }: { items: ThreadItem[]; wide?: boolean }) {
  const ticks = React.useMemo(() => railTicks(items), [items])
  const { scrollToMessage } = useMessageScroller()
  const { currentAnchorId } = useMessageScrollerVisibility()
  const hostRef = React.useRef<HTMLDivElement>(null)
  const cardRef = React.useRef<HTMLDivElement>(null)
  const [cardHeight, setCardHeight] = React.useState(0)
  const [hover, setHover] = React.useState<{ index: number; y: number; hostHeight: number } | null>(
    null
  )

  /* Which tick the reader is inside: the last one at or above the anchor. The
     anchor is any row — a tool step, the activity line — so it is resolved
     through the item order rather than looked up among the ticks, and an
     anchor that is not an item at all (`working`, `permission`) leaves the
     reader at the bottom, which is the last turn. */
  const order = React.useMemo(
    () => new Map(items.map((item, index) => [item.id, index])),
    [items]
  )
  const activeIndex = React.useMemo(() => {
    if (ticks.length === 0 || currentAnchorId === null) return -1
    const at = order.get(currentAnchorId)
    if (at === undefined) return ticks.length - 1
    let index = -1
    for (const tick of ticks) {
      if ((order.get(tick.id) ?? Infinity) > at) break
      index++
    }
    return index
  }, [ticks, order, currentAnchorId])

  /* The card's height changes with its content — a one-line turn with no reply
     yet is half the height of a three-line one — so it is measured per hover
     rather than assumed once. Layout effect, not effect: this runs before the
     browser paints, so the clamp lands on the same frame the card appears. */
  React.useLayoutEffect(() => {
    setCardHeight(cardRef.current?.offsetHeight ?? 0)
  }, [hover?.index])

  // One tick is not a timeline, it is a dot. Two is the first thread you could
  // actually be lost in.
  if (ticks.length < 2) return null

  const preview = hover ? ticks[hover.index] : null
  /* Centred on its tick, then pushed back inside the pane. Without the clamp
     the first and last ticks — the two you reach for most, "the start" and
     "just now" — open a card half of which is outside the transcript. */
  const cardTop =
    hover === null
      ? 0
      : Math.min(
          Math.max(hover.y - cardHeight / 2, CARD_INSET),
          Math.max(hover.hostHeight - cardHeight - CARD_INSET, CARD_INSET)
        )

  return (
    /* Positioned against the *reading column*, not the pane: the rail indexes
       the text, so on a wide window it belongs beside the 748px measure rather
       than stranded at the far edge with a hand-span of empty between them.
       The `min()` is the fallback for when the window is narrower than the
       column plus its gaps — then the rail pins to the pane's own edge, which
       EDGE_GAP keeps clear of the scrollbar.

       Hidden below `md`: there is no margin to float in on a phone, and a rail
       overlapping the prose is worse than no rail.

       The gutter is pointer-transparent — a strip that ate clicks over the
       transcript would make the text under it unselectable. Only the scrollport
       takes the pointer back. */
    <div
      ref={hostRef}
      aria-label="Turns"
      style={{
        insetInlineStart: `min(calc(50% + ${wide ? "41rem" : "var(--harness-chat-width) / 2"} + ${COLUMN_GAP}), calc(100% - ${EDGE_GAP}))`,
      }}
      className="pointer-events-none absolute inset-y-0 z-20 hidden items-center @panel-md:flex"
    >
      <div
        /* no-scrollbar (shadcn/tailwind.css), not scrollbar-thin: a scrollbar
           beside a column of hairlines is wider than the thing it scrolls. */
        className="no-scrollbar pointer-events-auto max-h-full overflow-y-auto py-3"
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((tick, index) => {
          const active = index === activeIndex
          const scale = scaleAt(index, hover?.index ?? null)
          return (
            <button
              key={tick.id}
              type="button"
              aria-label={`Jump to message ${tick.n}`}
              aria-current={active || undefined}
              /* justify-start: the marks are anchored at the column-facing edge
                 and grow outward, so the hover magnification expands into the
                 empty margin instead of reaching toward the prose. */
              className="group/tick flex w-6 items-center justify-start"
              style={{ height: PITCH }}
              onPointerEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                const host = hostRef.current?.getBoundingClientRect()
                setHover({
                  index,
                  y: rect.top + rect.height / 2 - (host?.top ?? 0),
                  hostHeight: host?.height ?? 0,
                })
              }}
              onClick={() => scrollToMessage(tick.id, { align: "start", behavior: "smooth" })}
            >
              {/* Width, not transform: a scaled 1px line renders as a blurred
                  1.7px one on a non-retina display, and the mark is the whole
                  visual — there is nothing else here to hide it behind. */}
              <span
                className={cn(
                  "h-px rounded-full transition-[width,background-color] duration-150",
                  active
                    ? "bg-primary"
                    : "bg-muted-foreground/30 group-hover/tick:bg-foreground/70"
                )}
                style={{ width: `${Math.round((active ? 14 : 10) * scale)}px` }}
              />
            </button>
          )
        })}
      </div>

      {/* Anchored to the tick, not to the pointer: the card is a label for a
          mark, so it stays put while the cursor travels the 12px to the next
          one. `end-full` opens it back over the transcript, which is the side
          with room — the rail's other side is the panel's edge, which is also
          what `cqw` caps the card against: a rail in a 400px panel beside a
          terminal has no more room than one on a phone.

          Invisible until measured. `cardTop` needs the card's own height to
          centre and clamp it, which is only knowable after a layout, so the
          first frame of a never-yet-measured card would otherwise flash at the
          top of the pane. */}
      {preview && (
        <div
          ref={cardRef}
          style={{ top: cardTop }}
          className={cn(
            "pointer-events-none absolute end-full me-2 w-72 max-w-[60cqw] rounded-lg border border-border/60 bg-popover/95 p-2.5 text-xs shadow-md backdrop-blur-sm transition-opacity duration-100",
            cardHeight === 0 && "opacity-0"
          )}
        >
          {/* `dir="auto"` per paragraph, the same bargain the bubbles make
              (thread-items): the card quotes what was typed, so an Arabic turn
              has to read right-to-left here as it does in the transcript — and
              the two halves are decided separately, since a question in one
              script is routinely answered in the other. The ordinal is a
              neutral run, so it does not vote on the direction the text picks,
              and `me-1` carries it to whichever side that turns out to be. */}
          <p dir="auto" className="line-clamp-2 font-medium text-foreground">
            <span className="me-1 text-muted-foreground/60">#{preview.n}</span>
            {preview.text.trim() || <span className="italic text-muted-foreground">no text</span>}
          </p>
          {preview.reply.trim() && (
            <p dir="auto" className="mt-1 line-clamp-3 text-muted-foreground">
              {preview.reply}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
