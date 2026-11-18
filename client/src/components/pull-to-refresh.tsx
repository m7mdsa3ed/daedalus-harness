/* ── Pull-to-refresh, the app's own ──
   The browser's gesture is switched off on purpose (`overscroll-behavior: none`
   on html/body, index.css): Android Chrome turned it into a page reload, under a
   running turn. This puts the gesture back with an answer that reloads nothing.

   The gesture is `hooks/use-pull-to-refresh.ts`; this is its face, and it is
   generic: any surface mounts one with its own `onRefresh`, its own `scope`
   (omitted: the whole document) and its own finger count, and any mark can be
   the indicator — `indicator` takes the reading and draws what it likes.
   The shell mounts the document-wide one-finger pull (`actions.refreshAll`)
   and the transcript a two-finger one scoped to itself (`refreshThread`).

   The indicator is portalled to the body and placed in viewport px from the
   frame the hook measures — the visible top of the box being pulled, below the
   status bar and the header's tab band in an edge-to-edge PWA — so no
   transform or `overflow` on the way up can clip or carry it. */
import * as React from "react"
import { createPortal } from "react-dom"
import { Logo } from "@/components/ui/logo"
import { usePullToRefresh, PULL_REST, PULL_SETTLE_MS, type PullView } from "@/hooks/use-pull-to-refresh"
import { describeError } from "@/lib/errors"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

/** What an indicator is told: the gesture's reading, minus where it is drawn
    (the frame is this component's to apply). */
export type PullIndicatorState = Omit<PullView, "frame">
export type PullIndicator = (state: PullIndicatorState) => React.ReactNode

/** The indicator box, square, px. Every mark is drawn inside it. */
const SIZE = 24

export function PullToRefresh({
  onRefresh,
  scope,
  fingers = 1,
  enabled = true,
  indicator = LogoRefreshIndicator,
  label = "Refreshing",
}: {
  onRefresh: () => Promise<void>
  /** The box the gesture listens in and moves; omitted, the document. A null
      scope (a ref not mounted yet) listens nowhere. */
  scope?: HTMLElement | null
  fingers?: 1 | 2
  enabled?: boolean
  /** The mark drawn in the gap. Defaults to the Daedalus logo drawing itself;
      `ActivityIndicator` is the iOS spinner, and any image works through
      `imageIndicator(src)`. */
  indicator?: PullIndicator
  /** Spoken while refreshing. */
  label?: string
}) {
  const view = usePullToRefresh({
    onRefresh,
    onError: (error) => toast.error(describeError(error).title),
    scope,
    fingers,
    enabled,
  })
  const { frame, offset, refreshing, settling } = view
  if (!frame) return null
  /* Centred in the gap the pull has opened, until the gap is as tall as the
     control; past that it stays put and the box goes on without it. */
  const centre = Math.min(offset, PULL_REST) / 2

  return createPortal(
    <div
      role={refreshing ? "status" : undefined}
      aria-label={refreshing ? label : undefined}
      aria-hidden={!refreshing}
      className="pointer-events-none fixed z-50 flex justify-center"
      style={{ top: frame.top, left: frame.left, width: frame.width }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: SIZE,
          height: SIZE,
          transform: `translateY(${centre - SIZE / 2}px)`,
          opacity: offset > 0 || refreshing ? 1 : 0,
          transition: settling
            ? `transform ${PULL_SETTLE_MS}ms cubic-bezier(0.25, 1, 0.5, 1), opacity ${PULL_SETTLE_MS}ms`
            : undefined,
        }}
      >
        {indicator(view)}
      </div>
    </div>,
    document.body
  )
}

/** The Daedalus mark, drawn round as the pull goes and tracing on a loop while
    the refresh runs — the same `working` the activity line wears. */
export const LogoRefreshIndicator: PullIndicator = ({ progress, refreshing }) => (
  <Logo
    working={refreshing}
    progress={progress}
    className={cn("size-6", progress >= 1 || refreshing ? "text-primary" : "text-muted-foreground")}
  />
)

/** Any image as the mark — a custom logo URL or a `data:` URL (`logoFromFile`).
    It fades and turns in with the pull and spins while refreshing. */
export function imageIndicator(src: string, alt = ""): PullIndicator {
  return ({ progress, refreshing }) => (
    <img
      src={src}
      alt={alt}
      draggable={false}
      className={cn("size-6 rounded-md object-contain", refreshing && "motion-safe:animate-spin")}
      style={refreshing ? undefined : { opacity: progress, transform: `rotate(${progress * 270}deg)` }}
    />
  )
}

const TICKS = 8

/** UIActivityIndicatorView's eight ticks. While pulling they appear one by one
    with the pull's progress; refreshing, they step round with a fading tail. */
export const ActivityIndicator: PullIndicator = ({ progress, refreshing }) => {
  const shown = refreshing ? TICKS : Math.floor(progress * TICKS)
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      className={cn("text-muted-foreground", refreshing && "motion-safe:animate-[spin_800ms_steps(8)_infinite]")}
    >
      {Array.from({ length: TICKS }, (_, i) => (
        <line
          key={i}
          x1="10"
          y1="2.5"
          x2="10"
          y2="6.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          transform={`rotate(${i * (360 / TICKS)} 10 10)`}
          opacity={i >= shown ? 0 : refreshing ? 1 - ((TICKS - 1 - i) / TICKS) * 0.8 : 1}
        />
      ))}
    </svg>
  )
}
