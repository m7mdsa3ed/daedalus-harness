/* ── Drive: this window as a thread's browser ──
   While a thread's Preview has Drive on, this holds a `/browser` socket to the
   server and relays the `chrome-devtools-mcp` connection the agent opens there
   to Electron main, which answers as a browser of one page — the preview's
   `<webview>` (electron/cdp-shim.cjs). Messages pass through untouched.

   Frames from the server: `open` (a new client: start a fresh connection),
   `cdp`, `close`. Frames to it: `cdp`, and `closed` when the page went away.
   A dropped socket comes back on its own; 4009 means another window took the
   thread's preview over, which is not something to fight. */
import type { ServerSettings } from "@/lib/settings"

const RETRY_MS = 2_000

function browserSocketUrl(settings: ServerSettings, sessionId: string): string {
  const url = new URL("/browser", settings.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", settings.token)
  url.searchParams.set("sessionId", sessionId)
  return url.toString()
}

/** Start hosting; returns the stop. `onTakenOver` is called when another
    window claimed this thread's preview and this one stopped. */
export function hostBrowser(
  settings: ServerSettings,
  sessionId: string,
  guestId: number,
  onTakenOver: () => void
): () => void {
  const cdp = window.desktop?.cdp
  if (!cdp) return () => {}

  let ws: WebSocket | null = null
  let stopped = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const frame = (value: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value))
  }

  const offMessage = cdp.onMessage((id, data) => {
    if (id === guestId) frame({ t: "cdp", data })
  })
  const offClosed = cdp.onClosed((id, reason) => {
    if (id === guestId) frame({ t: "closed", reason })
  })

  const connect = () => {
    const socket = new WebSocket(browserSocketUrl(settings, sessionId))
    ws = socket
    socket.onmessage = (event) => {
      let message: { t?: string; data?: unknown }
      try {
        message = JSON.parse(String(event.data)) as typeof message
      } catch {
        return
      }
      if (message.t === "open" || message.t === "close") cdp.reset(guestId)
      else if (message.t === "cdp" && typeof message.data === "string") cdp.send(guestId, message.data)
    }
    socket.onclose = (event) => {
      if (ws !== socket) return
      cdp.reset(guestId)
      if (stopped) return
      if (event.code === 4009) {
        stopped = true
        onTakenOver()
        return
      }
      retry = setTimeout(connect, RETRY_MS)
    }
  }
  connect()

  return () => {
    stopped = true
    clearTimeout(retry)
    offMessage()
    offClosed()
    cdp.reset(guestId)
    ws?.close()
  }
}
