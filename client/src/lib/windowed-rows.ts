/* ── Windowed rows ── a long list renders only what is near the viewport, in
   flow layout.

   Built on `useVirtualizer`, but rows are never absolutely positioned: the ones
   the window renders stay ordinary siblings in the list's own flow, so `ul/li`,
   a `<table>`'s sticky header and columns, `divide-y` and a flex `gap` keep
   working. A rendered row that is not adjacent to the one before it carries a
   `marginTop` (`before`) standing for the rows skipped between them, and one
   trailing spacer (`after`) stands for everything below the last one — so the
   scroller's `scrollHeight` is the full list's, and follow-to-bottom and the
   load-more sentinels that read it are unchanged.

   Pinned rows (the focused row, its neighbours, a selection, a drag source) are
   always rendered at their true flow position, which is what keeps `.focus()`,
   `scrollIntoView` and `querySelector` code working against a windowed list.

   Below `threshold` the hook is off: every index, `before` 0, `after` 0 and a
   noop `measure`, so every caller has one render path and a short list stays
   plain DOM (find-in-page, exact layout, zero overhead). */
import * as React from "react"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"

export interface WindowedRow {
  index: number
  key: React.Key
  /** The `marginTop` standing for the rows skipped above this one; 0 when it
      follows the previous rendered row directly. */
  before: number
}

export interface Windowed {
  /** `count > threshold`. */
  windowed: boolean
  /** Off: every index, `before` 0. */
  rows: WindowedRow[]
  /** Height of ONE trailing `aria-hidden` spacer sibling; 0 when off or nothing
      below the last rendered row. */
  after: number
  /** `virtualizer.measureElement` (stable) when windowed and measured, else a
      stable noop. */
  measure: (el: Element | null) => void
}

const noop = () => {}

/** `el` itself or its nearest ancestor that scrolls vertically. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === "auto" || overflow === "scroll") return node
  }
  return null
}

/** The rendered virtual items as flow rows: each row's `before` is the gap its
    predecessor does not account for, and `after` is what is left below the last
    one. `end` is the absolute end of the whole list (`getTotalSize() +
    scrollMargin`). Pure. */
export function flowRows(
  items: readonly { index: number; key: React.Key; start: number; end: number }[],
  scrollMargin: number,
  gap: number,
  end: number
): { rows: WindowedRow[]; after: number } {
  const rows: WindowedRow[] = []
  let prevEnd: number | null = null
  for (const item of items) {
    const before = prevEnd === null ? item.start - scrollMargin : Math.max(0, item.start - prevEnd - gap)
    rows.push({ index: item.index, key: item.key, before })
    prevEnd = item.end
  }
  return { rows, after: prevEnd === null ? 0 : Math.max(0, end - prevEnd - gap) }
}

export function useWindowedRows(o: {
  count: number
  threshold: number
  /** The element the rows flow in; row 0 sits at its content-box top. */
  list: React.RefObject<HTMLElement | null>
  /** Default `scrollParent(list)`. */
  scroller?: () => HTMLElement | null
  /** Includes nothing of the CSS gap. */
  estimateSize: (index: number) => number
  getItemKey?: (index: number) => React.Key
  /** Always rendered; out-of-range/null ignored. */
  pin?: readonly (number | null | undefined)[]
  /** The list's CSS gap in px (flex gap-1 = 4, gap-px = 1, gap-2 = 8). */
  gap?: number
  /** Default 8. */
  overscan?: number
  /** Default false = fixed estimate, no measureElement. */
  measured?: boolean
}): Windowed {
  const { count, threshold, list, gap = 0, overscan = 8, measured = false } = o
  const enabled = count > threshold
  const getScroller = o.scroller ?? (() => (list.current ? scrollParent(list.current) : null))
  const scrollerRef = React.useRef(getScroller)
  scrollerRef.current = getScroller

  const [scrollMargin, setScrollMargin] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = list.current
    const scroller = scrollerRef.current()
    if (!enabled || !el || !scroller) return
    const read = () => {
      const pad = parseFloat(getComputedStyle(el).paddingTop) || 0
      let next: number
      if (el === scroller) next = pad
      else {
        const a = el.getBoundingClientRect()
        const b = scroller.getBoundingClientRect()
        next = a.top + el.clientTop + pad - (b.top + scroller.clientTop) + scroller.scrollTop
      }
      setScrollMargin((prev) => (Math.abs(prev - next) >= 0.5 ? next : prev))
    }
    read()
    /* Anything above the list that changes size resizes the list itself or one
       of the scroller's direct children. */
    const observer = new ResizeObserver(read)
    observer.observe(el)
    /* A child mounted later (a group appearing above the list) moves the list
       without resizing anything observed, so it is read and observed too. When
       the list is the scroller its children are the rows and only its padding
       counts, so neither is watched. */
    const added = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => node instanceof Element && observer.observe(node))
        record.removedNodes.forEach((node) => node instanceof Element && observer.unobserve(node))
      }
      read()
    })
    if (el !== scroller) {
      for (const child of Array.from(scroller.children)) observer.observe(child)
      added.observe(scroller, { childList: true })
    }
    /* Flow layout: virtual-core compensates a size change above the fold
       itself, so the browser's own scroll anchoring must not do it twice. */
    const anchor = el.style.overflowAnchor
    el.style.overflowAnchor = "none"
    return () => {
      observer.disconnect()
      added.disconnect()
      el.style.overflowAnchor = anchor
    }
  }, [enabled, list])

  const pins = (o.pin ?? []).filter((i): i is number => i != null && i >= 0 && i < count)
  const pinKey = pins.join(",")
  const rangeExtractor = React.useCallback(
    (range: Range) => {
      const pinned = pinKey ? pinKey.split(",").map(Number) : []
      if (!pinned.length) return defaultRangeExtractor(range)
      return Array.from(new Set([...defaultRangeExtractor(range), ...pinned])).sort((a, b) => a - b)
    },
    [pinKey]
  )

  const virtualizer = useVirtualizer<HTMLElement, Element>({
    enabled,
    count,
    getScrollElement: () => scrollerRef.current(),
    estimateSize: o.estimateSize,
    getItemKey: o.getItemKey,
    gap,
    overscan,
    scrollMargin,
    rangeExtractor,
    /* While disabled virtual-core drops its rect, and on the render that
       enables it falls back to `initialRect` — at {0,0} that render's range is
       empty, pins included, and every row (the focused one too) unmounts for a
       commit. Read lazily from the scroller instead, until its observer
       reports. */
    initialRect: {
      get width() {
        return scrollerRef.current()?.clientWidth ?? 0
      },
      get height() {
        return scrollerRef.current()?.clientHeight ?? 0
      },
    },
    initialOffset: () => scrollerRef.current()?.scrollTop ?? 0,
  })

  if (!enabled) {
    const rows: WindowedRow[] = []
    for (let index = 0; index < count; index++) rows.push({ index, key: o.getItemKey?.(index) ?? index, before: 0 })
    return { windowed: false, rows, after: 0, measure: noop }
  }
  const { rows, after } = flowRows(virtualizer.getVirtualItems(), scrollMargin, gap, virtualizer.getTotalSize() + scrollMargin)
  return { windowed: true, rows, after, measure: measured ? virtualizer.measureElement : noop }
}

/** The index of the row (`[data-index]`) focus last landed in, for a list to
    pin. Remembered by key, so a re-sort or an insertion above it still names
    the same row; never cleared on blur, since focus coming back to a menu's
    trigger lands there again. `onFocus` goes on the list element. */
export function useFocusedRow(count: number, keyOf: (index: number) => React.Key) {
  const [at, setAt] = React.useState<{ index: number; key: React.Key } | null>(null)
  const keyRef = React.useRef(keyOf)
  keyRef.current = keyOf
  const onFocus = React.useCallback((e: React.FocusEvent) => {
    /* React bubbles focus out of a portal (a row's menu) too; only a row in
       this list counts. */
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-index]")
    if (!row || !e.currentTarget.contains(row)) return
    const index = Number(row.dataset.index)
    if (!Number.isInteger(index) || index < 0) return
    const key = keyRef.current(index)
    setAt((prev) => (prev && prev.index === index && prev.key === key ? prev : { index, key }))
  }, [])
  return [findRow(at, count, keyOf), onFocus] as const
}

/** Where a remembered row is now: its old index while that still holds its
    key, else wherever the key went, else null (it left the list). Pure. */
export function findRow(at: { index: number; key: React.Key } | null, count: number, keyOf: (index: number) => React.Key) {
  if (!at) return null
  if (at.index < count && keyOf(at.index) === at.key) return at.index
  // ponytail: linear scan only after the row moved; a key→index map if lists reach 100k.
  for (let i = 0; i < count; i++) if (keyOf(i) === at.key) return i
  return null
}
