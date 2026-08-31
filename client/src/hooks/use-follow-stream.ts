/* ── Follow the stream ──
   Stick the transcript to its newest content while an agent is writing.

   The scroller primitive already has an `autoScroll` of its own and it is still
   handed the option — it is what keeps the scroll-to-bottom button hidden while
   following — but it cannot be the whole answer, for two reasons that between
   them are the whole "half broken" report:

   1. Its follow state is a *mode* that only ever re-engages when the viewport is
      already at the very bottom. So flipping the switch back on while scrolled up
      does nothing at all: there is no code path from "free scrolling" back to
      "following" that a prop change can take.
   2. Every wheel, touch and arrow-key event drops that mode, whether or not the
      viewport actually moved — a nudge of the wheel at the bottom of the page is
      indistinguishable from scrolling away. Mid-turn that is terminal: content
      keeps growing under a parked scrollTop, so the viewport is no longer at the
      bottom, and "at the bottom" was the only way back in.

   So the pin is ours. Two rules, and they are the whole design:

   • **Only a gesture unpins.** A scroll event is trusted to mean "the user left"
     only when it lands within `INTENT_MS` of a wheel/touch/pointer/nav-key on the
     viewport. Everything else that moves scrollTop — our own correction, the
     browser's scroll anchoring when a row above resolves its height, a layout
     settling — is ignored. Reading the raw scroll event was what made this
     unreliable in the first place.
   • **Reaching the bottom always re-pins**, gesture or not, so scrolling back
     down by any means resumes following with nothing else to press.

   Growth is watched with a ResizeObserver on the content element rather than a
   MutationObserver: a streamed token, an image resolving and a pane opening all
   change the same one number, and the observer that reports it is the cheap one. */
import * as React from "react"

/** Distance from the end that still counts as "at the bottom". Generous on
 *  purpose: sub-pixel layout and a settling row must not read as leaving. */
const EDGE_PX = 48

/** How long after a gesture a scroll event is still that gesture's. */
const INTENT_MS = 500

const NAV_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
])

export interface FollowStream {
  /** Attach to the scroller's viewport (the element that actually scrolls). */
  viewportRef: (el: HTMLDivElement | null) => void
  /** Attach to the scroller's content (the element that grows). */
  contentRef: (el: HTMLDivElement | null) => void
  /** True while the newest content is being kept in view. */
  pinned: boolean
  /** Jump to the end and resume following. */
  follow: () => void
}

export function useFollowStream(enabled: boolean): FollowStream {
  const [viewport, setViewport] = React.useState<HTMLDivElement | null>(null)
  const [content, setContent] = React.useState<HTMLDivElement | null>(null)
  const [pinned, setPinned] = React.useState(true)
  /* The ref is what the observers read — they fire far more often than React
     renders, and a stale closure would follow a thread the user has left. */
  const pinnedRef = React.useRef(true)
  const intentAtRef = React.useRef(0)

  const pin = React.useCallback((next: boolean) => {
    if (pinnedRef.current === next) return
    pinnedRef.current = next
    setPinned(next)
  }, [])

  const stick = React.useCallback((el: HTMLElement) => {
    const target = el.scrollHeight - el.clientHeight
    if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target
  }, [])

  /* Gestures and scrolls. Bound for the life of the viewport, not gated on
     `enabled`: the pin has to stay honest while following is off, or turning it
     back on would resume from a position nobody is looking at. */
  React.useEffect(() => {
    if (!viewport) return
    const intent = () => {
      intentAtRef.current = Date.now()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (NAV_KEYS.has(event.key)) intent()
    }
    /* A scrollbar drag moves the viewport with no wheel and no touch, so it has
       to count — but a press *inside* the transcript is someone opening a tool
       step, and the reflow that follows must not read as leaving. The vertical
       scrollbar is the strip past `clientWidth` (the viewport reserves a stable
       gutter), which separates the two exactly. */
    const onPointerDown = (event: PointerEvent) => {
      const x = event.clientX - viewport.getBoundingClientRect().left
      if (x >= viewport.clientWidth) intent()
    }
    const onScroll = () => {
      const bottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= EDGE_PX
      if (bottom) pin(true)
      else if (Date.now() - intentAtRef.current < INTENT_MS) pin(false)
    }
    const passive = { passive: true } as const
    viewport.addEventListener("wheel", intent, passive)
    viewport.addEventListener("touchmove", intent, passive)
    viewport.addEventListener("pointerdown", onPointerDown, passive)
    viewport.addEventListener("keydown", onKeyDown)
    viewport.addEventListener("scroll", onScroll, passive)
    return () => {
      viewport.removeEventListener("wheel", intent)
      viewport.removeEventListener("touchmove", intent)
      viewport.removeEventListener("pointerdown", onPointerDown)
      viewport.removeEventListener("keydown", onKeyDown)
      viewport.removeEventListener("scroll", onScroll)
    }
  }, [pin, viewport])

  /* Growth. One rAF-coalesced correction per frame at most — a streaming turn
     resizes the content many times per frame and each write to scrollTop that
     is not batched is a forced layout. */
  React.useEffect(() => {
    if (!enabled || !viewport || !content) return
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (pinnedRef.current) stick(viewport)
      })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(content)
    observer.observe(viewport)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [content, enabled, stick, viewport])

  /* Turning the switch on is an instruction, not a preference: it means "take
     me to the end", which is the case the primitive alone cannot serve. */
  React.useEffect(() => {
    if (enabled) pin(true)
  }, [enabled, pin])

  const follow = React.useCallback(() => {
    pin(true)
    if (viewport) stick(viewport)
  }, [pin, stick, viewport])

  return { viewportRef: setViewport, contentRef: setContent, pinned, follow }
}
