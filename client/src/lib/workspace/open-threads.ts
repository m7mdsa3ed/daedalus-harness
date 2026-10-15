/* ── Which thread is in front, and which are open ──
   The route names the thread in front (`useActiveChat`), and the open threads
   are the thread tabs (`lib/workspace/tabs.ts`), in tab order. The sidebar keeps
   their rows loaded; nothing here is a store of its own. */
import { useLocation } from "react-router"

import { routedThreadId } from "@/lib/router"
import { getTabs, useTabs } from "@/lib/workspace/tabs"

/** The thread ids with a tab open, in tab order. */
export function useOpenThreads(): readonly string[] {
  const tabs = useTabs()
  return tabs.flatMap((tab) => (tab.sessionId ? [tab.sessionId] : []))
}

export function openThreadIds(): readonly string[] {
  return getTabs().flatMap((tab) => (tab.sessionId ? [tab.sessionId] : []))
}

/** The thread the address bar names; null on any other page. */
export function useActiveChat(): string | null {
  const location = useLocation()
  return routedThreadId(location.pathname, location.search)
}
