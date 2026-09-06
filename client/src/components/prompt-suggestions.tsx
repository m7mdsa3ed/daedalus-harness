/* ── Suggested follow-ups ──
   The model's closing `suggest-prompts` fence (`lib/suggestions`), drawn as a
   single simple line of pill chips under the very answer that offered them —
   the same footer slot where Sources and the token figure already read the
   turn. One line, and the line is the whole card: no header, no pager, no
   numbering.

   The row is the settings page's mobile tab strip, said again: flat pills with
   no border, no shadow and no glass, and an edge affordance that is one thing
   rather than three — a full-height gradient column with a chevron in it,
   which IS the fade and IS the button. It appears on a side exactly when that
   side still has content cut off, measured, not earned by a first swipe: an
   overflowing row says so immediately, because a reader who cannot see there
   is more has no reason to look for it.

   The line does not snap. Touch pans it through native scroll, and a mouse
   drags it with the pointer — pull it anywhere and it stays there. Chips size
   to their text; a prompt is never truncated, it is dragged to. A tap fills
   the composer with the prompt, the way a history recall does: replaced,
   unsent, editable, caret at the end — so a drag that travelled must swallow
   its own trailing click. */
import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { useCoarsePointer } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

/** Which sides still have content cut off. Measured on scroll and on resize (a
    window break or a theme font swap can change the width a sentence needs). */
function useOverflow(track: HTMLDivElement | null): { left: boolean; right: boolean } {
  const [state, setState] = React.useState({ left: false, right: false })
  React.useLayoutEffect(() => {
    if (!track) return
    const measure = () =>
      setState({
        left: track.scrollLeft > 4,
        right: track.scrollLeft < track.scrollWidth - track.clientWidth - 4,
      })
    measure()
    track.addEventListener("scroll", measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    return () => {
      track.removeEventListener("scroll", measure)
      ro.disconnect()
    }
  }, [track])
  return state
}

export function PromptSuggestions({
  suggestions,
  onPick,
  className,
}: {
  suggestions: readonly string[]
  /** Fill the composer with the picked prompt. Replaces, like a history recall. */
  onPick: (prompt: string) => void
  className?: string
}) {
  const coarse = useCoarsePointer()
  const [track, setTrack] = React.useState<HTMLDivElement | null>(null)
  const { left: canLeft, right: canRight } = useOverflow(track)

  // Free dragging with the pointer. On release we keep `moved` set until the
  // click that trails it is swallowed, so a true tap (no travel) still fills
  // the composer while a drag does not.
  const drag = React.useRef({ active: false, moved: false, startX: 0, startLeft: 0 })
  const dragging = drag.current

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return
    if (!track) return
    dragging.active = true
    dragging.moved = false
    dragging.startX = e.clientX
    dragging.startLeft = track.scrollLeft
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.active || !track) return
    const dx = e.clientX - dragging.startX
    if (!dragging.moved && Math.abs(dx) > 4) dragging.moved = true
    if (dragging.moved) track.scrollLeft = dragging.startLeft - dx
  }
  const endDrag = () => {
    dragging.active = false
  }

  if (suggestions.length === 0) return null

  const nudge = (dir: 1 | -1) =>
    track?.scrollBy({ left: dir * track.clientWidth * 0.8, behavior: "smooth" })

  /* The edge affordance: a full-height gradient column that is the fade and
     the button at once. `pointer-events-none` while hidden keeps it from
     stealing a tap meant for the chip underneath. */
  const edge = cn(
    "absolute inset-y-0 z-10 flex w-8 items-center justify-center",
    "transition-opacity duration-200 ease-out"
  )

  return (
    <div
      data-slot="prompt-suggestions"
      className={cn(
        "relative -mx-1 mt-0.5 mb-1.5 w-full min-w-0 animate-in px-1 fade-in-0 slide-in-from-bottom-1 duration-200 ease-out",
        className
      )}
    >
      <button
        type="button"
        onClick={() => nudge(-1)}
        title="Earlier suggestions"
        aria-label="Earlier suggestions"
        aria-hidden={!canLeft}
        className={cn(
          edge,
          "left-0 bg-gradient-to-r from-background via-background/95 to-transparent",
          canLeft ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <ChevronLeft className="size-4 text-muted-foreground" />
      </button>

      {/* The line: one chip plus a peek of the next. Free — it does not snap,
          and a pointer drag pans it. `overscroll-x-contain` keeps a sweep at
          the end of the row from dragging the transcript along. */}
      <div
        ref={setTrack}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        className="scrollbar-none min-w-0 cursor-grab touch-pan-x overflow-x-auto overscroll-x-contain select-none active:cursor-grabbing"
      >
        <div className="flex gap-2 py-0.5 whitespace-nowrap">
          {suggestions.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => {
                // A drag that travelled must not also fill the composer; this
                // check swallows the click that trails it, exactly once.
                if (dragging.moved) {
                  dragging.moved = false
                  return
                }
                onPick(prompt)
              }}
              title={`Ask: ${prompt}`}
              aria-label={`Ask: ${prompt}`}
              className={cn(
                "shrink-0 rounded-full text-sm font-medium transition-colors select-none",
                "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                /* Denser on a pointer, roomier under a thumb. */
                coarse ? "px-4 py-2" : "px-3 py-1.5"
              )}
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => nudge(1)}
        title="More suggestions"
        aria-label="More suggestions"
        aria-hidden={!canRight}
        className={cn(
          edge,
          "right-0 bg-gradient-to-l from-background via-background/95 to-transparent",
          canRight ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <ChevronRight className="size-4 text-muted-foreground" />
      </button>
    </div>
  )
}
