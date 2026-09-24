/* ── One thread, full-window, no shell (desktop "Open in its own window") ──
   What `App.tsx` renders instead of `AppShell` when `IS_POPOUT` is set: the
   transcript and its composer, and none of the sidebar, header or dock — so
   nothing here can save a layout or mint a draft over the main window's
   (lib/popout.ts). The same pieces `ChatPanel` composes, minus the tab. */
import * as React from "react"

import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadView } from "@/components/thread-view/thread-view"
import { ThreadSkeleton } from "@/components/thread-view/skeleton"
import type { Actions } from "@/lib/actions"
import { currentThreadId } from "@/lib/router"
import { useSessionMeta } from "@/lib/store"
import { useThreadConnection } from "@/lib/thread/use-thread-connection"
import { ThreadLinksProvider } from "@/lib/workspace/thread-links"
import { useThreadLinksFor } from "@/lib/workspace/use-thread-links"

// The window is opened on one thread and stays on it, whatever the route does.
const SESSION_ID = typeof window !== "undefined" ? currentThreadId(window.location.pathname, "") ?? "" : ""

export function PopoutThread({ actions }: { actions: Actions }) {
  const meta = useSessionMeta(SESSION_ID)
  useThreadConnection(SESSION_ID)
  const links = useThreadLinksFor(SESSION_ID)

  React.useEffect(() => {
    document.title = meta?.title ? `${meta.title} — Daedalus` : "Daedalus"
  }, [meta?.title])

  return (
    <div
      className="@container flex h-dvh min-h-0 flex-col bg-background"
      // Framed window: nothing overlaps the transcript's top edge.
      style={{ "--dock-content-overlap": "0px" } as React.CSSProperties}
    >
      {meta ? (
        <ErrorBoundary name="this thread" resetKeys={[meta.id]}>
          <ThreadLinksProvider value={links}>
            <ThreadView key={meta.id} sessionId={meta.id} actions={actions} />
          </ThreadLinksProvider>
        </ErrorBoundary>
      ) : (
        <div className="mx-auto w-full max-w-[var(--harness-chat-width)] px-4 py-4">
          <ThreadSkeleton />
        </div>
      )}
    </div>
  )
}
