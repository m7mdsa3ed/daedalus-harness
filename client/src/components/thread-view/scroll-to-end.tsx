import { ArrowDownIcon } from "lucide-react"

/**
 * The way back to the tail.
 *
 * Ours and not the scroller primitive's button, on purpose: that one draws from
 * the primitive's own at-the-end state, which is not the pin the composer folds
 * on (`useFollowStream`), so the two disagreed. This one is shown while the
 * reader is off the tail (`pinned` false) — the same fact the composer folds on
 * — and it has two places, both on the composer's right edge: beside the pill
 * while the box is folded away (`data-composer-away`, read through the thread's
 * group), and centred above the card once the reader has brought it back (a click on
 * the pill, a fill) and is still not at the end. Showing waits 300ms (`delay-300`; hiding is immediate), so brushing past the
 * edge while scrolling never draws it. Hidden, it is `invisible`: out
 * of the tab order and the accessibility tree, not just transparent.
 *
 * It is the composer's pill (`composer-pill`), the same control, and it only
 * fades: no position or scale transition, so it never moves on its way in or out.
 */
export function ScrollToEnd({ pinned, onClick }: { pinned: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Scroll to end"
      title="Scroll to end"
      data-pinned={pinned || undefined}
      className="composer-pill absolute bottom-[calc(var(--composer-dock-h,14rem)+0.75rem)] start-1/2 z-30 -translate-x-1/2 transition-opacity duration-300 ease-out delay-300 data-pinned:delay-0 group-has-[[data-composer-away]]/thread:bottom-[max(0.75rem,var(--safe-bottom))] group-has-[[data-composer-away]]/thread:start-auto group-has-[[data-composer-away]]/thread:translate-x-0 group-has-[[data-composer-away]]/thread:end-[calc(max(1rem,calc((100%_-_var(--harness-composer-width))/2))+var(--composer-pill)+0.5rem)] data-pinned:invisible data-pinned:opacity-0"
    >
      <ArrowDownIcon className="size-4" />
    </button>
  )
}
