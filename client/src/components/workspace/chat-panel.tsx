import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"

import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadView } from "@/components/thread-view"
import type { Actions } from "@/lib/actions"
import { useSessionMeta, useThread } from "@/lib/store"
import { markFor, type ThreadActivity } from "@/lib/thread/phase"
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
      !!(thread.permission || thread.elicitation),
      !!meta?.lastTurnError
    )
  ]
  usePublishPanelStatus(api.id, status)

  React.useEffect(() => {
    api.setTitle(meta?.title || "Thread")
  }, [api, meta?.title])

  /* What makes a path or a source in a tool call clickable — shared with every
     other surface that renders a transcript (see lib/workspace/use-thread-links). */
  const links = useThreadLinksFor(params.sessionId)

  if (!meta) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ErrorBoundary name="this thread" resetKeys={[meta.id]}>
        <ThreadLinksProvider value={links}>
          <ThreadView key={meta.id} sessionId={meta.id} actions={actions} />
        </ThreadLinksProvider>
      </ErrorBoundary>
    </div>
  )
}
