/* ── The Preview's own tools: the page's console, and "pick element" ──
   Both need the `<webview>` guest, so both are the desktop shell's: a sandboxed
   iframe is cross-origin, which makes its console silent and its DOM
   unreadable. The main process does the reading (`electron/main.cjs`); this is
   the renderer's half — a subscription for the console and a promise for a
   pick, both keyed by the guest's webContents id (the same id Drive uses).

   Nothing here decides anything about the page: it is a read of what the page
   already did, and a click the person chose to aim at an element. */
import * as React from "react"

export interface ConsoleEntry {
  level: string
  message: string
  line?: number
  source?: string
}

export type GuestConsoleMessage =
  | { type: "entry"; entry: ConsoleEntry }
  | { type: "clear" }
  | { type: "gone" }

/** An element the person picked in the preview. Everything the composer needs
    to name it to an agent, and nothing the page did not already say. */
export interface PickedElement {
  selector: string
  tag: string
  id?: string
  classes?: string[]
  text?: string
  role?: string
  ariaLabel?: string
  href?: string
  name?: string
  rect?: { x: number; y: number; w: number; h: number }
}

/** The page's console, from the moment the drawer opens. `read` first so a
    drawer opened after the page has already logged shows the lines that came
    before it; a main-frame navigation clears it, and a new document starts a
    new console. */
export function useGuestConsole(
  guestId: number | null,
  enabled: boolean
): { entries: ConsoleEntry[]; clear: () => void } {
  const [entries, setEntries] = React.useState<ConsoleEntry[]>([])
  React.useEffect(() => {
    if (!enabled || guestId === null) return
    const api = window.desktop?.guestConsole
    if (!api) return
    let live = true
    api.read(guestId).then(
      (backlog) => {
        if (live) setEntries(backlog)
      },
      () => {}
    )
    const off = api.onMessage((id, message) => {
      if (id !== guestId) return
      if (message.type === "clear") setEntries([])
      else if (message.type === "entry" && message.entry)
        setEntries((prev) => [...prev, message.entry as ConsoleEntry].slice(-500))
    })
    return () => {
      live = false
      off()
    }
  }, [enabled, guestId])
  const clear = React.useCallback(() => setEntries([]), [])
  return { entries, clear }
}

/** The line a picked element hands the composer: the selector an agent can act
    on, what the element is, and where. One shape, so the preview and anything
    else that picks an element say it the same way. */
export function elementPrompt(element: PickedElement, url?: string): string {
  const label = element.text ? ` reading "${element.text.slice(0, 80)}"` : ""
  const where = url ? ` on the preview at ${url}` : " on the preview"
  return `Focus on \`${element.selector}\` - a <${element.tag}> element${label}${where}.`
}
