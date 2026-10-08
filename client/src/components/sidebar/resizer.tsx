/* ── The resize handle ──
   The sidebar's width overrides the shadcn default through the same CSS var
   it reads (`--sidebar-width`, set on the provider by the shell). Device-local
   like every other reading of how the app is drawn.

   The drag writes that var straight onto the DOM and commits to React state
   only on release: the handle sits inside the app shell, so a setState per
   pointermove re-rendered the sidebar, the dock and the transcript at pointer
   rate. Same for `data-resizing` (which kills the width easing, index.css) —
   an attribute, not a render.

   Two more things are load-bearing, and both exist because this drag used to
   be visibly heavier than dragging a dock sash — which does strictly more work
   per move (it resizes every view in the grid) and still felt smoother.

   • **One write per frame, not one per event.** `pointermove` fires at the
     *pointer's* sampling rate, which on anything better than an office mouse
     is 250–1000Hz — four to sixteen moves per displayed frame, each one
     forcing a full style, layout and paint pass whose result is thrown away by
     the next. The moves are coalesced onto a rAF and only the last position of
     each frame is ever written, so the browser does the work once for the
     frame it actually shows. This is also why a dock sash felt fine: its work
     is bigger but it stays inside the dock, where this was re-laying out the
     document.
   • **The var is written on the sidebar, not on the wrapper.** A custom
     property is inherited, so setting it on `sidebar-wrapper` — which contains
     the dock and every open transcript — invalidates style for the entire app
     subtree on every move, to move two elements that are both inside
     `[data-slot="sidebar"]`. Writing it there instead confines the
     invalidation to the sidebar; the dock still re-layouts, because the gap
     element genuinely got wider, but it is no longer asked to recompute its
     style as well. The inline value is removed on release so the wrapper's —
     which is React's, from the state committed on the same event — is what
     stands at rest, and nothing is left shadowing it. */
import * as React from "react"

const KEY = "sidebar_width"
const DEFAULT = "16rem"
const MIN = 180
const MAX = 520
const clamp = (x: number) => `${Math.min(MAX, Math.max(MIN, Math.round(x)))}px`
/* The stored width is "16rem" or "NNNpx"; the separator reports pixels. */
const px = (w: string) =>
  w.endsWith("rem") ? parseFloat(w) * parseFloat(getComputedStyle(document.documentElement).fontSize) : parseFloat(w)

export function useSidebarWidth() {
  const [width, setWidth] = React.useState(() => localStorage.getItem(KEY) ?? DEFAULT)
  /* Live width during a drag; React never sees it until pointerup. */
  const live = React.useRef(width)
  const sidebar = React.useRef<HTMLElement | null>(null)
  /* The frame's pending position, and the frame it is pending on. `null` means
     nothing is scheduled — never 0, which is a real rAF handle. */
  const pending = React.useRef<number | null>(null)
  const frame = React.useRef<number | null>(null)

  const write = (value: string) => {
    live.current = value
    sidebar.current?.style.setProperty("--sidebar-width", value)
  }

  const flush = () => {
    frame.current = null
    if (pending.current === null || !sidebar.current) return
    write(clamp(pending.current))
    pending.current = null
  }

  const stop = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    pending.current = null
  }

  /* A drag interrupted by an unmount would otherwise leave a frame scheduled
     against an element that is gone. */
  React.useEffect(() => stop, [])

  /* Sits on the sidebar's right edge — the fixed container is its containing
     block. CSS hides it in the icon rail (index.css). */
  const resizer = (
    <div
      data-slot="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      tabIndex={0}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuenow={px(width)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16
        const now = px(live.current)
        const next =
          event.key === "ArrowLeft" ? now - step
          : event.key === "ArrowRight" ? now + step
          : event.key === "Home" ? MIN
          : event.key === "End" ? MAX
          : null
        if (next === null) return
        event.preventDefault()
        const value = clamp(next)
        live.current = value
        localStorage.setItem(KEY, value)
        setWidth(value)
      }}
      title="Drag to resize · double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        sidebar.current = event.currentTarget.closest<HTMLElement>('[data-slot="sidebar"]')
        sidebar.current?.setAttribute("data-resizing", "")
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!sidebar.current) return
        pending.current = event.clientX
        if (frame.current === null) frame.current = requestAnimationFrame(flush)
      }}
      onPointerUp={() => {
        const el = sidebar.current
        if (!el) return
        /* Take the last position the drag reached even if its frame never ran,
           or a flick that ends between frames snaps back a few pixels. */
        flush()
        stop()
        el.removeAttribute("data-resizing")
        /* React owns the value at rest — on the wrapper, where the provider
           put it — so the inline one goes rather than shadowing it forever. */
        el.style.removeProperty("--sidebar-width")
        sidebar.current = null
        localStorage.setItem(KEY, live.current)
        setWidth(live.current)
      }}
      onDoubleClick={() => {
        live.current = DEFAULT
        localStorage.removeItem(KEY)
        setWidth(DEFAULT)
      }}
      className="absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize hover:bg-sidebar-border focus-visible:bg-sidebar-border focus-visible:outline-2 focus-visible:outline-ring md:block"
    />
  )
  return { width, resizer }
}
