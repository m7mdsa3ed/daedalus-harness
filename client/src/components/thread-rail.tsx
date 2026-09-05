/* ── Turn rail ──
   A column of thin tick marks along the composer's trailing edge, one per
   turn: hover to preview it, click to jump to it. On a touch screen the same
   strip is a scrubber — press it, and the tick under your finger lights up
   with its card; slide, and the selection walks the marks one detent at a
   time (the card names each as it passes); let go, and the transcript jumps
   there. A press that never moves is a tap and jumps where it landed, which is
   the mouse behaviour too, so there is one rail to learn. The preview is the
   native popover anchored to the rail band — an invisible trigger over the
   band gives the Positioner geometry to measure — and it flips and shifts off
   the window edges, so no half of the message can end up under the window.
   A long thread is a
   scroll bar with no landmarks on it — this is the table of contents, and the
   only landmarks that mean anything in a conversation are the times you spoke.

   It is an absolute overlay along the card's right edge, bottom-anchored just
   above the Send button and extending upward — so it adds no size to the
   composer and sits where the thumb already is. `pointer-events-none` outside
   the strip itself keeps it from eating textarea taps. It needs the
   MessageScroller Provider above the composer for
   `scrollToMessage`/`currentAnchorId` — thread-view lifts the provider to the
   grid root for exactly that.

   The tick list is the journal's, not the transcript's: `attached` carries
   every turn (including the ones still withheld behind `earlier`), so all
   ticks draw without paging history in. Loaded turns resolve to their row ids
   through `turnId`; jumping to a tick whose messages are still on the server
   pages back to its `turn_started` first (`onEnsureTurn`) and then jumps.
   Live turns newer than the attach — and untagged bubbles a load replay left
   behind — are on screen but in no server list, so they ride at the end.

   Ported from https://github.com/lcthe/dsh-timeline-rail (MIT), but only the
   idea and the geometry survive the trip. That plugin walks
   `[data-chat-anchor-key]` nodes and mutates `scrollTop` by hand because its
   host gives it nothing else; ours asks the scroller, which already knows every
   message's id (`MessageScrollerItem messageId=…` in thread-view) and which one
   the reader is currently anchored on. Two hooks replace its DOM archaeology. */
import * as React from "react"
import { useMessageScroller, useMessageScrollerVisibility } from "@/components/ui/message-scroller"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useCoarsePointer } from "@/hooks/use-mobile"
import type { TurnTick } from "@daedalus/protocol"
import type { ThreadItem } from "@/lib/store"
import { cn } from "@/lib/utils"

/** Vertical pitch, in px — mark plus gap, packed dense so the column reads
    as a ruler rather than a dotted list and a long thread still fits the
    card. It is also each tick's hit height: the rows tile the strip with
    nothing between them, so every pixel of it belongs to the nearest mark
    and a 1px line is a whole row's click target. */
const PITCH = 4

/** The same, for a finger. Precision on touch comes from the slide, not from
    landing on a mark, but the detents cannot be hair-fine either: a held thumb
    wobbles a couple of px, and a pitch that fine would let the wobble walk the
    selection on its own. A little coarser than the cursor's keeps a sweep
    measurable without spacing the marks out again. */
const PITCH_COARSE = 6

/** Movement, in px, before a press counts as a scrub rather than a tap. Below
    it the pointerup steps aside and lets the click do the jumping. */
const SCRUB_SLOP = 3

/** How far inside the strip's ends a held pointer starts dragging the overflow
    along with it, in px — and how fast, as a fraction of the overshoot. */
const EDGE_BAND = 36
const EDGE_SPEED = 0.35

interface Tick {
  /** Row id of the loaded user bubble — null until its messages are paged in. */
  id: string | null
  turnId: string | null
  /** The turn's `turn_started` seq, for paging back to it. -1 when unknown. */
  seq: number
  /** 1-based, as the preview card labels it. */
  n: number
  text: string
  /** Everything the agent said before the next user turn — the answer that
      turn got, which is usually how you recognise which turn it was. */
  reply: string
}

/**
 * The journal's turn list merged with what's on screen: server turns keep
 * their order and carry excerpts, loaded ones resolve to row ids with full
 * text. Reads the same `ThreadItem[]` the transcript renders rather than a
 * second store, so the rail cannot disagree with what is on screen.
 */
function buildTicks(server: TurnTick[], items: ThreadItem[]): Tick[] {
  if (server.length === 0) {
    // An older server sends no list — ticks from what's on screen only.
    const ticks: Tick[] = []
    for (const item of items) {
      if (item.kind === "user") {
        ticks.push({
          id: item.id,
          turnId: item.turnId ?? null,
          seq: -1,
          n: ticks.length + 1,
          text: item.text,
          reply: "",
        })
      } else if (item.kind === "agent" && !item.parentId && ticks.length > 0) {
        // The thread's own reply — a subagent's prose is its report, not the answer.
        const tick = ticks[ticks.length - 1]
        tick.reply = tick.reply ? `${tick.reply}\n${item.text}` : item.text
      }
    }
    return ticks
  }
  const loadedByTurn = new Map<string, { index: number; id: string; text: string }>()
  const untagged: { index: number; id: string; text: string }[] = []
  items.forEach((item, index) => {
    if (item.kind !== "user") return
    if (item.turnId && !loadedByTurn.has(item.turnId)) {
      loadedByTurn.set(item.turnId, { index, id: item.id, text: item.text })
    } else if (!item.turnId) {
      untagged.push({ index, id: item.id, text: item.text })
    }
  })
  /* The loaded answer between one prompt and the next — full text where the
     server's excerpt only previews. */
  const replyBetween = (fromIndex: number): string => {
    const parts: string[] = []
    for (let k = fromIndex + 1; k < items.length; k++) {
      const it = items[k]
      if (it.kind === "user") break
      if (it.kind === "agent" && !it.parentId) parts.push(it.text)
    }
    return parts.join("\n")
  }
  const seen = new Set<string>()
  const ticks: Tick[] = server.map((t, i) => {
    const row = loadedByTurn.get(t.turnId)
    if (row) {
      seen.add(t.turnId)
      return {
        id: row.id,
        turnId: t.turnId,
        seq: t.seq,
        n: i + 1,
        text: row.text,
        reply: replyBetween(row.index) || t.reply,
      }
    }
    return { id: null, turnId: t.turnId, seq: t.seq, n: i + 1, text: t.text, reply: t.reply }
  })
  for (const [turnId, row] of loadedByTurn) {
    if (seen.has(turnId)) continue
    ticks.push({
      id: row.id,
      turnId,
      seq: -1,
      n: ticks.length + 1,
      text: row.text,
      reply: replyBetween(row.index),
    })
  }
  for (const row of untagged) {
    ticks.push({
      id: row.id,
      turnId: null,
      seq: -1,
      n: ticks.length + 1,
      text: row.text,
      reply: replyBetween(row.index),
    })
  }
  return ticks
}

export function ThreadRail({
  items,
  turns,
  onEnsureTurn,
}: {
  items: ThreadItem[]
  /** The journal's whole turn list, oldest first — see `ThreadState.turns`. */
  turns?: TurnTick[]
  /** Page history back until `turnId` is folded; resolves to its row id, or
      null when the turn never made it on screen. */
  onEnsureTurn?: (turnId: string, seq: number) => Promise<string | null>
}) {
  const ticks = React.useMemo(() => buildTicks(turns ?? [], items), [turns, items])
  const coarse = useCoarsePointer()
  const pitch = coarse ? PITCH_COARSE : PITCH
  const { scrollToMessage } = useMessageScroller()
  const { currentAnchorId } = useMessageScrollerVisibility()
  const hostRef = React.useRef<HTMLDivElement>(null)
  const stripRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [hover, setHover] = React.useState<{ index: number } | null>(
    null
  )
  /* The scrub in flight. Set on press, wherever the press lands — capture (the
     strip's own setPointerCapture) keeps the moves arriving once the finger or
     cursor travels off the strip, which is the whole trick of a scrubber: the
     detents are under the strip, but the sweep is anywhere the arm wants. */
  const [scrub, setScrub] = React.useState<{
    pointerId: number
    index: number
    haptics: boolean
  } | null>(null)
  /* Live pointer position and tap-vs-scrub bookkeeping, in refs: the rAF loop
     below reads the position between moves, and `moved` has to survive the
     state cycles the scrub itself causes. */
  const scrubYRef = React.useRef(0)
  const startYRef = React.useRef(0)
  const movedRef = React.useRef(false)

  /* Which tick the reader is inside: the last loaded one at or above the
     anchor. The anchor is any row — a tool step, the activity line — so it is
     resolved through the item order rather than looked up among the ticks,
     and an anchor that is not an item at all (`working`, `permission`) leaves
     the reader at the bottom, which is the last turn. Ticks with no row yet
     are never active: the reader cannot be inside what is not on screen. */
  const order = React.useMemo(
    () => new Map(items.map((item, index) => [item.id, index])),
    [items]
  )
  const activeIndex = React.useMemo(() => {
    if (ticks.length === 0 || currentAnchorId === null) return -1
    const at = order.get(currentAnchorId)
    if (at === undefined) return ticks.length - 1
    let index = -1
    ticks.forEach((tick, i) => {
      if (!tick.id) return
      if ((order.get(tick.id) ?? Infinity) > at) return
      index = i
    })
    return index
  }, [ticks, order, currentAnchorId])

  /* Map a pointer's Y to the tick under it — clamped to the end it has been
     dragged past. The content wrapper is measured rather than the strip so
     the strip's own padding and scroll never enter the arithmetic. Returns
     the index, so a caller can tell a detent crossing from a rest. */
  const selectAt = React.useCallback(
    (pointerId: number, clientY: number, haptics: boolean): number => {
      const content = contentRef.current
      if (!content || ticks.length === 0) return -1
      const contentTop = content.getBoundingClientRect().top
      const index = Math.max(
        0,
        Math.min(ticks.length - 1, Math.round((clientY - contentTop) / pitch))
      )
      setScrub((prev) =>
        prev && prev.pointerId === pointerId && prev.index === index
          ? prev
          : { pointerId, index, haptics }
      )
      return index
    },
    [pitch, ticks.length]
  )

  /* A held pointer pushing against the strip's ends scrolls the overflow along
     with it, one frame at a time, re-selecting as the marks travel under the
     finger. A rail taller than the composer is exactly the thread that most
     needs scrubbing, and a thumb that runs out of card must still reach the
     start of a long thread. */
  const scrubPointer = scrub?.pointerId ?? null
  React.useEffect(() => {
    if (scrubPointer === null) return
    const strip = stripRef.current
    if (!strip) return
    let raf = 0
    const step = () => {
      const rect = strip.getBoundingClientRect()
      const over =
        scrubYRef.current < rect.top + EDGE_BAND
          ? scrubYRef.current - (rect.top + EDGE_BAND)
          : scrubYRef.current > rect.bottom - EDGE_BAND
            ? scrubYRef.current - (rect.bottom - EDGE_BAND)
            : 0
      if (over !== 0) {
        strip.scrollTop += Math.max(-24, Math.min(24, over * EDGE_SPEED))
        selectAt(scrubPointer, scrubYRef.current, scrub?.haptics ?? false)
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [scrubPointer, scrub?.haptics, selectAt])

  /* A tick whose row is on screen jumps straight there; one still withheld
     pages history back to its `turn_started` first, then jumps. The fold
     commits before this resolves, but the rows mount a frame or two later —
     so the jump waits for them, or it would land on an anchor that does not
     exist yet and go nowhere. */
  const jump = React.useCallback(
    (tick: Tick) => {
      if (tick.id) {
        scrollToMessage(tick.id, { align: "start", behavior: "smooth" })
        return
      }
      if (!tick.turnId || !onEnsureTurn) return
      void onEnsureTurn(tick.turnId, tick.seq).then((id) => {
        if (!id) return
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            scrollToMessage(id, { align: "start", behavior: "smooth" })
          )
        )
      })
    },
    [onEnsureTurn, scrollToMessage]
  )

  // One tick is not a timeline, it is a dot. Two is the first thread you could
  // actually be lost in.
  if (ticks.length < 2) return null

  /* One selection: a scrub outranks the hover it displaced. The preview is
     the native popover, anchored to the rail band — the Positioner flips and
     shifts it off the window edges itself, so no half of the message can end
     up under the window whatever the tick. Controlled open, not hover-driven:
     selection here is a hold-drag-scrub as much as a cursor, and the popover
     follows whichever tick is selected. */
  const sel = scrub ?? hover
  const preview = sel ? ticks[sel.index] : null

  return (
    <Popover open={preview !== null} triggerId="turn-rail-anchor">
      <div
        ref={hostRef}
        aria-label="Turns"
        /* Absolute along the card's right edge, bottom-anchored just above the
           Send button: the rail adds no size to the composer. `pointer-events-none`
           keeps the band from eating textarea taps — only the strip itself takes
           the pointer. */
        className="pointer-events-none absolute bottom-11 right-1 top-2 z-20 flex w-5 flex-col items-center"
      >
        {/* The popover's anchor — the Positioner measures this element's rect
            to place the card, and needs real DOM to anchor to (a controlled
            `open` alone gives it none). It is an invisible overlay on the
            band: it supplies the geometry and nothing else, so the scrub's
            own pointer capture on the strip stays untouched and a tap still
            reaches the tick beneath. */}
        <PopoverTrigger
          id="turn-rail-anchor"
          nativeButton={false}
          render={
            <span aria-hidden className="pointer-events-none absolute inset-0" />
          }
        />
      <div
        ref={stripRef}
        /* no-scrollbar (shadcn/tailwind.css), not scrollbar-thin: a scrollbar
           beside a row of hairlines is wider than the thing it scrolls.
           touch-none: the touch drag IS the scrub — without it the browser
           claims the same gesture for scrolling and the scrub dies in
           pointercancel before the finger has selected anything. Overflow
           past the card is travelled by holding into the strip's ends, not
           by flicking it. */
        className={cn(
          "no-scrollbar pointer-events-auto h-full min-h-0 w-full touch-none overflow-y-auto rounded-full py-2 transition-[opacity,background-color] duration-150",
          /* Idle the strip is quiet — dimmed with no chrome. A held scrub
             lights it to full opacity over a pill of card background, so the
             finger has a visible track to drag on. */
          scrub !== null
            ? "bg-background/80 opacity-100 shadow-sm backdrop-blur-sm"
            : "bg-transparent opacity-75 hover:opacity-100"
        )}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(event) => {
          /* One scrub at a time: a second finger arriving mid-scrub is not a
             new intent, it is the same thumb misfiring. */
          if (scrub !== null) return
          event.currentTarget.setPointerCapture(event.pointerId)
          movedRef.current = false
          startYRef.current = event.clientY
          scrubYRef.current = event.clientY
          setHover(null)
          selectAt(event.pointerId, event.clientY, event.pointerType !== "mouse")
        }}
        onPointerMove={(event) => {
          if (scrub?.pointerId !== event.pointerId) return
          scrubYRef.current = event.clientY
          if (Math.abs(event.clientY - startYRef.current) > SCRUB_SLOP) movedRef.current = true
          const was = scrub.index
          const now = selectAt(event.pointerId, event.clientY, scrub.haptics)
          /* One pulse per detent — the card names the turn, the buzz says you
             crossed into it. Vibrate is not everywhere (iOS), and its absence
             is not an error. */
          if (now !== was && scrub.haptics) navigator.vibrate?.(8)
        }}
        onPointerUp={(event) => {
          if (scrub?.pointerId !== event.pointerId) return
          const { index } = scrub
          setScrub(null)
          /* Release commits — a tap and a scrub end the same way, at the mark
             under the pointer. A tap may then also raise a click on the tick
             (browsers disagree about where a captured click lands), which is
             the same jump twice and so invisible; a scrub's click is stopped
             by `movedRef` in the button. */
          const tick = ticks[index]
          if (tick) jump(tick)
        }}
        onPointerCancel={() => setScrub(null)}
        onLostPointerCapture={() => setScrub(null)}
      >
        <div ref={contentRef} className="flex h-max w-full flex-col items-stretch">
          {ticks.map((tick, index) => {
            const active = index === activeIndex
            const selected = index === sel?.index
            return (
              <button
                key={tick.turnId ?? tick.id ?? `n${tick.n}`}
                type="button"
                aria-label={`Jump to message ${tick.n}`}
                aria-current={active || undefined}
                className="group/tick flex w-full items-center justify-center"
                style={{ height: pitch }}
                onPointerEnter={() => setHover({ index })}
                onClick={(event) => {
                  /* detail 0 is a keyboard activation, which has no pointer
                     behind it and always jumps. A pointer click after a
                     scrub was already committed on release — and browsers
                     disagree about which element a captured click lands on,
                     so this guard, not geography, is what keeps the jump
                     single. */
                  if (event.detail > 0 && movedRef.current) return
                  jump(tick)
                }}
              >
                <span
                  className={cn(
                    "h-px rounded-full transition-colors duration-150",
                    active
                      ? "bg-primary"
                      : selected
                        ? "bg-foreground"
                        : "bg-muted-foreground/40 group-hover/tick:bg-foreground/70"
                  )}
                  style={{ width: active || selected ? 12 : 6 }}
                />
              </button>
            )
          })}
        </div>
      </div>
      </div>
      {/* The native popover, anchored to the rail band: its Positioner flips
          the side and shifts the card off the window edges, so no half of the
          message can end up under the window whatever the tick — above the
          keyboard, beside the composer, in one line of props instead of a
          measurement loop. `modal={false}` and pointer-events off: it is a
          readout, not a dialog — the scrub's own capture owns the pointer and
          a tap must still reach the tick beneath. Content swaps as the
          selection walks the detents; the positioner tracks the band. */}
      <PopoverContent
        side="left"
        align="center"
        sideOffset={8}
        className="pointer-events-none w-64 max-w-[70vw] border-border/60 bg-popover/95 p-2 text-xs shadow-md backdrop-blur-sm"
      >
        {preview && (
          <>
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
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
