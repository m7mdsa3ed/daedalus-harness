/* ── The passages a thread's asides were started on, marked in its transcript ──
   Drawn with the CSS Custom Highlight API (`::highlight(aside)` in index.css):
   ranges over the text as it is, so no row is re-rendered or wrapped, and a
   streamed or re-folded transcript is just re-read. A click that lands inside
   one opens its aside.

   Matching ignores whitespace: `Selection.toString()` puts newlines between
   blocks that the DOM's text nodes do not hold, so the quote and the text are
   compared as their non-space characters, mapped back to (node, offset). */
import * as React from "react"

import { useStoreSelect } from "@/lib/store"
import type { AsideAt } from "./aside-window"

/* One highlight for every mounted transcript (the dock keeps background tabs
   mounted), each adding and removing only its own ranges — a name per thread
   could not be styled from CSS. */
const shared = typeof CSS !== "undefined" && "highlights" in CSS ? new Highlight() : null
if (shared) CSS.highlights.set("aside", shared)

/** [id, quote] of every live aside of `sessionId`, as one string so the store
    subscription wakes only when that set changes. */
function asidesKey(sessions: { id: string; forkedFromSessionId?: string | null; asideQuote?: string | null; deletedAt?: number | null }[], sessionId: string) {
  return JSON.stringify(
    sessions
      .filter((s) => s.forkedFromSessionId === sessionId && s.asideQuote && !s.deletedAt)
      .map((s) => [s.id, s.asideQuote])
  )
}

function findRanges(root: HTMLElement, asides: [string, string][]): [string, Range][] {
  const chars: string[] = []
  const at: [Text, number][] = []
  for (const transcript of root.querySelectorAll(".thread-transcript")) {
    const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const text = node.data
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) continue
        chars.push(text[i])
        at.push([node, i])
      }
    }
  }
  const haystack = chars.join("")
  const found: [string, Range][] = []
  for (const [id, quote] of asides) {
    const needle = quote.replace(/\s+/g, "")
    if (!needle) continue
    // ponytail: first occurrence only — a passage said twice marks the first.
    const start = haystack.indexOf(needle)
    if (start < 0) continue
    const [startNode, startOffset] = at[start]
    const [endNode, endOffset] = at[start + needle.length - 1]
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset + 1)
    found.push([id, range])
  }
  return found
}

function pointIn(range: Range, x: number, y: number): boolean {
  for (const rect of range.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true
  }
  return false
}

/** Mark this thread's aside passages, and open one when it is clicked. */
export function useAsideHighlights(
  rootRef: React.RefObject<HTMLElement | null>,
  sessionId: string,
  onOpen: (at: AsideAt, asTab: boolean) => void
) {
  const key = useStoreSelect((state) => asidesKey(state.sessions, sessionId))
  const onOpenRef = React.useRef(onOpen)
  onOpenRef.current = onOpen

  React.useEffect(() => {
    const root = rootRef.current
    const asides = JSON.parse(key) as [string, string][]
    if (!shared || !root || asides.length === 0) return
    const highlight = shared
    let ranges: [string, Range][] = []
    const drop = () => {
      for (const [, range] of ranges) highlight.delete(range)
    }
    let frame = 0
    const refresh = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        drop()
        ranges = findRanges(root, asides)
        for (const [, range] of ranges) highlight.add(range)
      })
    }
    refresh()
    // Streaming, paging and re-folds all rewrite text nodes.
    // ponytail: re-walks the whole transcript once per frame while it streams,
    // and only in a thread that has asides; scope to changed rows if it shows.
    const observer = new MutationObserver(refresh)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    const onClick = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return
      const hit = ranges.find(([, range]) => pointIn(range, event.clientX, event.clientY))
      if (hit) onOpenRef.current({ id: hit[0], x: event.clientX, y: event.clientY }, event.metaKey || event.ctrlKey)
    }
    root.addEventListener("click", onClick)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      root.removeEventListener("click", onClick)
      drop()
    }
  }, [rootRef, sessionId, key])
}
