/* ── The desktop shell's half of the renderer ──
   Everything `electron/main.cjs` asks of the page, and everything the page
   tells it, in one hook the shell mounts once (`useDesktopBridge`). A browser
   has no `window.desktop`, so every piece is a no-op there.

   - **Menu, tray and quick entry name a shortcut, never an action.** Main sends
     a ShortcutId and this runs whatever that chord is bound to
     (`runShortcut`), so View › New Thread, the tray's New thread and the global
     hotkey are the ⌘N handler and nothing else.
   - **The tray reads the same statuses the sidebar draws** (`useThreadStatuses`),
     summarised and throttled — a status word changes a handful of times per
     turn, but a burst of threads settling should not be a burst of IPC.
   - **The quick-entry accelerator is device-local** and re-sent on every boot,
     because main registers nothing on its own. */
import * as React from "react"

import { runShortcut } from "@/hooks/use-hotkey"
import { createLocalStore } from "@/lib/local-store"
import { SHORTCUTS, type ShortcutId } from "@/lib/shortcuts"
import { useStoreSelect } from "@/lib/store"
import { useThreadStatuses } from "@/lib/thread/statuses"

const desktop = typeof window !== "undefined" ? window.desktop : undefined
const SHORTCUT_IDS = new Set<string>(SHORTCUTS.map((entry) => entry.id))

/* ── Quick entry ──
   An Electron accelerator ("Alt+Space", "CommandOrControl+Shift+N"), not one of
   the app's chords: it is registered with the OS, outside any page. "" is off. */
export const QUICK_ENTRY_DEFAULT = "Alt+Space"
const quickEntryStore = createLocalStore<string>(
  "desktop.quickEntry",
  (raw) => (typeof raw === "string" ? raw : QUICK_ENTRY_DEFAULT),
  QUICK_ENTRY_DEFAULT
)
/** Why the stored accelerator is not live, if it is not — main's answer. */
const quickEntryError = createLocalStore<string>("desktop.quickEntryError", (raw) => (typeof raw === "string" ? raw : ""), "")

async function registerQuickEntry(accelerator: string): Promise<string> {
  const result = await desktop?.setQuickEntry?.(accelerator)
  const error = result && !result.ok ? result.error : ""
  quickEntryError.set(error)
  return error
}

export function useQuickEntry(): {
  accelerator: string
  error: string
  /** Store and register; resolves to the error main reported, or "". */
  set: (accelerator: string) => Promise<string>
} {
  return {
    accelerator: quickEntryStore.use(),
    error: quickEntryError.use(),
    set: React.useCallback((next: string) => {
      quickEntryStore.set(next.trim())
      return registerQuickEntry(next.trim())
    }, []),
  }
}

const ACTIVITY_THROTTLE_MS = 1_000

/** Mount once, in the main window's shell. */
export function useDesktopBridge(): void {
  React.useEffect(() => {
    if (!desktop) return
    void registerQuickEntry(quickEntryStore.get())
    return desktop.onShortcut?.((id) => {
      if (SHORTCUT_IDS.has(id)) runShortcut(id as ShortcutId)
    })
  }, [])

  const statuses = useThreadStatuses()
  const sessions = useStoreSelect((state) => state.sessions)
  const timer = React.useRef<number | null>(null)
  const latest = React.useRef<DesktopActivity | null>(null)
  React.useEffect(() => {
    if (!desktop?.setActivity) return
    const items: DesktopActivity["items"] = []
    for (const session of sessions) {
      const status = statuses.get(session.id)
      if ((status === "running" || status === "waiting") && !session.deletedAt) {
        items.push({ id: session.id, title: session.title, state: status })
      }
    }
    latest.current = {
      running: items.filter((item) => item.state === "running").length,
      waiting: items.filter((item) => item.state === "waiting").length,
      items,
    }
    // Trailing throttle: the first change goes out within a second, and
    // everything that lands meanwhile rides with it.
    if (timer.current !== null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      if (latest.current) desktop.setActivity?.(latest.current)
    }, ACTIVITY_THROTTLE_MS)
  }, [statuses, sessions])
  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
    },
    []
  )
}
