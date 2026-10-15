/* ── A thread's transcript, inside its dock tab ──
   What `ThreadDock` was, less the nested dockview: the transcript with the scope
   the right panel reads (this thread's), the door "Open in inspector" knocks on,
   and the ref the readings scroll the transcript through. The thread's tools —
   readings, shell, preview — are the right panel's, not panes of this tab. */
import * as React from "react"

import { ScopeBoundary } from "@/components/right-panel/scope-dock"
import { ThreadView } from "@/components/thread-view/thread-view"
import type { Actions } from "@/lib/actions"
import { InspectorContext, ThreadJumpContext } from "@/lib/inspector"
import { openSection, threadScope, type RightSection } from "@/lib/right-panel"
import { jumpRefFor } from "@/lib/thread-jump"

export function ThreadBody({
  sessionId,
  projectId,
  actions,
}: {
  sessionId: string
  projectId: string
  actions: Actions
}) {
  const scope = threadScope(sessionId)
  const openReading = React.useCallback((tab: RightSection) => openSection(scope, tab), [scope])
  const jumpRef = React.useMemo(() => jumpRefFor(sessionId), [sessionId])
  return (
    <ScopeBoundary scope={scope} sessionId={sessionId} projectId={projectId}>
      <InspectorContext.Provider value={openReading}>
        <ThreadJumpContext.Provider value={jumpRef}>
          <ThreadView sessionId={sessionId} actions={actions} docked />
        </ThreadJumpContext.Provider>
      </InspectorContext.Provider>
    </ScopeBoundary>
  )
}
