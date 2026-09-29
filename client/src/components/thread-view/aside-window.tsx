/* ── Aside: a mini window over the transcript ──
   A passage selected in a thread, asked about in a thread of its own. The
   aside is an ordinary thread — a draft until its first send, then a row the
   sidebar lists (badged, `asideQuote`) and the header links back from
   (`forkedFromSessionId`). This is only where it is drawn while you are
   reading the parent: the same pieces `PopoutThread` composes, in a small
   floating box anchored where the passage was. "Open as tab" is the same
   thread, in the dock.

   Moved by its title bar (pointer capture), resized by the browser's own
   `resize: both` handle — the size is set once and then the element's, so a
   re-render never snaps it back. */
import * as React from "react"
import { createPortal } from "react-dom"
import { ExternalLinkIcon, MessageSquareTextIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadView } from "@/components/thread-view/thread-view"
import type { Actions } from "@/lib/actions"
import { navigateTo, threadPath } from "@/lib/router"
import { useSessionMeta, useStoreSelect } from "@/lib/store"
import { useThreadConnection } from "@/lib/thread/use-thread-connection"
import { ThreadLinksProvider } from "@/lib/workspace/thread-links"
import { useThreadLinksFor } from "@/lib/workspace/use-thread-links"

const WIDTH = 440
const HEIGHT = 540
const MARGIN = 8

export interface AsideAt {
  id: string
  /** Viewport point the window opens beside — the passage's rect. */
  x: number
  y: number
}

/** Clamp the box into the viewport, preferring below-right of the point. */
function place(x: number, y: number) {
  const w = Math.min(WIDTH, window.innerWidth - MARGIN * 2)
  const h = Math.min(HEIGHT, window.innerHeight - MARGIN * 2)
  const left = Math.max(MARGIN, Math.min(x - w / 2, window.innerWidth - w - MARGIN))
  const below = y + MARGIN
  const top = below + h <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, window.innerHeight - h - MARGIN)
  return { left, top, width: w, height: h }
}

export function AsideWindow({
  at,
  actions,
  onClose,
}: {
  at: AsideAt
  actions: Actions
  onClose: () => void
}) {
  const meta = useSessionMeta(at.id)
  useThreadConnection(at.id)
  const links = useThreadLinksFor(at.id)
  /* A draft that goes away (trashed, pruned) closes the window — but only once
     it has been seen: the window mounts in the same commit that minted the
     draft, and the store publishes to subscribers a layout effect later, so
     the first reading is "absent" for a row that is on its way. */
  const exists = useStoreSelect((state) => state.sessions.some((s) => s.id === at.id))
  const seen = React.useRef(false)
  React.useEffect(() => {
    if (exists) seen.current = true
    else if (seen.current) onClose()
  }, [exists, onClose])
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  /* Placed once, where it was opened; then it is wherever it was dragged. */
  const [box, setBox] = React.useState(() => place(at.x, at.y))
  const drag = React.useRef<{ dx: number; dy: number } | null>(null)
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return
    drag.current = { dx: event.clientX - box.left, dy: event.clientY - box.top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    // Keep the title bar on screen, so the window can always be grabbed back.
    const left = Math.min(Math.max(event.clientX - drag.current.dx, MARGIN - box.width + 80), window.innerWidth - 80)
    const top = Math.min(Math.max(event.clientY - drag.current.dy, MARGIN), window.innerHeight - 36)
    setBox((b) => ({ ...b, left, top }))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  if (!meta) return null
  return createPortal(
    <div
      role="dialog"
      aria-label={`Aside: ${meta.title}`}
      className="@container fixed z-50 flex min-h-60 min-w-72 max-h-[calc(100dvh-16px)] max-w-[calc(100vw-16px)] resize flex-col overflow-hidden rounded-xl border bg-background shadow-xl animate-in fade-in-0 zoom-in-95"
      style={{ ...box, "--dock-content-overlap": "0px" } as React.CSSProperties}
    >
      <div
        className="flex h-9 shrink-0 cursor-grab touch-none items-center gap-1.5 border-b px-2 text-xs select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <MessageSquareTextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {meta.draft ? "Aside" : meta.title}
        </span>
        {/* Sent or not: an unsent aside is a draft, and a draft's route opens
            as a tab like any new thread's — its typed text is the composer
            draft store's, keyed by id, so it comes along. */}
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          title="Open as tab"
          onClick={() => {
            onClose()
            navigateTo(threadPath(at.id))
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="size-6" title="Close" onClick={onClose}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ErrorBoundary name="this aside" resetKeys={[at.id]}>
          <ThreadLinksProvider value={links}>
            <ThreadView key={at.id} sessionId={at.id} actions={actions} pinComposer />
          </ThreadLinksProvider>
        </ErrorBoundary>
      </div>
    </div>,
    document.body
  )
}
