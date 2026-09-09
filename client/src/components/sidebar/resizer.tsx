/* ── The resize handle ──
   The sidebar's width overrides the shadcn default through the same CSS var
   it reads (`--sidebar-width`, set on the provider by the shell). Device-local
   like every other reading of how the app is drawn.

   The drag writes that var straight onto the wrapper element and commits to
   React state only on release: the handle sits inside the app shell, so a
   setState per pointermove re-rendered the sidebar, the dock and the
   transcript at pointer rate. Same for `data-resizing` (which kills the width
   easing, index.css) — an attribute, not a render. */
import * as React from "react"

const KEY = "sidebar_width"
const DEFAULT = "16rem"
const clamp = (x: number) => `${Math.min(520, Math.max(180, Math.round(x)))}px`

export function useSidebarWidth() {
  const [width, setWidth] = React.useState(() => localStorage.getItem(KEY) ?? DEFAULT)
  /* Live width during a drag; React never sees it until pointerup. */
  const live = React.useRef(width)
  const wrapper = React.useRef<HTMLElement | null>(null)

  const apply = (value: string) => {
    live.current = value
    wrapper.current?.style.setProperty("--sidebar-width", value)
  }

  /* Sits on the sidebar's right edge — the fixed container is its containing
     block. CSS hides it in the icon rail (index.css). */
  const resizer = (
    <div
      data-slot="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        wrapper.current = event.currentTarget.closest<HTMLElement>('[data-slot="sidebar-wrapper"]')
        wrapper.current?.setAttribute("data-resizing", "")
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!wrapper.current) return
        apply(clamp(event.clientX))
      }}
      onPointerUp={() => {
        if (!wrapper.current) return
        wrapper.current.removeAttribute("data-resizing")
        wrapper.current = null
        localStorage.setItem(KEY, live.current)
        setWidth(live.current)
      }}
      onDoubleClick={() => {
        apply(DEFAULT)
        localStorage.removeItem(KEY)
        setWidth(DEFAULT)
      }}
      className="absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize hover:bg-sidebar-border md:block"
    />
  )
  return { width, resizer }
}
