/* ── Scroll restoration ──
   React Router's own <ScrollRestoration> manages the window scroller; this app
   scrolls inside route-scoped containers (the settings column), so the memory
   has to live with the container. Per-key, in-memory on purpose: within a
   session content heights are stable and the restore lands exactly; across a
   reload they aren't, and restoring into half-loaded content just jumps. */
import * as React from "react"

const positions = new Map<string, number>()

/** Attach to a scroll container; its position is saved as it scrolls and put
    back whenever the same `key` (e.g. the pathname) mounts again. */
export function useScrollRestoration<T extends HTMLElement>(
  key: string
): React.RefObject<T | null> {
  const ref = React.useRef<T>(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = positions.get(key) ?? 0
    const onScroll = () => positions.set(key, el.scrollTop)
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [key])
  return ref
}
