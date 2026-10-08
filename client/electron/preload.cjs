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
  /** A thread window (main.cjs `open-thread-window`) — true for its whole life, whatever it navigates to. */
  popout: process.argv.includes("--daedalus-popout"),
  // Caption buttons (min/max/close) are drawn natively, colored via
  // titleBarOverlay; the app's theme is a user choice, so main must be told.
  setTitleBarTheme: (resolved, source, colorTheme) => ipcRenderer.send("theme-changed", resolved, source, colorTheme),
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
  /** What the agents are doing, for the tray: `{running, waiting, items:[{id,title,state}]}`. */
  setActivity: (summary) => ipcRenderer.send("set-activity", summary),
  /** Register the global quick-entry accelerator ("" turns it off).
      Resolves `{ok}` or `{ok:false, error}` — never rejects for a taken chord. */
  setQuickEntry: (accelerator) => ipcRenderer.invoke("set-quick-entry", accelerator),
  /** Read or persist the Windows backdrop material used on the next launch. */
  getWindowMaterial: () => ipcRenderer.invoke("get-window-material"),
  setWindowMaterial: (material) => ipcRenderer.invoke("set-window-material", material),
  /** Open one thread in a window of its own (`?popout=1`). */
  openThreadWindow: (sessionId) => ipcRenderer.invoke("open-thread-window", sessionId),
  /** Drive: a CDP connection to one of this window's `<webview>` guests,
      answered by main as a browser of one page (cdp-shim.cjs). */
  cdp: {
    reset: (guestId) => ipcRenderer.send("cdp-reset", guestId),
    send: (guestId, data) => ipcRenderer.send("cdp-send", guestId, data),
    onMessage: (handler) => {
      const listener = (_event, guestId, data) => handler(guestId, data)
      ipcRenderer.on("cdp-message", listener)
      return () => ipcRenderer.off("cdp-message", listener)
    },
    onClosed: (handler) => {
      const listener = (_event, guestId, reason) => handler(guestId, reason)
      ipcRenderer.on("cdp-closed", listener)
      return () => ipcRenderer.off("cdp-closed", listener)
    },
  },
  /** The Preview's page console: the backlog for a guest, and the live stream
      (`{type: "entry"|"clear"|"gone"}`), keyed by the guest's webContents id. */
  guestConsole: {
    read: (guestId) => ipcRenderer.invoke("preview-console-read", guestId),
    onMessage: (handler) => {
      const listener = (_event, guestId, payload) => handler(guestId, payload)
      ipcRenderer.on("guest-console", listener)
      return () => ipcRenderer.off("guest-console", listener)
    },
  },
  /** "Pick element": resolve with the element the person clicked, or null. */
  previewPicker: {
    pick: (guestId) => ipcRenderer.invoke("preview-pick", guestId),
    cancel: (guestId) => ipcRenderer.invoke("preview-pick-cancel", guestId),
  },
  /** A ShortcutId the native menu, the tray or the quick-entry hotkey asked
      the renderer to run. Returns an unsubscribe. */
  onShortcut: (handler) => {
    const listener = (_event, id) => handler(id)
    ipcRenderer.on("shortcut", listener)
    return () => ipcRenderer.off("shortcut", listener)
  },
})

/* The attributes are set before first paint so CSS never flashes the browser
   look — one door, three facts, all of them the platform's. */
const applyTheme = (resolved, colorTheme) => {
  const el = document.documentElement
  if (!el) return
  el.classList.toggle("dark", resolved === "dark")
  el.dataset.colorTheme = colorTheme
}
ipcRenderer.on("theme-changed", (_event, resolved, colorTheme) => applyTheme(resolved, colorTheme))

const mark = () => {
  const el = document.documentElement
  const theme = localStorage.getItem("theme")
  const resolved = theme === "light" || theme === "dark"
    ? theme
    : window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
  applyTheme(resolved, localStorage.getItem("ui.colorTheme") || "default")
  el.dataset.desktop = "true"
  el.dataset.desktopPlatform = process.platform
  if (vibrancy) el.dataset.desktopVibrancy = "true"
}
if (document.documentElement) mark()
else document.addEventListener("DOMContentLoaded", mark)
