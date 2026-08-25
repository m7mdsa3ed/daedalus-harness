const { contextBridge, ipcRenderer } = require("electron")

// Only macOS (vibrancy) and Windows 11 (acrylic) can blur what's BEHIND the
// window; elsewhere the app must stay opaque or the sidebar shows a grey void.
const vibrancy = process.platform === "darwin" || process.platform === "win32"

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  platform: process.platform,
  vibrancy,
  version: process.versions.electron,
  // Caption buttons (min/max/close) are drawn natively, colored via
  // titleBarOverlay; the app's theme is a user choice, so main must be told.
  setTitleBarTheme: (resolved) => ipcRenderer.send("theme-changed", resolved),
})

// Set before first paint so CSS never flashes the browser look.
const mark = () => {
  const el = document.documentElement
  el.dataset.desktop = "true"
  el.dataset.desktopPlatform = process.platform
  if (vibrancy) el.dataset.desktopVibrancy = "true"
}
if (document.documentElement) mark()
else document.addEventListener("DOMContentLoaded", mark)
