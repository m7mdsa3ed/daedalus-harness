/* ── A thread, mounted ──
   One of these per open thread tab: the transcript with its own connection, its
   own scope and its own jump, kept mounted and hidden while another tab is in
   front (the old dock did the same, and for the same reasons — scroll position,
   a half-written message, a preview's page). `useThreadConnection` is called
   here for every mounted thread, so a background tab keeps streaming.

   Only the one in front does what the shell used to do *for* a thread tab on
   arrival, keyed on the id: redirect a legacy `?session=` link, switch to the
   thread's space, mint a draft for an id nobody has heard of (an unsent draft
   after a reload, a purged thread). */
import * as React from "react"
import { useLocation, useNavigate } from "react-router"

import { ScopeBoundary } from "@/components/right-panel/scope-dock"
import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadSkeleton } from "@/components/thread-view/skeleton"
import { ThreadView } from "@/components/thread-view/thread-view"
import type { Actions } from "@/lib/actions"
import { InspectorContext, ThreadJumpContext } from "@/lib/inspector"
import { useActiveSpace, useProjects } from "@/lib/queries/catalog"
import { openSection, threadScope, type RightSection } from "@/lib/right-panel"
import { threadPath } from "@/lib/router"
import { useSessionMeta } from "@/lib/store"
import { jumpRefFor } from "@/lib/thread-jump"
import { useThreadConnection } from "@/lib/thread/use-thread-connection"
import { cn } from "@/lib/utils"
import { ThreadLinksProvider } from "@/lib/workspace/thread-links"
import { useThreadLinksFor } from "@/lib/workspace/use-thread-links"

export function ThreadPane({
  sessionId,
  active,
  actions,
  ready,
  openDraft,
}: {
  sessionId: string
  /** The thread in front. */
  active: boolean
  actions: Actions
  /** A project and a profile exist, so an unknown id can be given a draft. */
  ready: boolean
  openDraft: (opts: { id: string }) => string | null
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const meta = useSessionMeta(sessionId)
  const projects = useProjects()
  const { id: activeSpaceId, setActive: setActiveSpace } = useActiveSpace()

  /* Hold the thread open while this pane is mounted. */
  useThreadConnection(sessionId)
  const links = useThreadLinksFor(sessionId)

  const scope = threadScope(sessionId)
  const openReading = React.useCallback((tab: RightSection) => openSection(scope, tab), [scope])
  const jumpRef = React.useMemo(() => jumpRefFor(sessionId), [sessionId])

  /* Flips once, when the spaces list first answers — a dependency so a cold
     load at another space's thread is re-asked then, and never the space's own
     id, or the switch below would bounce off the URL it is about to replace. */
  const spacesKnown = activeSpaceId !== null
  const known = !!meta
  React.useEffect(() => {
    if (!active) return
    if (location.search) void navigate(threadPath(sessionId), { replace: true }) // legacy ?session=
    const owner = projects.find((project) => project.id === meta?.projectId)?.spaceId
    if (known && owner && activeSpaceId && owner !== activeSpaceId) {
      setActiveSpace(owner)
      return
    }
    /* A route for a thread nobody knows about. Gated on `ready` so this cannot
       fire before bootstrap has filled the session list in. */
    if (!known && ready) openDraft({ id: sessionId })
    // `navigate`, `location.search`, `projects` and the space are read, not
    // depended on: the redirect above clears the search, and re-running on it
    // would open the same draft twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, known, ready, spacesKnown])

  return (
    <div className={cn("absolute inset-0 flex min-h-0 min-w-0 flex-col bg-background", !active && "hidden")}>
      {!meta ? (
        <div className="flex h-full min-h-0 flex-col pt-[var(--app-header-h)]">
          <div className="mx-auto w-full max-w-[var(--harness-chat-width)] px-4 py-4">
            <ThreadSkeleton />
          </div>
        </div>
      ) : (
        <ScopeBoundary scope={scope} sessionId={sessionId} projectId={meta.projectId}>
          <InspectorContext.Provider value={openReading}>
            <ThreadJumpContext.Provider value={jumpRef}>
              <ErrorBoundary name="this thread" resetKeys={[meta.id]}>
                <ThreadLinksProvider value={links}>
                  <ThreadView key={meta.id} sessionId={meta.id} actions={actions} docked />
                </ThreadLinksProvider>
              </ErrorBoundary>
            </ThreadJumpContext.Provider>
          </InspectorContext.Provider>
        </ScopeBoundary>
      )}
    </div>
  )
}
