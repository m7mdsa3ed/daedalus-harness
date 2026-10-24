/* ── How wide is this element? ──
   A ResizeObserver over one node, re-rendering on a content-box width change.
   What a panel does with it is decide what fits *inside the panel* rather than
   inside the window: a chat docked beside a terminal is narrow for the same
   reason a phone is, and the window's width knows nothing about it.

   Extracted from the file library's explorer (`components/files/file-items.tsx`),
   which had the only copy, when the Preview panel's explorer needed the same
   reading. */
import * as React from "react"

export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => entry.contentRect.width > 0 && setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}
