const { contextBridge, ipcRenderer } = require("electron")

// Only macOS (vibrancy) and Windows 11 (mica) put a real material BEHIND the
// window; elsewhere the app must stay opaque or the sidebar shows a grey void.
const vibrancy = process.platform === "darwin" || process.platform === "win32"

// What the *bridge* exposes is that capability, never the current choice: the
// settings row must stay on screen after the material is switched off, or there
// is no way back. The choice itself lives in localStorage (`ui.windowMaterial`),
// owned by `lib/window-material.ts` once the bundle is up — read here for the
// one frame in between, so a window that was left opaque never flashes the
// material on. Same key, and `!== "false"` matches that module's default-on
// read.
let materialOn = true
try {
  materialOn = localStorage.getItem("ui.windowMaterial") !== "false"
} catch {
  /* Unreadable storage is the default, not a reason to go opaque. */
}

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  platform: process.platform,
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

// Set before first paint so CSS never flashes the browser look. The two facts
// above are the whole answer — the platform has a material and the choice has
// it on — so nothing is read a second time here.
const mark = () => {
  const el = document.documentElement
  el.dataset.desktop = "true"
  el.dataset.desktopPlatform = process.platform
  if (vibrancy && materialOn) el.dataset.desktopVibrancy = "true"
}
if (document.documentElement) mark()
else document.addEventListener("DOMContentLoaded", mark)
