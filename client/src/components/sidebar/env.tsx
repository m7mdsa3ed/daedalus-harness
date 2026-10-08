/* ── What every list in the sidebar shares ── provided once by ThreadSidebar so
   the folders and lists do not pass it down by hand. The value is memoized by
   the provider: a streamed token leaves it untouched. */
import * as React from "react"
import type { Actions } from "@/lib/actions"
import type { SessionMeta } from "@/lib/settings"
import type { ThreadStatus } from "./thread-row"

export interface SidebarEnv {
  actions: Actions
  status: (session: SessionMeta) => ThreadStatus
  pinSet: ReadonlySet<string>
  /** Threads held at a failure, and threads that finished since this device last looked. */
  held: ReadonlySet<string>
  unread: ReadonlySet<string>
  /** Project id -> name; a missing id reads "Other". */
  projectNames: ReadonlyMap<string, string>
}

export const SidebarEnvContext = React.createContext<SidebarEnv | null>(null)

export function useSidebarEnv(): SidebarEnv {
  const env = React.useContext(SidebarEnvContext)
  if (!env) throw new Error("useSidebarEnv outside ThreadSidebar")
  return env
}
