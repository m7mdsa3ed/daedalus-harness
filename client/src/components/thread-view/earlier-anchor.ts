/* ── The place the reader was ──
   Paging a page of history in is a *re-fold*: the reducer only appends, so an
   older event cannot be inserted into a built transcript and the whole widened
   window is folded again from the start (see `ThreadSocket.loadEarlier`). Every
   row that was on screen is therefore a new element carrying a newly minted id
   (`mintItemId`), and that is exactly what defeats the two things that would
   otherwise keep the scroll honest on their own: the scroller's own
   `preserveScrollOnPrepend` matches its anchor by *element*, and the browser's
   scroll anchoring drops its own the moment that element is removed. Nothing
   corrects the position, so the viewport stays at a `scrollTop` that now lands
   inside the page just folded in front of it — the reader is thrown back to the
   top of the thread and has to find their place again.

   So the anchor is ours, and it has to survive the rows being replaced. Two
   facts make that possible:

   • The row list only grows at the *front*. A page is whole turns, cut at a
     `turn_started`, and it is always older than what is on screen — so a row's
     **distance from the end** of the list is the same before and after.
   • What has to be kept is where the row sat *in the viewport*, not where it
     sits in the document. The inserted history is above the reader, and they
     are not looking at it yet.

   So: capture the topmost row still in view, and after the fold scroll by
   however much the content above it grew, which puts that row back at the
   offset it had. Skipping the "Load earlier steps" row itself, because it is
   the one row that does not survive every page — the last one takes it away
   entirely. `useLayoutEffect`, so the correction lands in the same frame as the
   fold's single commit and there is nothing to see.

   The trigger is the page's own busy flag settling — `loadingEarlier`, written
   false by `onRewound` in the very commit that wrote the rows. The two doors a
   page can come back through (a fold, and a load that failed before folding)
   both take that path, and a failure leaves the rows exactly as they were, so
   the correction is a no-op rather than a second mistake.

   The growth is read from `offsetTop` rather than from client rects, so the
   rows' entrance animation (`harness-item-in`, a `translateY` applied to every
   freshly mounted row) cannot enter the arithmetic: a transform moves a rect
   and not a layout box. And the layout above the anchor is not read back from
   the document either — rows are `content-visibility: auto` and a freshly
   folded window has measured none of them — the correction is against whatever
   that layout is at this moment, and the browser's own scroll anchoring takes
   over from there, on an anchor that is by then a row that is staying put. */
import * as React from "react"

interface Anchor {
  /** The element the row was in — held rather than the row, since the row is
      the thing about to be replaced. */
  viewport: HTMLElement
  /** The row's index counted from the end of the list, where 0 is the last. */
  fromEnd: number
  /** The row's layout position, to be compared with the same row's after the
      fold. Only ever used as a difference. */
  top: number
  /** The `loadingEarlier` the page was asked under — always true, since that is
      what the call site sets before it asks. */
  loading: boolean
}

/** The transcript's rows in document order, read off the ids the scroller
    already gives every one of them. The hidden spacer the primitive appends to
    the content element has none, so it is not mistaken for a row, and the
    "Load earlier steps" row is dropped for the reason in the header. The content
    is found by its slot rather than by being the viewport's first child: that is
    what it is today, and the ids are the contract that actually holds. */
function rowsOf(viewport: HTMLElement): HTMLElement[] {
  const content = viewport.querySelector(':scope > [data-slot="message-scroller-content"]')
  if (!content) return []
  return Array.from(content.querySelectorAll<HTMLElement>(":scope > [data-message-id]")).filter(
    (row) => row.dataset.messageId !== "earlier"
  )
}

function captureAnchor(viewport: HTMLElement | null, loading: boolean): Anchor | null {
  if (!viewport) return null
  const rows = rowsOf(viewport)
  if (rows.length === 0) return null
  const top = viewport.getBoundingClientRect().top
  /* The first row the viewport still shows any of. A row half scrolled off the
     top is the one the eye is on, so it is the bottom edge that is tested. */
  const row = rows.find((el) => el.getBoundingClientRect().bottom > top) ?? rows[rows.length - 1]
  return { viewport, fromEnd: rows.length - 1 - rows.indexOf(row), top: row.offsetTop, loading }
}

function restoreAnchor(anchor: Anchor): void {
  const { viewport } = anchor
  const rows = rowsOf(viewport)
  const row = rows[rows.length - 1 - anchor.fromEnd]
  /* Nothing at that distance from the end: the list did not grow the way a page
     does, and reaching for a different row would put the reader somewhere they
     were not. Leave them where they are. */
  if (!row) return
  const growth = row.offsetTop - anchor.top
  if (growth !== 0) viewport.scrollTop += growth
}

/**
 * Wrap the call that pages history in, so the reader's place survives the
 * re-fold. Returns the click handler for the "Load earlier steps" button.
 *
 * `loading` is the thread's own busy flag for the page (`ThreadState.loadingEarlier`),
 * which `actions.loadEarlier` raises before it asks and `onRewound` lowers in
 * the commit that carries the new rows — so the fall of it is the re-fold's own
 * signature, and the only one that needs no counting of what the fold did.
 */
export function useEarlierAnchor(
  viewport: HTMLElement | null,
  loading: boolean,
  load: () => void
): () => void {
  const anchorRef = React.useRef<Anchor | null>(null)
  const loadWithAnchor = React.useCallback(() => {
    anchorRef.current = captureAnchor(viewport, loading)
    load()
  }, [loading, load, viewport])
  React.useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor?.loading || loading) return
    anchorRef.current = null
    restoreAnchor(anchor)
  }, [loading])
  return loadWithAnchor
}
