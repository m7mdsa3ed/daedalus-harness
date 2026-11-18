/* ── The pull-to-refresh gesture, without a face ──
   `components/pull-to-refresh.tsx` draws it; this is the part that reads
   touches, moves the box being pulled and decides when to refresh. Kept apart
   so a surface with its own idea of an indicator can take the gesture alone.

   Modelled on iOS's `UIRefreshControl`, because that is the one people's
   thumbs already know: the box is pulled down on UIScrollView's rubber band,
   the refresh starts the moment the pull crosses the line — not on release —
   and the box rests open by the control's height until the refresh lands.

   Two shapes, one engine:
   - **One finger** is the stock gesture. It engages only when the touch began
     in a box whose every scrolling ancestor is already at its top, so it is
     never a scroll the reader meant.
   - **Two fingers** is for a box too long to scroll to the top of — a long
     transcript. It needs no top: two fingers dragged down together anywhere in
     the scope refresh it. Spreading or pinching them hands the gesture back to
     the browser's zoom, and so does a move the browser has already claimed
     (`cancelable` false): it only ever takes a drag nothing else wanted.

   Passive except where it must not be: a two-finger pull cancels the moves it
   has claimed, or the box would scroll under it. */
import * as React from "react"
import { useCoarsePointer } from "@/hooks/use-device"
import { safeAreaState } from "@/lib/safe-area-inset"
import { CONTENT_OVERLAP } from "@/lib/workspace/panel-overlap"

/** How far the fingers travel before a pull starts (px). Below it a tap or a
    short drag is still just a tap or a short drag. */
const SLOP = 8
/** A two-finger drag whose spread changes by more than this is a pinch. */
const PINCH = 24
/** UIScrollView's rubber-band constant: the overscroll drawn for a finger
    travel `x` over a box `d` tall is `(1 - 1 / (x * C / d + 1)) * d`. */
const RUBBER_BAND = 0.55
/** Drawn distance at which the refresh starts, mid-drag. */
export const PULL_TRIGGER = 88
/** How far the box stays pulled open while refreshing — the control's own
    height on iOS. */
export const PULL_REST = 60
/** The settle back to rest or to closed: UIKit's default spring, close
    enough as a curve. */
export const PULL_SETTLE_MS = 350
const SETTLE = `transform ${PULL_SETTLE_MS}ms cubic-bezier(0.25, 1, 0.5, 1)`

/* Surfaces that own a drag of their own, or are not the page: a menu, a field
   being typed in, and the canvases that pan (a terminal, an editor, a graph,
   a map). `data-no-pull-refresh` is the opt-out for anything else. Dialogs
   are `OVERLAY`, below. */
const EXCLUDED = [
  "[data-no-pull-refresh]",
  "[role=menu]",
  "[role=listbox]",
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable=false])",
  ".xterm",
  ".monaco-editor",
  ".react-flow",
  "canvas",
].join(",")

/* An overlay is not the page and its drag is usually its own dismissal — with
   one exception: the phone's sidebar is a sheet, and its thread list is the
   list a reader most expects to pull. */
const OVERLAY = "[role=dialog],[role=alertdialog]"
const SIDEBAR_SHEET = '[data-slot="sidebar"][data-mobile="true"]'

const rubberBand = (x: number, d: number) => (1 - 1 / ((x * RUBBER_BAND) / d + 1)) * d

/** Where the indicator may be drawn: the visible top edge of the box being
    pulled and the column it is centred in, in viewport px. */
export type PullFrame = { top: number; left: number; width: number }

export type PullView = {
  /** Drawn distance the box is pulled, px. */
  offset: number
  /** 0..1 towards the trigger; 1 while refreshing. */
  progress: number
  refreshing: boolean
  /** The offset is easing (a release), not following a finger. */
  settling: boolean
  frame: PullFrame | null
}

export type PullOptions = {
  onRefresh: () => Promise<void>
  /** Called when `onRefresh` rejects. */
  onError?: (error: unknown) => void
  /** The box the gesture is listened for in, and the box it moves. Omitted,
      the whole document listens and the nearest scroller is moved. */
  scope?: HTMLElement | null
  fingers?: 1 | 2
  enabled?: boolean
}

function excluded(target: Element): boolean {
  if (target.closest(EXCLUDED)) return true
  const overlay = target.closest(OVERLAY)
  return !!overlay && !overlay.matches(SIDEBAR_SHEET)
}

/** The nearest scroller around `target` (null when there is none), or
    undefined when something on the way up is scrolled — a list at its top
    inside a page scrolled halfway down is not "at the top". */
function scrollerAtTop(target: Element): HTMLElement | null | undefined {
  let scroller: HTMLElement | null = null
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollTop > 0) return undefined
    if (!scroller && node instanceof HTMLElement && node !== document.body && node !== document.documentElement) {
      const overflow = getComputedStyle(node).overflowY
      if (overflow === "auto" || overflow === "scroll") scroller = node
    }
  }
  return scroller
}

/* ── Edge to edge ──
   The shell draws behind the status bar (`viewport-fit=cover`) and a scroller
   under the floating header starts *behind* it and the tab band in it, so the
   box's own top is not where the reader can see. The visible top is the
   measured overlap the panel already publishes (`--dock-content-overlap`,
   lib/workspace/panel-overlap.ts — inherited down to every scroller in the
   panel), and never above the safe-area inset; sideways, a landscape notch
   narrows the column. With no box at all, the header's bottom edge. */
function frameFor(node: HTMLElement | null): PullFrame {
  const safe = safeAreaState()
  const right = window.innerWidth - safe.right
  if (!node) {
    const header = document.querySelector<HTMLElement>("[data-app-header]")
    const top = Math.max(header?.getBoundingClientRect().bottom ?? 0, safe.top)
    return { top, left: safe.left, width: right - safe.left }
  }
  const rect = node.getBoundingClientRect()
  const overlap = parseFloat(getComputedStyle(node).getPropertyValue(CONTENT_OVERLAP)) || 0
  const left = Math.max(rect.left, safe.left)
  return {
    top: Math.max(rect.top + overlap, safe.top),
    left,
    width: Math.max(0, Math.min(rect.right, right) - left),
  }
}

type Point = { x: number; y: number }
const centroid = (touches: TouchList): Point => {
  let x = 0
  let y = 0
  for (const touch of Array.from(touches)) {
    x += touch.clientX
    y += touch.clientY
  }
  return { x: x / touches.length, y: y / touches.length }
}
const spread = (touches: TouchList) =>
  touches.length < 2
    ? 0
    : Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY)

const IDLE: PullView = { offset: 0, progress: 0, refreshing: false, settling: false, frame: null }

export function usePullToRefresh({ onRefresh, onError, scope, fingers = 1, enabled = true }: PullOptions): PullView {
  const coarse = useCoarsePointer()
  const [view, setView] = React.useState<PullView>(IDLE)
  const callbacks = React.useRef({ onRefresh, onError })
  callbacks.current = { onRefresh, onError }
  /* A scoped gesture waits for its box; an unscoped one is the document's. */
  const root: Document | HTMLElement | null = scope === undefined ? document : scope
  const active = coarse && enabled && !!root

  React.useEffect(() => {
    if (!active || !root) return
    /* The gesture's state lives in the closure, because a touchmove handler
       reads the newest value, not the one its render closed over. */
    let start: Point | null = null
    let startSpread = 0
    let pulling = false
    let fingerDown = false
    let refreshing = false
    let drawn = 0
    let frame: PullFrame | null = null
    /** The box being moved, and its own inline styles to hand back. */
    let moved: { node: HTMLElement; transform: string; transition: string } | null = null
    let restoreTimer = 0

    const publish = (settling: boolean) =>
      setView({
        offset: drawn,
        progress: refreshing ? 1 : Math.min(1, drawn / PULL_TRIGGER),
        refreshing,
        settling,
        frame,
      })

    const paint = (next: number, animate: boolean) => {
      drawn = next
      publish(animate)
      if (!moved) return
      moved.node.style.transition = animate ? SETTLE : "none"
      moved.node.style.transform = next > 0 ? `translateY(${next}px)` : moved.transform
    }

    /* Hand the box its own styles back once the settle to closed has run, so
       nothing of the gesture outlives it — a transform left on a scroller is a
       containing block for every fixed child inside it. */
    const release = () => {
      const was = moved
      moved = null
      if (!was) return
      restoreTimer = window.setTimeout(() => {
        was.node.style.transform = was.transform
        was.node.style.transition = was.transition
      }, PULL_SETTLE_MS + 50)
    }

    const close = () => {
      paint(0, true)
      release()
    }

    const fire = () => {
      refreshing = true
      publish(false)
      navigator.vibrate?.(10)
      void callbacks.current
        .onRefresh()
        .catch((error: unknown) => callbacks.current.onError?.(error))
        .finally(() => {
          refreshing = false
          // Fingers still down keep the box where it is; lifting closes it.
          if (fingerDown) publish(false)
          else close()
        })
    }

    const abandon = () => {
      start = null
      pulling = false
      if (!refreshing) moved = null
    }

    const onStart = (event: TouchEvent) => {
      /* A second finger landing on a one-finger pull is not that pull any
         more; a first finger is never a two-finger one yet. */
      if (event.touches.length !== fingers) {
        /* Forgotten even before a pull is claimed: otherwise the finger left
           behind when one of two lifts would carry a stale start point. */
        start = null
        if (pulling && !refreshing) {
          fingerDown = false
          pulling = false
          close()
        }
        return
      }
      if (refreshing || pulling) return
      if (!(event.target instanceof Element) || excluded(event.target)) return
      let node: HTMLElement | null
      if (fingers === 2) {
        node = scope ?? null
      } else {
        const scroller = scrollerAtTop(event.target)
        if (scroller === undefined) return
        node = scope ?? scroller
      }
      start = centroid(event.touches)
      startSpread = spread(event.touches)
      fingerDown = true
      frame = frameFor(node)
      window.clearTimeout(restoreTimer)
      moved = node ? { node, transform: node.style.transform, transition: node.style.transition } : null
    }

    const onMove = (event: TouchEvent) => {
      if (!start) return
      if (event.touches.length !== fingers) return
      const at = centroid(event.touches)
      const dy = at.y - start.y
      const dx = at.x - start.x
      if (!pulling) {
        if (fingers === 2) {
          if (Math.abs(spread(event.touches) - startSpread) > PINCH) return abandon()
          /* Held from the first frame while it still looks like a pull down:
             a move let through inside the slop is the one the browser starts
             panning on, and every move after it arrives non-cancelable. */
          if (dy >= 0 && Math.abs(dx) <= Math.max(dy, SLOP) && event.cancelable) event.preventDefault()
        }
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
        /* Direction is decided once, on the first real movement: sideways is
           a swipeable row or a tab strip, upwards is a scroll. Either way the
           gesture is not ours, and stays not ours until the fingers lift. A
           two-finger move the browser has already started panning is not
           cancelable any more, and taking it would fight the scroll. */
        if (dy <= 0 || Math.abs(dx) > dy) return abandon()
        if (fingers === 2 && !event.cancelable) return abandon()
        pulling = true
      }
      if (fingers === 2 && event.cancelable) event.preventDefault()
      paint(Math.max(refreshing ? PULL_REST : 0, rubberBand(Math.max(0, dy - SLOP), window.innerHeight)), false)
      if (!refreshing && drawn >= PULL_TRIGGER) fire()
    }

    const onEnd = (event: TouchEvent) => {
      // One of two fingers lifting ends a two-finger pull; it is a release.
      if (event.touches.length >= fingers) return
      fingerDown = false
      const wasPulling = pulling
      start = null
      pulling = false
      if (!wasPulling) {
        if (!refreshing) moved = null
        return
      }
      if (refreshing) paint(PULL_REST, true)
      else close()
    }

    const passive = { passive: true, capture: true } as const
    const claiming = { passive: fingers === 1, capture: true } as const
    const target = root as EventTarget
    target.addEventListener("touchstart", onStart as EventListener, passive)
    target.addEventListener("touchmove", onMove as EventListener, claiming)
    target.addEventListener("touchend", onEnd as EventListener, passive)
    target.addEventListener("touchcancel", onEnd as EventListener, passive)
    return () => {
      target.removeEventListener("touchstart", onStart as EventListener, passive)
      target.removeEventListener("touchmove", onMove as EventListener, claiming)
      target.removeEventListener("touchend", onEnd as EventListener, passive)
      target.removeEventListener("touchcancel", onEnd as EventListener, passive)
      window.clearTimeout(restoreTimer)
      if (moved) {
        moved.node.style.transform = moved.transform
        moved.node.style.transition = moved.transition
      }
      setView(IDLE)
    }
  }, [active, root, scope, fingers])

  return active ? view : IDLE
}
