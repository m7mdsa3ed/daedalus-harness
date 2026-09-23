const { contextBridge, ipcRenderer } = require("electron")

// Only macOS (vibrancy) and Windows 11 (acrylic) put a real material BEHIND the
// window; elsewhere the app must stay opaque or the sidebar shows a grey void.
// There is no longer a choice to make about it: the material being there is the
// whole condition, so the attribute is the platform's answer and nothing else.
const vibrancy = process.platform === "darwin" || process.platform === "win32"

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  platform: process.platform,
  /** Whether this shell has an OS material behind it — the platform's answer,
      read by the renderer to decide whether the page may be translucent. */
  vibrancy,
  version: process.versions.electron,
  // Caption buttons (min/max/close) are drawn natively, colored via
  // titleBarOverlay; the app's theme is a user choice, so main must be told.
  setTitleBarTheme: (resolved, source) => ipcRenderer.send("theme-changed", resolved, source),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),
  /* OS notifications are the main process's (see main.cjs): the web
     Notification API inside Electron depends on an OS attribution the shell may
     not have, and silently draws nothing when it is missing. Resolves false
     when the platform cannot show one at all, so the caller can fall back. */
  notify: (payload) => ipcRenderer.invoke("notify", payload),
  /** The thread a clicked notification was about. Returns an unsubscribe. */
  onNotificationClick: (handler) => {
    const listener = (_event, sessionId) => handler(sessionId)
    ipcRenderer.on("notification-click", listener)
    return () => ipcRenderer.off("notification-click", listener)
  },
})

/* The attributes are set before first paint so CSS never flashes the browser
   look — one door, three facts, all of them the platform's. */
const mark = () => {
  const el = document.documentElement
  el.dataset.desktop = "true"
  el.dataset.desktopPlatform = process.platform
  if (vibrancy) el.dataset.desktopVibrancy = "true"
}
if (document.documentElement) mark()
else document.addEventListener("DOMContentLoaded", mark)
