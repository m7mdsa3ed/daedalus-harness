/* ── Where the Source Control panes sit ──
   The Git half is a dock of its own (`components/workspace/scm/scm-dock.tsx`):
   Locations, History, Files and Diff are panes you can hide, drag into one
   another's strip or split apart. This is the part with no component in it - the
   arrangement, kept per device (how a panel is cut is the reader's, not the
   repository's or the thread's), the same bargain `thread-docks.ts` makes per
   thread. */
import type { SerializedDockview } from "dockview-react"

import { createLocalStore } from "@/lib/local-store"

export type ScmPaneId = "locations" | "history" | "files" | "diff"

export const SCM_PANES: readonly { id: ScmPaneId; title: string }[] = [
  { id: "locations", title: "Locations" },
  { id: "history", title: "History" },
  { id: "files", title: "Files" },
  { id: "diff", title: "Diff" },
]

const store = createLocalStore<SerializedDockview | null>(
  "daedalus.scm.dock.v1",
  (raw) => (raw && typeof raw === "object" && "grid" in raw && "panels" in raw ? (raw as SerializedDockview) : null),
  null
)

export const savedScmLayout = (): SerializedDockview | null => store.get()
export const saveScmLayout = (layout: SerializedDockview | null) => store.set(layout)
