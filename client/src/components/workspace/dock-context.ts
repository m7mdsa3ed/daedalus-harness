/* ── The doors a panel knocks on ──
   Panels (the terminal, the preview, Source Control, the transcript's file
   links) were written to open and close things through `useDock()`. There is no
   dock any more — the right panel's scope provides this context instead
   (`right-panel/scope-dock.tsx`) and answers each door against its store, or the
   router. The interface is only what those callers use. */
import * as React from "react"

import type { PanelDescriptor } from "@/lib/workspace/panels"

/** Asked before a panel closes. `false` cancels the close. */
export type CloseGuard = () => boolean | Promise<boolean>

export interface WorkspaceDock {
  /** A terminal or a preview lands in the right panel; a chat, a page or the
      board is a navigation. */
  openPanel: (panel: PanelDescriptor) => void
  openChat: (sessionId: string) => void
  openPage: (path: string) => void
  closePanel: (id: string) => Promise<void>
  /** A panel's veto on its own closing — live terminals. */
  registerCloseGuard: (id: string, guard: CloseGuard) => () => void
  isPanelOpen: (id: string) => boolean
}

export const DockContext = React.createContext<WorkspaceDock | null>(null)

export function useDock(): WorkspaceDock {
  const dock = React.useContext(DockContext)
  if (!dock) throw new Error("useDock outside the right panel's scope")
  return dock
}
