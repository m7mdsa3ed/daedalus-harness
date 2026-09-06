/* ── Panel container ──
   A dockview panel is a box inside the window, but every responsive rule in
   this app was a *media* query — so a chat squeezed to 320px beside a terminal
   still drew the desktop layout, because the window was still 1600px wide. The
   panel-hosted components ask the panel now: this wraps every panel's content
   in a query container, so `@panel-sm:` / `@panel-md:` (the two breakpoints in
   `index.css`, 40rem and 48rem — the old `sm:` and `md:` in pixels) read the
   width of the box the component is actually in.

   Two rules the conversion follows, because "mobile" was two questions wearing
   one word:

   - **Width is the panel's.** Layout that needs room — a column that has to
     hide, a grid that has to lose a track, a popover's cap — is a container
     query now.
   - **Coarse pointers are the device's.** Touch targets (`min-h-11`), the
     terminal's soft key bar, Enter-inserts-a-newline: those stay on
     `useIsMobile`, which still reads the window, because a narrow panel on a
     desktop is still driven by a mouse.

   The container is **unnamed**, so `@panel-sm:` resolves to the nearest
   container ancestor — which is this one for everything the dock hosts, since
   the only other containers in the app (`ui/card`'s header, `ui/field`'s group)
   are settings furniture and never wrap a transcript. Anything that puts a
   container *inside* a panel takes those queries with it, so name it if it does.

   The container is `inline-size`, not `size`: sizing both axes means size
   containment, and a panel whose height failed to resolve would collapse to
   nothing rather than merely lay out wrong. That leaves `cqh` unavailable, so
   the one thing CSS cannot answer here — the panel's height, which `svh` caps
   inside a short bottom-docked panel get as wrong as the media queries got the
   width — is measured and published as `--panel-h`. It is written to the style
   attribute rather than held in state: it changes on every frame of a sash
   drag, and nothing *renders* differently for it. Only CSS reads it, and the
   fallback (`var(--panel-h, 100svh)`) is what the same class means outside a
   panel, which is why the callers can be shared. */
import * as React from "react"

import { applyContentOverlap, subscribeDockLayout } from "@/lib/workspace/panel-overlap"
import { cn } from "@/lib/utils"

export function PanelContainer({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const node = ref.current
    if (!node) return

    /* How much of *this* panel the floating app header covers
       (`lib/workspace/panel-overlap.ts`). It is measured here rather than set by
       the dock because the dock renders panels into one overlay container at
       its root — a variable set on the group element never reaches them. */
    let frame: number | undefined
    const measure = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      /* A frame late, always: the box this reads is the one the browser has
         laid out, and inside the event that moved it that is still the old one. */
      frame = requestAnimationFrame(() => {
        frame = undefined
        applyContentOverlap(node)
      })
    }

    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.contentRect.height ?? 0
      /* A hidden tab measures 0×0 — dockview keeps every panel mounted. Writing
         that would cap the panes of a thread nobody is looking at to nothing,
         and the observer fires again on the way back in anyway. */
      if (height > 0) node.style.setProperty("--panel-h", `${Math.round(height)}px`)
      measure()
    })
    observer.observe(node)
    /* The two ways this panel can move without changing size: the dock
       rearranging around it, and the window (a rotation, a resized titlebar). */
    const unsubscribe = subscribeDockLayout(measure)
    window.addEventListener("resize", measure)
    measure()

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      window.removeEventListener("resize", measure)
      unsubscribe()
      observer.disconnect()
    }
  }, [])

  return (
    <div ref={ref} className={cn("@container h-full min-h-0 w-full", className)}>
      {children}
    </div>
  )
}
