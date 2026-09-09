/* ── The resize handle ──
   The sidebar's width overrides the shadcn default through the same CSS var
   it reads (`--sidebar-width`, set on the provider by the shell). Device-local
   like every other reading of how the app is drawn. */
import * as React from "react"

const KEY = "sidebar_width"
const DEFAULT = "16rem"

export function useSidebarWidth() {
  const [width, setWidth] = React.useState(() => localStorage.getItem(KEY) ?? DEFAULT)
  const [resizing, setResizing] = React.useState(false)
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
        event.currentTarget.setPointerCapture(event.pointerId)
        setResizing(true)
      }}
      onPointerMove={(event) => {
        if (!resizing) return
        setWidth(`${Math.min(520, Math.max(180, Math.round(event.clientX)))}px`)
      }}
      onPointerUp={() => {
        setResizing(false)
        localStorage.setItem(KEY, width)
      }}
      onDoubleClick={() => {
        setWidth(DEFAULT)
        localStorage.removeItem(KEY)
      }}
      className="absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize hover:bg-sidebar-border md:block"
    />
  )
  return { width, resizing, resizer }
}
