import { ArrowDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * The way back to the tail, beside the composer's pill.
 *
 * Ours and not the scroller primitive's button, on purpose: that one draws from
 * the primitive's own at-the-end state, which is not the pin the composer folds
 * on (`useFollowStream`), so the two disagreed — the button hovering over an
 * open composer, appearing and disappearing on its own. This one has no state of
 * its own. It is shown exactly while the composer is folded away
 * (`data-composer-away`, which is `collapsed && !revealed`, and `collapsed` is
 * `!pinned`), read through the thread's group, so the pill and the button are
 * one fact drawn twice and cannot drift. Hidden, it is `invisible`: out of the
 * tab order and the accessibility tree, not just transparent.
 */
export function ScrollToEnd({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-label="Scroll to end"
      title="Scroll to end"
      className="invisible absolute bottom-[max(0.75rem,var(--safe-bottom))] end-[calc(max(1rem,calc((100%_-_var(--harness-composer-width))/2))+2.75rem)] z-30 size-9 scale-95 rounded-pill border-0 bg-composer/90 p-0 text-muted-foreground opacity-0 shadow-glass ring-1 ring-foreground/10 backdrop-blur-[var(--app-blur)] transition-[opacity,scale,visibility] duration-200 hover:bg-composer/90 hover:text-foreground group-has-[[data-composer-away]]/thread:visible group-has-[[data-composer-away]]/thread:scale-100 group-has-[[data-composer-away]]/thread:opacity-100"
    >
      <ArrowDownIcon />
    </Button>
  )
}
