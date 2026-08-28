import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"

import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadView } from "@/components/thread-view"
import type { Actions } from "@/lib/actions"
import { useStore } from "@/lib/store"
import { useDock } from "@/components/workspace/dock"
import { markReveal } from "@/lib/workspace/reveal"
import { ThreadLinksProvider, toRelative, type ThreadLinks } from "@/lib/workspace/thread-links"

/** A thread, and the one panel kind that owns an ACP connection. Every other
    panel observes the store; this is where `openThread` is called, which is why
    two panels for one session must never exist (see `panelId`). */
export function ChatPanel({
  actions,
  api,
  params,
}: IDockviewPanelProps<{ sessionId: string }> & { actions: Actions }) {
  const { state } = useStore()
  const dock = useDock()
  const meta = state.sessions.find((session) => session.id === params.sessionId)
  const thread = state.threads[params.sessionId]
  const project = state.projects.find((candidate) => candidate.id === meta?.projectId)

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

  /* What makes a path in a tool call clickable. The project's cwd is what turns
     the absolute paths agents report into the relative ones the file API takes;
     without a project there are no links and the transcript renders plain text. */
  const links = React.useMemo<ThreadLinks | null>(() => {
    if (!meta?.projectId) return null
    const projectId = meta.projectId
    const cwd = project?.cwd
    return {
      projectId,
      openFile: (path, line) => {
        const relative = toRelative(path, cwd)
        if (line) markReveal(projectId, relative, line)
        dock.openPanel({ kind: "editor", projectId, path: relative })
      },
      openDiff: (path) => {
        dock.openPanel({
          kind: "editor",
          projectId,
          path: toRelative(path, cwd),
          comparison: "head",
        })
      },
    }
  }, [dock, meta?.projectId, project?.cwd])

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
