import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"

import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadView } from "@/components/thread-view"
import type { Actions } from "@/lib/actions"
import { useStore } from "@/lib/store"
import { ThreadLinksProvider } from "@/lib/workspace/thread-links"
import { useThreadLinksFor } from "@/lib/workspace/use-thread-links"

/** A thread, and the one panel kind that owns an ACP connection. Every other
    panel observes the store; this is where `openThread` is called, which is why
    two panels for one session must never exist (see `panelId`). */
export function ChatPanel({
  actions,
  api,
  params,
}: IDockviewPanelProps<{ sessionId: string }> & { actions: Actions }) {
  const { state } = useStore()
  const meta = state.sessions.find((session) => session.id === params.sessionId)
  const thread = state.threads[params.sessionId]

  React.useEffect(() => {
    if (!meta) return
    // openThread writes the failure into the thread itself, which is the panel
    // the user is already staring at — nothing more to do here.
    actions.openThread(meta).catch(() => {})
  }, [actions, meta])

  /* Tab status. A dock keeps every transcript mounted, so the tab strip is the
     only place a thread you are not looking at can say anything — and "waiting
     on you" is the one worth interrupting for, which is why it outranks
     "running" rather than being merged into it. */
  const marker = !thread
    ? ""
    : thread.permission || thread.elicitation
      ? "◆ "
      : thread.turnActive
        ? "◍ "
        : thread.status === "closed"
          ? "⚠ "
          : ""

  React.useEffect(() => {
    api.setTitle(`${marker}${meta?.title || "Thread"}`)
  }, [api, meta?.title, marker])

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
