import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"

import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadSkeleton } from "@/components/thread-view/skeleton"
import { useDock } from "@/components/workspace/dock-context"
import { ThreadDock } from "@/components/workspace/thread-dock"
import { useIsMobile } from "@/hooks/use-mobile"
import type { Actions } from "@/lib/actions"
import { useSessionMeta, useThread } from "@/lib/store"
import { markFor, type ThreadActivity } from "@/lib/thread/phase"
import { backgroundRunning } from "@/lib/thread/statuses"
import { cn } from "@/lib/utils"
import { usePublishPanelStatus, type PanelStatus } from "@/lib/workspace/panel-status"
import { useThreadConnection } from "@/lib/thread/use-thread-connection"
import { ThreadLinksProvider } from "@/lib/workspace/thread-links"
import { useThreadLinksFor } from "@/lib/workspace/use-thread-links"

/* What the tab says about a thread nobody is looking at.

   Every reading that is not `idle` gets one; the tone is what decides how loud
   it is drawn (`components/workspace/panel-status-dot`). `connecting` is the
   one deliberate absence: opening a thread is not news about it, and a mark
   that appears on every reattach is a mark nobody reads.

   This used to be a glyph prefixed onto the panel's own title, back when the
   title was the only channel a tab had. The label here is the whole sentence,
   because a status is now data and the tab has somewhere to put it. */
const TAB_STATUS: Record<ThreadActivity, PanelStatus | null> = {
  waiting: { tone: "attention", label: "Waiting on you" },
  failed: { tone: "warn", label: "The last turn failed" },
  running: { tone: "running", label: "Working" },
  reconnecting: { tone: "warn", label: "Reconnecting" },
  offline: { tone: "warn", label: "Offline" },
  stopped: { tone: "warn", label: "Stopped" },
  gone: { tone: "warn", label: "Deleted" },
  connecting: null,
  idle: null,
}

/* Which way the last swipe went and when, so the thread that becomes visible
   next can slide in from that side. Module-level: the outgoing and incoming
   panels are different instances. */
let lastSwipe = { dir: 0, at: 0 }
/** The tab strip's swipe says the same thing a composer swipe does. */
export function markSwipe(dir: number, dragged: boolean) {
  lastSwipe = { dir, at: dragged ? 0 : Date.now() }
}

/* A thread that can be dragged into view beside the one in front. Dockview
   draws every panel in an overlay of its own (`.dv-render-overlay`), hidden
   with `visibility` while its tab is not active, so showing the neighbour
   mid-drag is un-hiding that overlay and translating it — no reparenting, and
   dockview's own visibility state is untouched. `release` hands the overlay
   back to dockview. Terminals, previews and pages register nothing and get the
   name label instead. */
export interface Peek {
  el: () => HTMLElement | null
  place: (x: number) => void
  settle: (x: number, spring?: boolean) => void
  release: () => void
}
export const peeks = new Map<string, Peek>()

function makePeek(api: IDockviewPanelProps["api"], pane: React.RefObject<HTMLDivElement | null>): Peek {
  const el = () => pane.current?.closest<HTMLElement>(".dv-render-overlay") ?? null
  /* Show an inactive panel: its overlay, and the thread's own `hidden`. */
  const show = (o: HTMLElement) => {
    o.style.visibility = "visible"
    if (!api.isVisible) o.style.pointerEvents = "none"
    if (pane.current) pane.current.style.display = "flex"
  }
  return {
    el,
    place(x) {
      const o = el()
      if (!o) return
      show(o)
      o.style.transition = "none"
      o.style.transform = x ? `translateX(${x}px)` : ""
    },
    settle(x, spring) {
      const o = el()
      if (!o) return
      show(o)
      o.style.transition = spring
        ? "transform 280ms cubic-bezier(0.34,1.56,0.64,1)"
        : "transform 220ms ease-out"
      o.style.transform = `translateX(${x}px)`
      /* Dockview may hide the overlay a beat after the tab changes. */
      requestAnimationFrame(() => show(o))
    },
    release() {
      const o = el()
      if (!o) return
      o.style.transition = ""
      o.style.transform = ""
      o.style.visibility = api.isVisible ? "" : "hidden"
      o.style.pointerEvents = api.isVisible ? "" : "none"
      if (pane.current) pane.current.style.display = ""
    },
  }
}

const COMPOSER = '[data-slot="composer-strip"],[data-slot="composer-card"]'

/* Where a sideways drag is the content's own: a code block or table that
   scrolls, a field, a terminal. A drag starting in one never changes tab. */
function ownsHorizontalDrag(el: Element | null, root: Element) {
  /* Only called for a touch inside the composer, whose text fields keep no
     horizontal drag of their own on a phone (a selection in progress is
     checked apart). */
  for (; el && el !== root; el = el.parentElement) {
    if (el.matches("pre,table,.xterm")) return true
    if (el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX !== "visible")
      return true
  }
  return false
}

/** A thread, and the one panel kind that holds an ACP connection open. Every
    other panel observes the store; this is where `useThreadConnection` is
    called, which is why two panels for one session must never exist (see
    `panelId`). */
export function ChatPanel({
  actions,
  api,
  params,
}: IDockviewPanelProps<{ sessionId: string }> & { actions: Actions }) {
  /* This panel is mounted for every opened thread at once, so it reads its own
     session and its own thread and nothing wider — the tab marker below must
     not be recomputed because some other panel's turn streamed a token. An
     absent thread reads as `emptyThread`, which the marker already spells as
     no marker. */
  const meta = useSessionMeta(params.sessionId)
  const thread = useThread(params.sessionId)

  /* Hold the thread open for as long as this panel is mounted. Keyed on the id
     and on what can actually change the open decision — never on the row object,
     which `refreshSessions` replaces on every poll: that made a list refresh
     re-fire an open for every mounted transcript, and an open landing inside
     another open is two peers on one session. The connection records its own
     failures in the thread, which is the panel the user is already staring at. */
  useThreadConnection(params.sessionId)

  /* Tab status. A dock keeps every transcript mounted, so the tab strip is the
     only place a thread you are not looking at can say anything — and "waiting
     on you" is the one worth interrupting for, which is why it outranks
     "running" rather than being merged into it. */
  const status = TAB_STATUS[
    markFor(
      thread.phase,
      thread.turnActive,
      thread.permissions.length > 0 || thread.elicitations.length > 0,
      !!meta?.lastTurnError,
      thread.phase.kind === "live" && backgroundRunning(thread.items)
    )
  ]
  usePublishPanelStatus(api.id, status)

  /* Only ever *forward*: a session this client has not heard of yet is not a
     reason to rename its tab. The dock restores titles from its own layout
     (dockview serializes them) before the session list has loaded, so writing
     the placeholder unconditionally renamed every restored tab to "Thread" and
     only repaired it if the list arrived — a slow or failed bootstrap left the
     placeholder on screen for good. */
  React.useEffect(() => {
    if (meta?.title) api.setTitle(meta.title)
  }, [api, meta?.title])

  /* What makes a path or a source in a tool call clickable — shared with every
     other surface that renders a transcript (see lib/workspace/use-thread-links). */
  const links = useThreadLinksFor(params.sessionId)

  /* Phone: a sideways swipe that starts in the composer walks the group's tabs,
     as the tab chords do. Once the drag is judged horizontal (10px, 1.5x the
     vertical) the thread's overlay follows the finger and — where the
     neighbour is a thread — the neighbour is dragged in beside it, a pager. A
     terminal, preview or page neighbour is a name label at the edge instead.
     A drag that starts in something that scrolls sideways, or while text is
     selected, is never taken. Released past 72px, or flicked fast, it changes
     tab; short of it, everything springs back. Transforms are written straight
     to the nodes — a render per touchmove is the jank this exists to avoid. */
  const dock = useDock()
  const isMobile = useIsMobile()
  const pane = React.useRef<HTMLDivElement>(null)
  const peek = React.useRef<HTMLDivElement>(null)
  const settling = React.useRef<(() => void) | null>(null)
  const start = React.useRef<{
    x: number
    y: number
    own: boolean
    lock: boolean
    dir: number
    w: number
    nb?: Peek
    px: number
    pt: number
    v: number
  } | null>(null)
  React.useEffect(() => {
    peeks.set(api.id, makePeek(api, pane))
    return () => void peeks.delete(api.id)
  }, [api])
  /* The tab a swipe in `dir` would land on, in this panel's own strip. */
  const neighbour = (dir: number) => {
    const panels = api.group.panels
    const i = panels.findIndex((x) => x.id === api.id)
    return panels[(i + dir + panels.length) % panels.length]
  }
  /* x is the finger's travel, already clamped to the lock direction. */
  const hideLabel = () => {
    if (peek.current) peek.current.style.opacity = "0"
  }
  const drag = (x: number, nb?: Peek, dir = 0, w = 0) => {
    const me = peeks.get(api.id)
    me?.place(nb ? x : x * 0.6)
    nb?.place(x + dir * w)
    /* The label stands in for a neighbour that cannot be dragged in. */
    const tag = peek.current
    if (!tag) return
    const p = nb ? 0 : Math.min(1, Math.abs(x) / 36)
    tag.style.opacity = String(p)
    tag.style.transform = `translateX(${(x < 0 ? 1 : -1) * (1 - p) * 100}%)`
    tag.style.left = x < 0 ? "auto" : "0.5rem"
    tag.style.right = x < 0 ? "0.5rem" : "auto"
  }
  const swipe = isMobile
    ? {
        onTouchStart: (e: React.TouchEvent<HTMLDivElement>) => {
          settling.current?.()
          const t = e.touches[0]
          start.current =
            e.touches.length === 1
              ? {
                  x: t.clientX,
                  y: t.clientY,
                  own:
                    !(e.target as Element).closest(COMPOSER) ||
                    ownsHorizontalDrag(e.target as Element, e.currentTarget),
                  lock: false,
                  dir: 0,
                  w: 0,
                  px: t.clientX,
                  pt: e.timeStamp,
                  v: 0,
                }
              : null
        },
        onTouchMove: (e: React.TouchEvent<HTMLDivElement>) => {
          const s = start.current
          const t = e.touches[0]
          if (!s || s.own || !t) return
          const dx = t.clientX - s.x
          const dy = t.clientY - s.y
          if (!s.lock) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return
            if (Math.abs(dx) <= 1.5 * Math.abs(dy) || !window.getSelection()?.isCollapsed) {
              start.current = null
              return
            }
            s.lock = true
            s.dir = dx < 0 ? 1 : -1
            s.w = pane.current?.offsetWidth ?? 0
            const next = api.group.panels.length > 1 ? neighbour(s.dir) : null
            s.nb = (next && peeks.get(next.id)) || undefined
            if (peek.current) peek.current.textContent = next?.title ?? ""
            /* A panel nobody has looked at since a resize holds stale
               geometry: borrow ours, which is the strip's content box. */
            const mine = peeks.get(api.id)?.el()
            const theirs = s.nb?.el()
            if (mine && theirs)
              for (const k of ["left", "top", "width", "height"] as const)
                theirs.style[k] = mine.style[k]
          }
          /* Velocity over the last ~50ms (px/ms), re-based as it ages. */
          const dt = e.timeStamp - s.pt
          if (dt >= 50) {
            s.v = (t.clientX - s.px) / dt
            s.px = t.clientX
            s.pt = e.timeStamp
          }
          /* Dragging back past the start never reveals what is behind. */
          const x = -s.dir * Math.max(0, -s.dir * dx)
          drag(x, s.nb, s.dir, s.w)
        },
        onTouchCancel: () => {
          const s = start.current
          start.current = null
          if (!s?.lock) return
          back(s)
        },
        onTouchEnd: (e: React.TouchEvent<HTMLDivElement>) => {
          const s = start.current
          start.current = null
          const t = e.changedTouches[0]
          if (!s?.lock || !t) return
          const dx = t.clientX - s.x
          const dy = t.clientY - s.y
          /* Far enough, or a quick flick (>0.5px/ms in the drag's own direction)
             that has moved at least 24px. */
          const flick = Math.abs(dx) >= 24 && Math.abs(s.v) > 0.5 && s.v * dx > 0
          if (!((Math.abs(dx) >= 72 || flick) && Math.abs(dx) > 2 * Math.abs(dy)) || dx * s.dir > 0) {
            return back(s)
          }
          const me = peeks.get(api.id)
          /* A dragged-in neighbour is already on screen; only the unseen one
             slides in after the fact. */
          markSwipe(s.dir, !!s.nb)
          dock.cycleTab(s.dir)
          if (s.nb) {
            /* Dockview hides this overlay as the tab changes; hold it up
               while it slides out and the neighbour lands. */
            me?.settle(-s.dir * s.w)
            s.nb.settle(0)
            hold(me, s.nb, 240)
          } else {
            me?.release()
            hideLabel()
          }
        },
      }
    : undefined
  /* Springs everything home and then hands the overlays back to dockview. */
  function back(s: { dir: number; w: number; nb?: Peek }) {
    const me = peeks.get(api.id)
    me?.settle(0, true)
    s.nb?.settle(s.dir * s.w, true)
    hideLabel()
    hold(me, s.nb, 300)
  }
  function hold(a: Peek | undefined, b: Peek | undefined, ms: number) {
    const done = () => {
      clearTimeout(timer)
      settling.current = null
      a?.release()
      b?.release()
    }
    const timer = setTimeout(done, ms)
    settling.current = done
  }
  /* Hidden outright while this tab is not the one in front. Dockview hides an
     inactive panel with `visibility`, and the thread dock's own `always`
     overlays escape it — every thread drew over the others, so only the last
     one mounted showed. `display: none` has no inheritance to escape. */
  const [visible, setVisible] = React.useState(api.isVisible)
  const [slide, setSlide] = React.useState(0)
  React.useEffect(() => {
    setVisible(api.isVisible)
    const sub = api.onDidVisibilityChange((event) => {
      setVisible(event.isVisible)
      if (event.isVisible && Date.now() - lastSwipe.at < 500) setSlide(lastSwipe.dir)
    })
    return () => sub.dispose()
  }, [api])

  /* No row yet: the session list has not landed, so there is nothing to
     connect to and `ThreadView` cannot mount (every read below it is keyed by
     the row). That is the longest blank this panel ever shows — a cold boot
     waiting on the server — so it is the one that gets the stand-in. Once the
     row arrives the transcript's own gate takes over (`skeletonShown`). */
  if (!meta)
    return (
      <div className="flex h-full min-h-0 flex-col pt-[var(--dock-content-overlap,var(--app-header-h))]">
        <div className="mx-auto w-full max-w-[var(--harness-chat-width)] px-4 py-4">
          <ThreadSkeleton />
        </div>
      </div>
    )

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-x-clip">
      <div
        ref={peek}
        aria-hidden
        className="pointer-events-none absolute top-1/2 z-10 max-w-[60%] -translate-y-1/2 truncate rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background opacity-0 empty:hidden"
      />
      {/* Kept mounted and hidden with `display: none`, never unmounted. Dockview
          hides an inactive panel with `visibility`, which the thread dock's own
          `always` overlays escape — every thread drew over the others. `display:
          none` cannot be escaped, and it is what lets a Preview's page and a
          shell come back to what they were: unmounting this on every tab switch
          threw the `<webview>` (or iframe) away and rebuilt it on the way back,
          so a page you were reading reloaded and its state went. */}
      <div ref={pane} className={cn("flex h-full min-h-0 flex-col", !visible && "hidden")} {...swipe}
        style={slide ? ({ "--slide-from": `${slide * 48}px` } as React.CSSProperties) : undefined}
        data-slide={slide ? "" : undefined}
        onAnimationEnd={() => setSlide(0)}
      >
        <ErrorBoundary name="this thread" resetKeys={[meta.id]}>
          <ThreadLinksProvider value={links}>
            {/* The tab is a dock of the thread's own panels (`thread-dock.tsx`) —
                on a phone too, where it stacks them as tabs. */}
            <ThreadDock key={meta.id} sessionId={meta.id} actions={actions} />
          </ThreadLinksProvider>
        </ErrorBoundary>
      </div>
    </div>
  )
}
