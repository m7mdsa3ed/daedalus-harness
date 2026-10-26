/* ── The thread inspector ──
   How the column beside a transcript is set on this device — whether it is
   open, how wide, which tab — and the door the composer's readings use to open
   it at a tab.

   Device-local and global, like `layout-options`: the inspector is a way of
   reading threads, not a fact about one, so opening it in one thread opens it
   in the next. The *sheet* a narrow panel shows instead is not stored at all —
   a restored overlay covering every transcript on a phone is a panel that
   looks broken — so it is `ThreadView`'s own state, reached through
   `InspectorContext`. */
import * as React from "react"

import { createLocalStore } from "@/lib/local-store"

export type InspectorTab = "changes" | "agents" | "details" | "trace"

const TABS: readonly InspectorTab[] = ["changes", "agents", "details", "trace"]

/** How the Agents reading is laid out: one of a workflow run's layouts over
    every agent in the thread. A stored "runs" (removed) falls back to List. */
export type AgentsView = "browse" | "board" | "list" | "timeline" | "flowchart"
const AGENTS_VIEWS: readonly AgentsView[] = ["browse", "board", "list", "timeline", "flowchart"]

export interface InspectorPrefs {
  /** Docked beside the transcript where the panel is wide enough. */
  open: boolean
  /** In px, clamped against the panel on every draw. */
  width: number
  tab: InspectorTab
  agentsView: AgentsView
}

export const INSPECTOR_MIN = 256
export const INSPECTOR_DEFAULT = 320
export const INSPECTOR_MAX = 640

const DEFAULTS: InspectorPrefs = { open: true, width: INSPECTOR_DEFAULT, tab: "changes", agentsView: "list" }

export const inspectorPrefs = createLocalStore<InspectorPrefs>(
  "daedalus.inspector.v1",
  (raw) => {
    if (!raw || typeof raw !== "object") return DEFAULTS
    const stored = raw as Partial<Record<keyof InspectorPrefs, unknown>>
    return {
      open: typeof stored.open === "boolean" ? stored.open : DEFAULTS.open,
      width:
        typeof stored.width === "number" && Number.isFinite(stored.width)
          ? Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, stored.width))
          : DEFAULTS.width,
      tab: TABS.includes(stored.tab as InspectorTab) ? (stored.tab as InspectorTab) : DEFAULTS.tab,
      agentsView: AGENTS_VIEWS.includes(stored.agentsView as AgentsView)
        ? (stored.agentsView as AgentsView)
        : DEFAULTS.agentsView,
    }
  },
  DEFAULTS
)

export function setInspectorPref<K extends keyof InspectorPrefs>(key: K, value: InspectorPrefs[K]): void {
  inspectorPrefs.set({ ...inspectorPrefs.get(), [key]: value })
}

/** Open the inspector of the thread this is rendered in, at a tab — docked
    where the panel is wide, as a sheet where it is not. Null outside a
    transcript (the landing console's composer), where a reading's "Open in
    inspector" row is simply not drawn. */
export const InspectorContext = React.createContext<((tab: InspectorTab) => void) | null>(null)

export function useOpenInspector(): ((tab: InspectorTab) => void) | null {
  return React.useContext(InspectorContext)
}

/** Where a thread dock's transcript panel publishes its scroll-to-row, so a
    reading in another panel (Agents) can jump it. Null outside a thread dock. */
export interface ThreadJumpTarget {
  turnId: string
  seq: number
}

export const ThreadJumpContext = React.createContext<
  React.MutableRefObject<((id?: string, turn?: ThreadJumpTarget) => void) | null> | null
>(null)
