const { contextBridge, ipcRenderer } = require("electron")

// Only macOS (vibrancy) and Windows 11 (mica) put a real material BEHIND the
// window; elsewhere the app must stay opaque or the sidebar shows a grey void.
const vibrancy = process.platform === "darwin" || process.platform === "win32"

// What the *bridge* exposes is that capability, never the current choice: the
// settings row must stay on screen after the material is switched off, or there
// is no way back. The choice itself lives in localStorage (`ui.windowMaterial`),
// owned by `lib/window-material.ts` once the bundle is up. Same key, and
// `!== "false"` matches that module's default-on read.
//
// Read **inside `mark()` and nowhere else**, and that is the whole of a bug this
// used to have. It was read once at preload scope, which runs before the
// document exists — a moment where the key is not dependably readable yet and
// came back empty often enough to matter. The empty read fell back to
// default-on, was cached, and `mark()` then wrote that cache at
// `DOMContentLoaded`: *after* `lib/window-material.ts` had already applied the
// stored choice at parse time, so the cached default clobbered it. Turning the
// switch off never survived a restart, while turning it on did — the tell that
// the only broken direction was the one whose stored value was the non-default.
// Reading at mark time cannot see a value the module has not already seen, so
// the two can no longer disagree about it.
function readMaterialOn() {
  try {
    return localStorage.getItem("ui.windowMaterial") !== "false"
  } catch {
    /* Unreadable storage is the default, not a reason to go opaque. */
    return true
  }
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

/* The attributes are set before first paint so CSS never flashes the browser
   look — `desktop`/`desktopPlatform` from the platform alone, and the material
   from the stored choice, read here rather than cached above. When that choice
   is "off" this never touches the attribute, so whatever `window-material.ts`
   applied at parse time stands — and when the two ever did race, the page's own
   reading won, because it is the newer of the two. */
const mark = () => {
  const el = document.documentElement
  el.dataset.desktop = "true"
  el.dataset.desktopPlatform = process.platform
  if (vibrancy && readMaterialOn()) el.dataset.desktopVibrancy = "true"
}
if (document.documentElement) mark()
else document.addEventListener("DOMContentLoaded", mark)
