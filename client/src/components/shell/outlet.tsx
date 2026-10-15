/* ── The centre pane ──
   A thread tab is a mounted transcript (`ThreadPane`), one per open thread, with
   only the one in front visible; every other route renders here, in the app's
   one route table, against the real location. An error in a page is caught and
   resets on navigation rather than taking the shell down, and a page change
   re-keys its wrapper so the entrance runs.

   On a phone only the thread in front stays mounted (a drawer and a full-screen
   thread, no tabs); on a desktop the last few threads you were in are kept so
   switching back is instant and a half-written message survives. */
import * as React from "react"
import { Route, Routes, useLocation } from "react-router"

import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadPane } from "@/components/shell/thread-route"
import { useIsMobile } from "@/hooks/use-device"
import type { Actions } from "@/lib/actions"
import { routedThreadId } from "@/lib/router"
import { pageKey, syncTab, useTabs } from "@/lib/workspace/tabs"

/** How many open threads stay mounted on a desktop. */
const KEEP_THREADS = 6

function useKeptThreads(activeId: string | null, openIds: readonly string[], limit: number): string[] {
  const [kept, setKept] = React.useState<string[]>(activeId ? [activeId] : [])
  React.useEffect(() => {
    if (!activeId) return
    setKept((current) => [...current.filter((id) => id !== activeId), activeId].slice(-limit))
  }, [activeId, limit])
  const open = new Set(openIds)
  const live = kept.filter((id) => open.has(id) || id === activeId)
  return activeId && !live.includes(activeId) ? [...live, activeId] : live
}

export function ShellOutlet({
  routes,
  headingFor,
  actions,
  ready,
  openDraft,
}: {
  routes: React.ReactNode
  headingFor: (path: string) => { crumb?: string; title: string } | null
  actions: Actions
  ready: boolean
  openDraft: (opts: { id: string }) => string | null
}) {
  const location = useLocation()
  const isMobile = useIsMobile()
  const tabs = useTabs()
  const activeId = routedThreadId(location.pathname, location.search)

  /* The address bar is the source of truth; the tab store follows it. */
  React.useEffect(() => {
    syncTab(location.pathname, location.search)
  }, [location.pathname, location.search])

  const openIds = React.useMemo(() => tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : [])), [tabs])
  const mounted = useKeptThreads(activeId, openIds, isMobile ? 1 : KEEP_THREADS)
  const heading = headingFor(location.pathname + location.search)

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {mounted.map((id) => (
        <ThreadPane
          key={id}
          sessionId={id}
          active={id === activeId}
          actions={actions}
          ready={ready}
          openDraft={openDraft}
        />
      ))}
      {!activeId && (
        <ErrorBoundary name="this page" resetKeys={[location.pathname]}>
          <div
            key={pageKey(location.pathname)}
            className="harness-item-in relative flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {heading && <h1 className="sr-only">{heading.title}</h1>}
            <Routes>
              <Route path="/t/:sessionId" element={null} />
              {routes}
            </Routes>
          </div>
        </ErrorBoundary>
      )}
    </div>
  )
}
