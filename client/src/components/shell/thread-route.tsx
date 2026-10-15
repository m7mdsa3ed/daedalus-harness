/* ── A thread, as a page ──
   `/t/:sessionId` renders the transcript directly in the centre pane. This is
   what a chat tab was: the one place `useThreadConnection` is called for the
   routed thread, so the connection is held open for as long as you are here and
   released when you leave (the registry keeps the socket warm for a while, and
   a turn keeps running either way — it is the server's).

   Everything the shell used to do *for* a thread tab on arrival lives here now,
   keyed on the id: a legacy `?session=` link is redirected to the path, a
   thread from another space switches to its space, and an id nobody has heard
   of (an unsent draft after a reload, a purged thread) gets an empty draft on
   that id rather than a dead end. */
import * as React from "react"
import { useLocation, useNavigate, useParams } from "react-router"

import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadSkeleton } from "@/components/thread-view/skeleton"
import { ThreadView } from "@/components/thread-view/thread-view"
import type { Actions } from "@/lib/actions"
import { useActiveSpace, useProjects } from "@/lib/queries/catalog"
import { threadPath } from "@/lib/router"
import { useSessionMeta } from "@/lib/store"
import { useThreadConnection } from "@/lib/thread/use-thread-connection"
import { recordVisit } from "@/lib/workspace/open-threads"
import { ThreadLinksProvider } from "@/lib/workspace/thread-links"
import { useThreadLinksFor } from "@/lib/workspace/use-thread-links"

export function ThreadRoute({
  actions,
  ready,
  openDraft,
}: {
  actions: Actions
  /** A project and a profile exist, so an unknown id can be given a draft. */
  ready: boolean
  openDraft: (opts: { id: string }) => string | null
}) {
  const { sessionId = "" } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const meta = useSessionMeta(sessionId)
  const projects = useProjects()
  const { id: activeSpaceId, setActive: setActiveSpace } = useActiveSpace()

  /* Hold the thread open while this route is mounted. */
  useThreadConnection(sessionId)
  const links = useThreadLinksFor(sessionId)

  React.useEffect(() => recordVisit(sessionId), [sessionId])

  /* Flips once, when the spaces list first answers — a dependency so a cold
     load at another space's thread is re-asked then, and never the space's own
     id, or the switch below would bounce off the URL it is about to replace. */
  const spacesKnown = activeSpaceId !== null
  const known = !!meta
  React.useEffect(() => {
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
  }, [sessionId, known, ready, spacesKnown])

  if (!meta)
    return (
      <div className="flex h-full min-h-0 flex-col pt-[var(--app-header-h)]">
        <div className="mx-auto w-full max-w-[var(--harness-chat-width)] px-4 py-4">
          <ThreadSkeleton />
        </div>
      </div>
    )

  return (
    <ErrorBoundary name="this thread" resetKeys={[meta.id]}>
      <ThreadLinksProvider value={links}>
        <ThreadView key={meta.id} sessionId={meta.id} actions={actions} docked />
      </ThreadLinksProvider>
    </ErrorBoundary>
  )
}
