/* ── Windowing a flat row list ──
   Draw the rows that are on screen and reserve the height of the ones that are
   not. The explorer's tree and source control's file lists are both flat arrays
   of fixed-height rows once they have been derived (`lib/ide/tree-rows.ts`), and
   a project with a few thousand files expanded is a few thousand DOM nodes
   otherwise — each one a context-menu wrapper around a button.

   No virtualization dependency: a row's height is known rather than measured,
   so where a row starts is arithmetic. What stops it being *pure* arithmetic is
   that one row kind is taller than the rest (a directory's loading skeleton), so
   the offsets are a prefix sum and the lookup is a binary search over it. That
   is the same amount of code as assuming one height and being wrong when a
   skeleton is on screen — the list would draw its last rows short by three
   lines and the scrollbar would lie.

   The hook owns no DOM of its own. It hands back a ref for the scroller, the
   slice to draw, and the pixel height to reserve above and below it. */
import * as React from "react"

export interface Windowed {
  /** Put this on the scrolling element. */
  ref: React.RefObject<HTMLDivElement | null>
  /** Index of the first row to draw. */
  start: number
  /** Index *past* the last row to draw — `rows.slice(start, end)`. */
  end: number
  /** Pixels of blank space standing in for the rows before `start`. */
  padTop: number
  /** Pixels standing in for the rows after `end`. */
  padBottom: number
}

export function useWindowedRows<T>({
  rows,
  lineHeight,
  linesOf,
  overscan = 8,
}: {
  rows: readonly T[]
  /** The height of one line, in pixels. */
  lineHeight: number
  /** How many lines a row occupies. Defaults to one. */
  linesOf?: (row: T) => number
  /** Rows to draw beyond each edge, so a scroll does not reveal blank space. */
  overscan?: number
}): Windowed {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewport, setViewport] = React.useState(0)

  /* `offsets[i]` is where row `i` starts; the last entry is the total height.
     Recomputed only when the rows themselves change — scrolling must not. */
  const offsets = React.useMemo(() => {
    const out = new Float64Array(rows.length + 1)
    for (let i = 0; i < rows.length; i++) {
      out[i + 1] = out[i]! + (linesOf ? linesOf(rows[i]!) : 1) * lineHeight
    }
    return out
    // `linesOf` is a module-level function at every call site; keying on it
    // would rebuild the sums whenever a caller passed a fresh arrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, lineHeight])

  React.useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const read = () => setScrollTop(node.scrollTop)
    node.addEventListener("scroll", read, { passive: true })
    /* A hidden panel measures 0 — dockview keeps every panel mounted — and a
       viewport of 0 would draw nothing *and* stick that way until a scroll. So
       height 0 is treated as "not on screen" and the last real height stands. */
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.contentRect.height ?? 0
      if (height > 0) setViewport(height)
    })
    observer.observe(node)
    setViewport(node.clientHeight)
    read()
    return () => {
      node.removeEventListener("scroll", read)
      observer.disconnect()
    }
  }, [])

  /** The first row whose *end* is past `y` — i.e. the one covering it. */
  const rowAt = React.useCallback(
    (y: number): number => {
      let low = 0
      let high = rows.length
      while (low < high) {
        const mid = (low + high) >> 1
        if (offsets[mid + 1]! <= y) low = mid + 1
        else high = mid
      }
      return low
    },
    [offsets, rows.length]
  )

  const total = offsets[rows.length] ?? 0
  /* Before the first measurement there is no viewport to cut against. Drawing
     the whole list for that one frame is what makes the list correct inside a
     container that never scrolls, and it is a frame either way. */
  const measured = viewport > 0
  const start = measured ? Math.max(0, rowAt(scrollTop) - overscan) : 0
  const end = measured ? Math.min(rows.length, rowAt(scrollTop + viewport) + 1 + overscan) : rows.length

  return {
    ref,
    start,
    end,
    padTop: offsets[start] ?? 0,
    padBottom: Math.max(0, total - (offsets[end] ?? total)),
  }
}
