/* ── Sidebar open state ──
   Whether the sidebar column is shown, remembered across reloads. Device-local
   and global, like the view options: how a person wants their workspace to look
   is a property of the reader and their screen, not of any one thread or any one
   account, so it persists in localStorage rather than on the server. */
import { useSyncExternalStore } from "react"

import { createLocalStore } from "./local-store"

export interface SidebarLayout {
  /** Shown or collapsed — the state the toggle flips, remembered so a reload
      comes back the way it was left. */
  open: boolean
  /** `sidebar` is a flush rail beside the content; `inset` floats the content as
      a rounded card on the shell's ground. Settings › Appearance. */
  variant: "sidebar" | "inset"
}

export const SIDEBAR_LAYOUT_DEFAULTS: SidebarLayout = {
  open: true,
  variant: "sidebar",
}

const STORAGE_KEY = "ui.sidebarLayout"

/** Keep only a value this build can mean — the stored blob is user-editable and
    outlives any one release. */
function pick(raw: unknown): Partial<SidebarLayout> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: Partial<SidebarLayout> = {}
  if (typeof source.open === "boolean") out.open = source.open
  if (source.variant === "sidebar" || source.variant === "inset") out.variant = source.variant
  return out
}

const store = createLocalStore<Partial<SidebarLayout>>(STORAGE_KEY, pick, {})

/* Memoised against the stored reference, so the object handed to
   useSyncExternalStore is referentially stable. */
let lastStored = store.get()
let resolved: SidebarLayout = { ...SIDEBAR_LAYOUT_DEFAULTS, ...lastStored }

function resolvedNow(): SidebarLayout {
  const stored = store.get()
  if (stored !== lastStored) {
    lastStored = stored
    resolved = { ...SIDEBAR_LAYOUT_DEFAULTS, ...stored }
  }
  return resolved
}

export function setSidebarLayout<K extends keyof SidebarLayout>(
  key: K,
  value: SidebarLayout[K]
): void {
  store.set({ ...store.get(), [key]: value })
}

export function useSidebarLayout(): SidebarLayout {
  return useSyncExternalStore(store.subscribe, resolvedNow, resolvedNow)
}
