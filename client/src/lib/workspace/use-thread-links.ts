/* The transcript's links, built once and shared.
   `ChatPanel` is no longer the only thing that renders a transcript — the
   agents panel draws the same subagent rails, with the same file chips and the
   same sources in them — so the openers live here rather than inside the panel
   that happened to need them first. Two copies would be two answers to "which
   panel does a file open in".

   Null when the thread has no project: without a cwd there is nothing to make
   an agent's absolute path relative to, and `ThreadLinksProvider` renders plain
   text for null, which is the honest fallback. */
import * as React from "react"

import { useSessionMeta } from "@/lib/store"
import type { ThreadLinks } from "@/lib/workspace/thread-links"

/** Open a URL in the external browser. Uses the Electron shell when available,
    falls back to `window.open`. */
function openInBrowser(url: string): void {
  window.open(url, "_blank", "noopener")
}

export function useThreadLinksFor(sessionId: string): ThreadLinks | null {
  const meta = useSessionMeta(sessionId)
  // Before the early return: meta arrives after the first render, and a hook
  // behind it would change the hook count between renders.
  const links = React.useMemo(() => ({ openUrl: (url: string) => openInBrowser(url) }), [])
  return meta?.projectId ? links : null
}
