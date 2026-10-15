/* ── The centre pane ──
   Every route renders here, in the app's one route table, against the real
   location: a thread, a settings page, a project, the board. It replaces the
   page panels the dock kept one per tab. A route change re-keys the wrapper so
   the entrance animation runs, and an error in a page is caught here and
   resets on navigation rather than taking the shell down. */
import * as React from "react"
import { Route, Routes, useLocation } from "react-router"

import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadRoute } from "@/components/shell/thread-route"
import type { Actions } from "@/lib/actions"

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
  const heading = headingFor(location.pathname + location.search)
  /* One key per *place*, not per URL: a search param or a settings subsection
     change must not replay the entrance. */
  const key = location.pathname.startsWith("/settings") ? "/settings" : location.pathname.split(/[?#]/)[0]
  return (
    <ErrorBoundary name="this page" resetKeys={[location.pathname]}>
      <div
        key={key}
        className="harness-item-in relative flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        {heading && <h1 className="sr-only">{heading.title}</h1>}
        <Routes>
          <Route
            path="/t/:sessionId"
            element={<ThreadRoute actions={actions} ready={ready} openDraft={openDraft} />}
          />
          {routes}
        </Routes>
      </div>
    </ErrorBoundary>
  )
}
