/* ── What a panel is doing, said on its tab ──
   A dock keeps every panel mounted, so the tab strip is the only place a panel
   you are *not* looking at can say anything. Chat had this already, and said it
   by prefixing a glyph onto its own title — which meant the reading was the
   title, so it could not be styled, could not be read by a screen reader as
   anything but a stray character, and no other kind could have one without
   inventing its own alphabet.

   So the reading is data, published by the panel and drawn by the tab. Held
   here rather than in the dock because the dock's state is the *arrangement*
   (and is serialized): a status is live, per-mount, and worthless across a
   reload. Keyed by panel id — the one name the panel and its tab share.

   A module store rather than context for the same reason `lib/ide/editors.ts`
   is one: a tab is rendered by Dockview outside the panel's own React tree, so
   there is no provider that could sit above both. */
import * as React from "react"

/** How loud the reading is. The tone decides the colour; the label is what a
    pointer and a screen reader get, so it says the whole thing ("Exited with
    code 1"), never just the tone's name. */
export type PanelTone =
  /** Working — a turn streaming, a page loading. */
  | "running"
  /** Waiting on the user. The one reading worth interrupting for. */
  | "attention"
  /** Something went wrong and is still wrong. */
  | "warn"
  /** Unsaved work. */
  | "dirty"

export interface PanelStatus {
  tone: PanelTone
  label: string
}

const statuses = new Map<string, PanelStatus>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function same(a: PanelStatus | undefined, b: PanelStatus | null): boolean {
  if (!a) return b === null
  return !!b && a.tone === b.tone && a.label === b.label
}

/** Publish, or clear with `null`. A no-op when the reading has not changed —
    a chat panel calls this on every token. */
export function setPanelStatus(panelId: string, status: PanelStatus | null): void {
  if (same(statuses.get(panelId), status)) return
  if (status) statuses.set(panelId, status)
  else statuses.delete(panelId)
  emit()
}

export function getPanelStatus(panelId: string): PanelStatus | null {
  return statuses.get(panelId) ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The reading for one panel, for its tab and for the group's tab list. */
export function usePanelStatus(panelId: string): PanelStatus | null {
  return React.useSyncExternalStore(
    subscribe,
    () => statuses.get(panelId) ?? null,
    () => null
  )
}

/**
 * Publish this panel's reading for as long as it is mounted, and take it back
 * when it is not.
 *
 * The cleanup is what stops a closed terminal's "Exited" from outliving it and
 * landing on whatever panel next takes that id.
 */
export function usePublishPanelStatus(panelId: string, status: PanelStatus | null): void {
  const tone = status?.tone
  const label = status?.label
  React.useEffect(() => {
    setPanelStatus(panelId, tone && label ? { tone, label } : null)
  }, [panelId, tone, label])
  React.useEffect(() => () => setPanelStatus(panelId, null), [panelId])
}
