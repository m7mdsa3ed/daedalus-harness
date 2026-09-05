/* ── Suggested follow-ups ──
   The model's closing `suggest-prompts` fence (`lib/suggestions`), drawn as a
   single simple line of pill chips under the very answer that offered them —
   the same footer slot where Sources and the token figure already read the
   turn. One line, and the line is the whole card: no header, no pager, no
   numbering.

   The row is a free surface, not a carousel: it does not snap. Touch pans it
   through native scroll, and a mouse drags it with the pointer — pull it
   anywhere and it stays there. Chips size to their text; a prompt is never
   truncated, it is dragged to. `toggle: drag` is set so a drag never fights
   the chips' tap-to-fill.

   The arrows are earned, not advertised. An arrow (and the soft fade at its
   edge, so a cut chip dissolves rather than being sliced) appears only once
   the reader has moved the line at all — before that, the trailing peek of
   the next chip is the only cue — and then only on the side that still has
   content: the start arrow while scrolled in, the end arrow while more is cut
   off. A tap fills the composer with the prompt, the way a history recall
   does: replaced, unsent, editable, caret at the end. */
import * as React from "react"
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react"

import { useCoarsePointer } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

/** The track's live position: how far in, and how far it can still go.
    Measured on scroll and on resize (a window break or a theme font swap can
    change the width a sentence needs). */
function useTrackPosition(
  track: HTMLDivElement | null
): { left: number; max: number; atStart: boolean; atEnd: boolean; hasSwiped: boolean } {
  const [state, setState] = React.useState({ left: 0, max: 0, hasSwiped: false })
  React.useLayoutEffect(() => {
    if (!track) return
    const measure = () =>
      setState((prev) => ({
        left: track.scrollLeft,
        max: Math.max(0, track.scrollWidth - track.clientWidth),
        // Any movement is a swipe: a pointer drag, a wheel, or an edge arrow.
        // The arrows are not shown before the first one.
        hasSwiped: prev.hasSwiped || track.scrollLeft > 0,
      }))
    measure()
    track.addEventListener("scroll", measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    return () => {
      track.removeEventListener("scroll", measure)
      ro.disconnect()
    }
  }, [track])
  return { ...state, atStart: state.left <= 0, atEnd: state.left >= state.max }
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
  const trackRef = React.useRef<HTMLDivElement>(null)
  const { atStart, atEnd, hasSwiped } = useTrackPosition(trackRef.current)
  /* Held-drag state, for chrome: idle the row sits quiet at reduced opacity
     with no background; a drag in flight lights it to full opacity over a
     soft pill, the same bargain the turn rail makes. State, not just the ref
     below, so the classes re-render with the gesture. */
  const [draggingUI, setDraggingUI] = React.useState(false)

  // Free dragging with the pointer. On release we reset the index so a true
  // tap (no travel) still fills the composer, while a drag swallows its own
  // implicit click.
  const drag = React.useRef({ active: false, moved: false, startX: 0, startLeft: 0 })
  const dragging = drag.current

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return
    const track = trackRef.current
    if (!track) return
    dragging.active = true
    dragging.moved = false
    dragging.startX = e.clientX
    dragging.startLeft = track.scrollLeft
    drag.current = dragging
    /* Light on press, like the turn rail: a hold is already a drag intent,
       even before the first 4px. A plain tap flashes it briefly — press
       feedback, not a bug. */
    setDraggingUI(true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.active) return
    const track = trackRef.current
    if (!track) return
    const dx = e.clientX - dragging.startX
    if (!dragging.moved && Math.abs(dx) > 4) {
      dragging.moved = true
      setDraggingUI(true)
    }
    if (dragging.moved) track.scrollLeft = dragging.startLeft - dx
  }
  const endDrag = () => {
    dragging.active = false
    setDraggingUI(false)
    // `moved` stays set until the click that trails a released drag swallows
    // it, so a travel that ends over a chip never fills the composer.
  }

  if (suggestions.length === 0) return null

  const nudge = (dir: 1 | -1) =>
    trackRef.current?.scrollBy({
      left: dir * Math.max(trackRef.current.clientWidth * 0.8, 240),
      behavior: "smooth",
    })

  const arrowBase = cn(
    "absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-border/70 bg-surface/90",
    "flex items-center justify-center shadow-sm backdrop-blur-xl transition-all duration-200 ease-out",
    "hover:border-primary/40 hover:bg-primary hover:text-primary-foreground hover:shadow-md",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
    coarse ? "size-7" : "size-6"
  )
  // Hidden until the reader has dragged once, and per side: only the side that
  // still has content shows. `pointer-events-none` keeps the hidden arrow from
  // stealing a tap meant for the chip underneath it.
  const arrowVisible = (side: "start" | "end") =>
    hasSwiped && (side === "start" ? !atStart : !atEnd)

  return (
    <div
      data-slot="prompt-suggestions"
      className={cn(
        "relative -mx-1 mb-1.5 mt-0.5 w-full animate-in rounded-xl px-1 py-1 fade-in-0 slide-in-from-bottom-1 duration-200 ease-out transition-[opacity,background-color]",
        /* Idle the row sits quiet — dimmed with no chrome. A held drag
           lights it to full opacity over a soft pill, the same bargain the
           turn rail makes. */
        draggingUI ? "bg-muted/50 opacity-100 shadow-sm" : "bg-transparent opacity-75 hover:opacity-100",
        className
      )}
    >
      {/* An arrow sits on each edge, over the soft fade; both fade in together
          once that direction has content to offer. */}
      <button
        type="button"
        onClick={() => nudge(-1)}
        title="Earlier suggestions"
        aria-label="Earlier suggestions"
        className={cn(
          arrowBase,
          coarse ? "left-1.5" : "left-1",
          !arrowVisible("start") && "pointer-events-none opacity-0"
        )}
      >
        <ArrowLeft className={coarse ? "size-3.5" : "size-3"} strokeWidth={2.5} />
      </button>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-background via-background/60 to-transparent transition-opacity duration-200 ease-out",
          !arrowVisible("start") && "opacity-0"
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-background via-background/60 to-transparent transition-opacity duration-200 ease-out",
          !arrowVisible("end") && "opacity-0"
        )}
      />

      {/* The line: one chip plus a peek of the next. Free — it does not snap,
          and a pointer drag pans it. `overscroll-x-contain` keeps a sweep at
          the end of the row from dragging the transcript along. */}
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        className={cn(
          "scrollbar-none flex min-w-0 cursor-grab touch-pan-x items-center overflow-x-auto overscroll-x-contain py-0.5 select-none active:cursor-grabbing",
          /* Denser on a pointer, roomier under a thumb. */
          coarse ? "gap-2" : "gap-1.5"
        )}
      >
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
              "group inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-surface/70 pr-3 text-[13px] leading-none text-foreground/85 shadow-xs backdrop-blur-xl backdrop-saturate-150 transition-all duration-150",
              "hover:border-primary/40 hover:bg-surface hover:text-foreground hover:shadow-sm",
              "active:scale-[0.98]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              coarse ? "py-2 pl-2.5" : "py-1.5 pl-2"
            )}
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground",
                coarse ? "size-5" : "size-4"
              )}
              aria-hidden
            >
              <ArrowUpRight className={coarse ? "size-3" : "size-2.5"} strokeWidth={2.5} />
            </span>
            <span className="whitespace-nowrap">{prompt}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => nudge(1)}
        title="More suggestions"
        aria-label="More suggestions"
        className={cn(
          arrowBase,
          coarse ? "right-1.5" : "right-1",
          !arrowVisible("end") && "pointer-events-none opacity-0"
        )}
      >
        <ArrowRight className={coarse ? "size-3.5" : "size-3"} strokeWidth={2.5} />
      </button>
    </div>
  )
}
