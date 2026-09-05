/* ── How this device draws a terminal ──
   Type size, whether the helper key row is shown, and whether that row is one
   scrolling line or wrapped open.

   Device-local and never synced, for the same reason the custom keys beside it
   are (`terminal-keys.ts`): all three answer questions about the *machine in
   front of you* — a phone needs the key row and a 14px face, the same account
   on a desktop needs neither. Nothing here belongs to a project, a thread or a
   panel: two terminals side by side are read by one pair of eyes.

   `keyRow: "auto"` is the default and means "decide from the pointer" — a
   finger gets the row, a mouse does not. The two explicit values exist because
   the guess is wrong in both directions: a tablet with a keyboard case does not
   need it, and a desktop user who defined a custom escape sequence has no other
   way to press it. */
import { useSyncExternalStore } from "react"

const STORAGE_KEY = "ui.terminalPrefs"

export type KeyRowMode = "auto" | "on" | "off"

export interface TerminalPrefs {
  /** xterm's `fontSize`, in px. */
  fontSize: number
  keyRow: KeyRowMode
  /** The key row wrapped open, so every key is reachable without scrolling. */
  keysExpanded: boolean
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: 12,
  keyRow: "auto",
  keysExpanded: false,
}

/* Below 9px a terminal is unreadable and above 20 it fits nothing; the clamp is
   here rather than at the buttons so a hand-edited store cannot leave the panel
   in a state its own controls cannot get out of. */
export const MIN_FONT_SIZE = 9
export const MAX_FONT_SIZE = 20

function read(): TerminalPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")
    if (!raw || typeof raw !== "object") return DEFAULT_TERMINAL_PREFS
    const stored = raw as Partial<TerminalPrefs>
    return {
      fontSize:
        typeof stored.fontSize === "number" && Number.isFinite(stored.fontSize)
          ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(stored.fontSize)))
          : DEFAULT_TERMINAL_PREFS.fontSize,
      keyRow:
        stored.keyRow === "on" || stored.keyRow === "off" || stored.keyRow === "auto"
          ? stored.keyRow
          : DEFAULT_TERMINAL_PREFS.keyRow,
      keysExpanded: stored.keysExpanded === true,
    }
  } catch {
    return DEFAULT_TERMINAL_PREFS
  }
}

let cache = read()
const listeners = new Set<() => void>()

function write(next: TerminalPrefs): void {
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Quota, or private-mode storage. The panel still works for this session;
    // throwing out of a click handler would be worse than not remembering.
  }
  for (const listener of [...listeners]) listener()
}

export function setTerminalPrefs(patch: Partial<TerminalPrefs>): void {
  const next = { ...cache, ...patch }
  next.fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(next.fontSize)))
  write(next)
}

export const terminalPrefsSnapshot = (): TerminalPrefs => cache

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/* Another tab is the same device: a font size chosen in one terminal is the
   answer in every other one, including the ones already open. */
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  cache = read()
  for (const listener of [...listeners]) listener()
})

export function useTerminalPrefs(): TerminalPrefs {
  return useSyncExternalStore(subscribe, terminalPrefsSnapshot, terminalPrefsSnapshot)
}
