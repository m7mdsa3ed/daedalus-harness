const { app, BrowserWindow, Menu, Notification, shell, nativeTheme, ipcMain, clipboard, globalShortcut, webContents } = require("electron")
const path = require("node:path")
const fs = require("node:fs")
const http = require("node:http")
const { installTray, setActivity, refreshTray } = require("./tray.cjs")

const DEV_URL = process.env.ELECTRON_DEV_URL || ""

// WSLg's compositor renders Chromium's GPU path as a blank white surface for
// frameless windows. Software compositing is slower but actually draws.
const IS_WSL = process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
if (IS_WSL || process.env.ELECTRON_DISABLE_GPU) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch("disable-gpu-compositing")
}

/* DevTools protocol for a plain `chrome-devtools-mcp --browserUrl http://127.0.0.1:<port>`
   library row. Loopback only, but it is every window of the app, the harness page and
   its token included, to anything local - which is the cost of a stock MCP. Port from
   DAEDALUS_DEBUG_PORT; "0" turns it off. Must be set before `ready`. */
const DEBUG_PORT = process.env.DAEDALUS_DEBUG_PORT ?? "9222"
if (DEBUG_PORT !== "0") {
  app.commandLine.appendSwitch("remote-debugging-port", DEBUG_PORT)
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1")
}

/* Windows shows a notification only if it can attribute it to an installed
   app: without an explicit AppUserModelID Chromium raises the notification and
   the shell silently drops it, so `new Notification(...)` "works" and nothing
   appears. Must match electron-builder's `build.appId`, and must be set before
   any window exists. No-op on macOS/Linux. */
if (process.platform === "win32") app.setAppUserModelId("com.daedalus.harness")

let win = null
let server = null

const symbolColorFor = (resolved) => (resolved === "dark" ? "#e5e5e5" : "#171717")
let overlaySymbolColor = symbolColorFor(nativeTheme.shouldUseDarkColors ? "dark" : "light")
let appTheme = { resolved: nativeTheme.shouldUseDarkColors ? "dark" : "light", colorTheme: "default" }

/* Edge-to-edge: no OS title bar, the app paints its own chrome. macOS keeps
   the traffic lights inset; Windows/Linux get an overlay for min/max/close.
   Shared by the main window and every thread popout, so the two look alike. */
const chrome = () => ({
  frame: process.platform === "darwin",
  titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
  titleBarOverlay:
    process.platform === "darwin" ? undefined : { color: "#00000000", symbolColor: overlaySymbolColor, height: 40 },
  trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 14 } : undefined,
})
// The windows built with chrome(), whose caption buttons follow the theme.
const framelessWindows = new Set()
const workspaceReady = new Map()

/* ── What the window's material is tinted with ──
   Windows composites the window's own backgroundColor OVER the material, at
   that colour's alpha, and `#AARRGGBB` puts the alpha first. It must stay under
   255 or the material is dropped entirely and the window goes flat.

   Nothing added, in either mode — and that is a *handover*, not a default. This
   used to be white at 40% in light, because the material takes the desktop's
   colour and a dark wallpaper stayed dark behind a light app. That job now
   belongs to the page's global layer (`body::before` under
   `html[data-desktop-vibrancy]`, client/src/index.css), which does the same
   thing in the app's own `--background`, follows every palette and light/dark
   for free, and is one number instead of two. Two tempering layers, one here in
   `#AARRGGBB` and one there in oklch, is how you end up tuning against
   yourself — so this one is off and the stylesheet owns it.

   macOS needs none of this either: its vibrancy material carries its own
   light/dark appearance off `themeSource`. */
const WINDOW_TINT = "#00000000"

/* The desktop material is a native window-creation option. Keep this preference
   outside window-state.json so geometry saves cannot overwrite it. */
const windowMaterialFile = () => path.join(app.getPath("userData"), "window-material.json")
let activeWindowMaterial
function loadWindowMaterial() {
  if (activeWindowMaterial) return activeWindowMaterial
  try {
    const value = JSON.parse(fs.readFileSync(windowMaterialFile(), "utf8"))
    activeWindowMaterial = value === "mica" ? "mica" : "acrylic"
  } catch {
    activeWindowMaterial = "acrylic"
  }
  return activeWindowMaterial
}

/* Whether the window has a native material behind it at all (macOS vibrancy,
   Windows acrylic/mica). Like the material it is a window-creation option, so it
   is a file read at launch and a change needs a restart. On by default. */
const windowTranslucentFile = () => path.join(app.getPath("userData"), "window-translucent.json")
let activeTranslucent
function loadTranslucent() {
  if (activeTranslucent !== undefined) return activeTranslucent
  try {
    activeTranslucent = JSON.parse(fs.readFileSync(windowTranslucentFile(), "utf8")) !== false
  } catch {
    activeTranslucent = true
  }
  return activeTranslucent
}
// Sync, because preload marks <html> before first paint and cannot await.
ipcMain.on("get-window-translucent-sync", (event) => {
  event.returnValue = loadTranslucent() && (process.platform === "darwin" || process.platform === "win32")
})
ipcMain.handle("get-window-translucent", () => loadTranslucent())
ipcMain.handle("set-window-translucent", (_event, value) => {
  try {
    fs.writeFileSync(windowTranslucentFile(), JSON.stringify(value !== false))
    activeTranslucent = value !== false
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `Could not save window transparency: ${error?.message ?? error}` }
  }
})

/* ── Notifications ──
   The renderer does NOT use the web Notification API here, and the permission
   handlers below are not the whole story: Chromium's web notifications inside
   Electron depend on the embedder being attributable to the OS (a Start Menu
   shortcut carrying the AppUserModelID on Windows, a notification daemon on
   Linux), and when that attribution is missing `new Notification(...)` resolves
   perfectly happily and nothing is ever drawn. Electron's own `Notification`
   goes through the main process, which is the surface those platforms actually
   accept, and needs no permission at all — so the desktop app never has to ask
   for one, and never has an "enable notifications" offer to show.

   The click is routed the same way the service worker routes a push: focus the
   window that exists and tell the renderer which thread the notice was about
   (preload re-exposes it; lib/notifications.ts navigates). */
ipcMain.handle("notify", (_event, payload) => {
  if (!Notification.isSupported()) return false
  const { title, body, sessionId } = payload ?? {}
  const notification = new Notification({
    title: String(title ?? "Daedalus"),
    body: String(body ?? ""),
    // Dev/unpackaged runs have no bundled resources; a missing file is ignored.
    icon: path.join(__dirname, "..", "build", "icon.png"),
  })
  notification.on("click", () => {
    if (sessionId) openThreadInMain(String(sessionId))
    else showMain()
  })
  notification.show()
  return true
})

ipcMain.on("theme-changed", (_event, resolved, source, colorTheme) => {
  /* The native material tints itself from the OS theme, never from the page:
     a light app on a dark desktop got a dark acrylic/vibrancy slab behind its
     sidebar, which is what "too dark in light mode" was. `themeSource` is the
     one knob that repoints it, and it takes the app's *mode*, not the resolved
     colour — pinning "light"/"dark" also pins `prefers-color-scheme`, so a
     theme set to follow the OS has to stay "system" or it stops following it. */
  nativeTheme.themeSource = source === "light" || source === "dark" ? source : "system"
  appTheme = { resolved, colorTheme }
  overlaySymbolColor = symbolColorFor(resolved)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents !== _event.sender) w.webContents.send("theme-changed", resolved, colorTheme)
  }
  if (process.platform === "darwin") return
  for (const w of framelessWindows) {
    if (!w.isDestroyed()) w.setTitleBarOverlay({ color: "#00000000", symbolColor: overlaySymbolColor, height: 40 })
  }
  /* No setBackgroundColor here: the tint is constant, and the native material's
     light/dark variant is picked by `themeSource` above. */
})

ipcMain.handle("write-clipboard", (_event, text) => {
  clipboard.writeText(String(text ?? ""))
  return true
})

ipcMain.handle("get-window-material", () => loadWindowMaterial())
ipcMain.handle("set-window-material", (_event, value) => {
  if (process.platform !== "win32") return { ok: false, error: "Window material is only available on Windows" }
  if (value !== "acrylic" && value !== "mica") return { ok: false, error: "Unsupported window material" }
  try {
    fs.writeFileSync(windowMaterialFile(), JSON.stringify(value))
    activeWindowMaterial = value
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `Could not save window material: ${error?.message ?? error}` }
  }
})

/* ── Reaching the main window from outside it ──
   The tray, the quick-entry hotkey, the native menu and a notification all end
   the same way: the main window comes forward and the renderer is told what to
   do. What it does is never decided here — `shortcut` carries a ShortcutId and
   the renderer runs the handler that chord is bound to (`runShortcut`,
   hooks/use-hotkey.ts), and `notification-click` carries a thread id that
   `installDesktopNotifications` routes. A window closed on macOS is reopened
   first; a message sent before its renderer has mounted is lost (ponytail:
   queue it in main if that ever matters). */
/* One window, however many doors ask for it at once: macOS fires `activate`
   on launch too, and two callers each seeing "no window" made two. */
let creating = null
function ensureWindow() {
  creating ??= createWindow().finally(() => {
    creating = null
  })
  return creating
}
async function showMain() {
  if (!win || win.isDestroyed()) await ensureWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}
const sendToMain = async (channel, value) => (await showMain()).webContents.send(channel, value)
const openThreadInMain = (sessionId) => void sendToMain("notification-click", sessionId)
const runInMain = (shortcutId) => void sendToMain("shortcut", shortcutId)

ipcMain.on("set-activity", (_event, summary) => setActivity(summary))

/* ── Quick entry: a global hotkey that starts a thread from anywhere ──
   The accelerator is the renderer's device-local setting (Settings › Keyboard),
   sent here on boot and on every change; "" turns it off. A chord another app
   holds, or one Electron cannot parse, is an answer the settings row shows —
   never a throw. */
let quickEntry = ""
ipcMain.handle("set-quick-entry", (_event, accelerator) => {
  const next = String(accelerator ?? "").trim()
  if (quickEntry) globalShortcut.unregister(quickEntry)
  quickEntry = ""
  if (!next) return { ok: true }
  try {
    if (!globalShortcut.register(next, () => runInMain("newThread"))) {
      return { ok: false, error: `${next} is already taken by another application` }
    }
  } catch (err) {
    return { ok: false, error: `${next} is not a shortcut this system understands (${err?.message ?? err})` }
  }
  quickEntry = next
  return { ok: true }
})

/* ── A full workspace in its own window ──
   Same origin as the main window, with a stable window id passed through the
   preload so the workspace can isolate its dock and drafts. */
ipcMain.on("workspace-ready", (event) => {
  const reveal = workspaceReady.get(event.sender.id)
  if (!reveal) return
  workspaceReady.delete(event.sender.id)
  reveal()
})

ipcMain.handle("close-window", (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.isDestroyed()) return false
  owner.close()
  return true
})

ipcMain.handle("open-thread-window", (_event, sessionId) => {
  if (!win || win.isDestroyed() || typeof sessionId !== "string" || !sessionId) return false
  const origin = new URL(win.webContents.getURL()).origin
  const popoutId = `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const popout = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    icon: iconFile(),
    autoHideMenuBar: true,
    ...chrome(),
    ...material(),
    // Survives any navigation inside the window, unlike the URL flag (preload → desktop.popout).
    webPreferences: { ...webPreferences(), additionalArguments: ["--daedalus-popout", `--daedalus-popout-id=${popoutId}`] },
  })
  guardWindow(popout)
  framelessWindows.add(popout)
  popout.on("closed", () => framelessWindows.delete(popout))

  let revealed = false
  let revealTimeout
  const reveal = () => {
    if (revealed || popout.isDestroyed()) return
    revealed = true
    if (revealTimeout) clearTimeout(revealTimeout)
    if (!popout.isVisible()) popout.show()
  }
  const webContentsId = popout.webContents.id
  workspaceReady.set(webContentsId, reveal)
  revealTimeout = setTimeout(reveal, 4000)
  popout.once("closed", () => {
    workspaceReady.delete(webContentsId)
    if (revealTimeout) clearTimeout(revealTimeout)
  })
  popout.webContents.once("did-fail-load", (_event, code, description, url) => {
    console.error(`[daedalus] popout load failed ${code} ${description} -- ${url}`)
    reveal()
  })

  void popout.loadURL(`${origin}/t/${encodeURIComponent(sessionId)}?popout=1`).catch((error) => {
    console.error(`[daedalus] popout load failed: ${error}`)
    reveal()
  })
  return true
})

/* ── Updates ──
   electron-updater against the generic feed the build was given
   (`DAEDALUS_UPDATE_URL` → `publish`, scripts/electron-dist.mjs). Packaged runs
   only: a dev shell is a vite server, and an unpacked one has no app-update.yml.
   A build made without a feed has none either, so every background check fails
   — logged, never a dialog, because "nobody published one" is not news to the
   person at the window. macOS applies only a *signed* update; an unsigned build
   logs the refusal here and stays put. Required lazily, so a dev run never loads
   it at all. */
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
let updater = null
let updateDownloaded = false
let updateTimer = null
const logUpdateError = (error) => console.warn(`[daedalus] update: ${error?.message ?? error}`)

function getUpdater() {
  if (!app.isPackaged || DEV_URL) return null
  if (!updater) {
    updater = require("electron-updater").autoUpdater
    updater.autoDownload = true
    // An updater with no listener for "error" throws it; this is that listener.
    updater.on("error", logUpdateError)
    updater.on("update-downloaded", () => {
      updateDownloaded = true
    })
  }
  return updater
}

/* Whether there is an updater at all, asked synchronously by preload so the
   renderer is never handed an `update` bridge that can only answer "no" — a
   dev or unpacked shell falls back to a reload, which does fetch a newer client. */
ipcMain.on("update-active-sync", (event) => {
  event.returnValue = app.isPackaged && !DEV_URL
})

/** Check now and every six hours; once per run, whatever reopens the window. */
function startUpdateChecks() {
  if (updateTimer || !getUpdater()) return
  const check = () => void getUpdater().checkForUpdatesAndNotify().catch(logUpdateError)
  check()
  updateTimer = setInterval(check, UPDATE_INTERVAL_MS)
}

/* The renderer's "get a newer build" (lib/client-update.ts). With autoDownload
   on, a found update is already downloading, and the answer waits for it: the
   caller's next move is `update:install`, which needs the file on disk. A
   failed check rejects — the person asked, so the reason is theirs to read. */
ipcMain.handle("update:check", async () => {
  const u = getUpdater()
  if (!u) return { available: false }
  const result = await u.checkForUpdates()
  if (!result?.isUpdateAvailable) return { available: false }
  await result.downloadPromise
  return { available: true, version: result.updateInfo.version }
})
ipcMain.handle("update:install", () => {
  if (!updateDownloaded) throw new Error("No desktop update has been downloaded yet.")
  getUpdater().quitAndInstall()
})

/* Serve dist/ over local http (not file://) so the service worker (FCM) and
   absolute paths work like the web build. ponytail: static files only. */
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
}
/* The origin IS the storage key. Everything device-local — the server URL and
   token, themes, drafts, pins, the dock layout — is localStorage on whatever
   origin the window loaded from, and Chromium keys that by scheme://host:PORT.
   `listen(0)` handed out a fresh ephemeral port on every launch, so every
   launch was a new origin and the app opened blank with the previous run's
   state stranded on a port nothing will ever serve again (six such orphans in
   %APPDATA%/daedalus-client before this was pinned).

   Fixed port, therefore. If something else already holds it we fall back to an
   ephemeral one rather than refusing to start: that loses one launch's state,
   which beats not opening. */
const STATIC_PORT = 43917
function startStaticServer(root) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost")
      let file = path.join(root, path.normalize(url.pathname).replace(/^([/\\])+/, ""))
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(root, "index.html")
      }
      res.setHeader("content-type", MIME[path.extname(file)] || "application/octet-stream")
      fs.createReadStream(file).pipe(res)
    })
    let retried = false
    srv.on("error", (err) => {
      if (retried) throw err
      retried = true
      console.warn(`[daedalus] port ${STATIC_PORT} is taken (${err.code}); this launch starts with empty settings`)
      srv.listen(0, "127.0.0.1")
    })
    srv.once("listening", () => resolve({ port: srv.address().port, close: () => srv.close() }))
    srv.listen(STATIC_PORT, "127.0.0.1")
  })
}

async function waitForDevServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(url, { method: "HEAD" })
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`Vite never came up at ${url}. Run \`pnpm dev\` first.`)
      await new Promise((r) => setTimeout(r, 300))
    }
  }
}

// Window geometry survives restarts.
const stateFile = () => path.join(app.getPath("userData"), "window-state.json")
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"))
  } catch {
    return { width: 1280, height: 820 }
  }
}
function saveState() {
  if (!win || win.isDestroyed()) return
  const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds()
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }))
  } catch {
    // best effort
  }
}

/* Chromium's clipboard accelerators (⌘/Ctrl+C/X/V/A) are the application
   MENU's, not the web page's: with no menu installed there is no accelerator,
   and copy silently does nothing. `autoHideMenuBar` only hides the bar — it
   does not build one — so the menu has to be stated. Everything is a role, so
   the OS supplies the labels and the platform-correct keys. */
function installMenu() {
  const isMac = process.platform === "darwin"
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" }] : []),
      { role: "fileMenu" },
      { role: "editMenu" },
      /* The app's own rows run the renderer's shortcut handlers (`runInMain`),
         so a menu row and its chord are one implementation. No accelerators on
         them: the chords are the reader's to rebind, and a menu accelerator
         would swallow the key before the page's binding saw it. */
      {
        label: "View",
        submenu: [
          { label: "Toggle Sidebar", click: () => runInMain("sidebar") },
          { label: "New Thread", click: () => runInMain("newThread") },
          { label: "Command Palette", click: () => runInMain("palette") },
          { label: "Split Right", click: () => runInMain("splitRight") },
          { type: "separator" },
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  )
}

/* Dev/unpackaged runs have the source PNG; a packaged build ships only dist/,
   whose PWA icon is the stand-in (the tray needs a real file on every OS). */
function iconFile() {
  const source = path.join(__dirname, "..", "build", "icon.png")
  return fs.existsSync(source) ? source : path.join(app.getAppPath(), "dist", "icon-192.png")
}

const webPreferences = () => ({
  preload: path.join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  spellcheck: true,
  /* The Preview panel's `<webview>` (web-panel.tsx). Every guest is pinned
     down by `guardWebview` before it attaches, whatever the page asked for. */
  webviewTag: true,
})

/* A previewed page is code someone is writing, or a third-party site, and it
   must not reach the app that embeds it — the guarantee the sandboxed iframe
   gave. So: no preload (no `window.desktop`), no Node, its own sandboxed
   process, and its own session (`persist:preview`), so the app's storage and
   bearer token are not in the guest's jar. http(s) only, as the address bar
   already insists. */
const PREVIEW_PARTITION = "persist:preview"
const isWebUrl = (url) => /^https?:\/\//i.test(url)

/* ── The Preview's console ──
   A `<webview>`'s page is the one console this app can honestly read — a
   sandboxed iframe's is cross-origin and silent. Main listens on each guest and
   relays to the window that embeds it, keyed by the guest's webContents id (the
   same id Drive uses), and keeps a bounded backlog per guest so a panel opened
   after a page has already logged still gets the earlier lines: the renderer's
   subscription starts at mount, and a console that is empty because it began
   three seconds late is worse than none. */
const CONSOLE_LIMIT = 500
const consoleBuffers = new Map()
function normalizeConsoleLevel(level) {
  if (level === "info" || level === "warning" || level === "error" || level === "debug") return level
  return ["debug", "info", "warning", "error"][level] ?? "info"
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    params.partition = PREVIEW_PARTITION
    if (!isWebUrl(params.src)) event.preventDefault()
  })
  contents.on("did-attach-webview", (_e, guest) => {
    /* A popup is a link the person followed out of the page: the real
       browser, never a window of the app shell. */
    guest.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) shell.openExternal(url)
      return { action: "deny" }
    })
    guest.on("will-navigate", (event, url) => {
      if (!isWebUrl(url)) event.preventDefault()
    })

    /* The page's console, buffered per guest and streamed to its window. A new
       document starts a new console, so a main-frame navigation clears what was
       there — the log belongs to the page you are looking at, not to the tab. */
    const guestId = guest.id
    const buffer = []
    consoleBuffers.set(guestId, buffer)
    /* Electron 35+ hands the details object first and keeps the old positional
       arguments after it; read the object and fall back so this holds on either. */
    guest.on("console-message", (details, level, message, line, sourceId) => {
      const entry =
        details && typeof details === "object" && "message" in details
          ? { level: normalizeConsoleLevel(details.level), message: String(details.message), line: details.lineNumber, source: details.sourceId }
          : { level: normalizeConsoleLevel(level), message: String(message ?? ""), line, source: sourceId }
      buffer.push(entry)
      if (buffer.length > CONSOLE_LIMIT) buffer.shift()
      if (!contents.isDestroyed()) contents.send("guest-console", guestId, { type: "entry", entry })
    })
    guest.on("did-navigate", () => {
      buffer.length = 0
      if (!contents.isDestroyed()) contents.send("guest-console", guestId, { type: "clear" })
    })
    guest.on("destroyed", () => {
      consoleBuffers.delete(guestId)
      if (!contents.isDestroyed()) contents.send("guest-console", guestId, { type: "gone" })
    })
  })
})

/* ── Point at an element ──
   The Preview's "Pick element": the person clicks the page, and the element
   they clicked comes back as a selector and its facts, for the composer to hand
   to an agent. Run in the guest's own world (`executeJavaScript`, not the
   debugger) so it never fights Drive for the one debugger a page has. The
   script draws its own highlight, swallows the click it is told to pick, and
   resolves null on Escape or when the panel says stop. */
const PICK_SCRIPT = `
(function () {
  if (window.__daedalusPicker) return Promise.resolve(null)
  var overlay = document.createElement("div")
  overlay.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;background:rgba(59,130,246,0.22);outline:2px solid rgb(59,130,246);border-radius:2px"
  document.documentElement.appendChild(overlay)
  var current = null
  function esc(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(String(value))
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\\\" + c })
  }
  function selectorFor(el) {
    if (!el || !(el instanceof Element)) return ""
    if (el.id) return "#" + esc(el.id)
    var parts = []
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && depth < 6) {
      if (node.id) { parts.unshift("#" + esc(node.id)); break }
      var part = node.tagName.toLowerCase()
      if (node.classList && node.classList.length) {
        var classes = [].slice.call(node.classList, 0, 2)
        for (var i = 0; i < classes.length; i++) part += "." + esc(classes[i])
      }
      var parent = node.parentElement
      if (parent) part += ":nth-child(" + ([].slice.call(parent.children).indexOf(node) + 1) + ")"
      parts.unshift(part)
      node = parent
      depth++
    }
    return parts.join(" > ")
  }
  function describe(el) {
    if (!el || !(el instanceof Element)) return null
    var rect = el.getBoundingClientRect()
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      classes: [].slice.call(el.classList || []),
      text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 140),
      role: el.getAttribute("role") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      href: el.getAttribute("href") || "",
      name: el.getAttribute("name") || "",
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
    }
  }
  return new Promise(function (resolve) {
    var cleanup = null
    function done(value) {
      if (cleanup) cleanup()
      resolve(value)
    }
    var onMove = function (event) {
      var el = event.target
      if (!el || el === overlay || !(el instanceof Element)) return
      current = el
      var rect = el.getBoundingClientRect()
      overlay.style.left = rect.left + "px"
      overlay.style.top = rect.top + "px"
      overlay.style.width = rect.width + "px"
      overlay.style.height = rect.height + "px"
    }
    var onClick = function (event) {
      event.preventDefault()
      event.stopPropagation()
      done(describe(current || event.target))
    }
    var onKey = function (event) {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        done(null)
      }
    }
    cleanup = function () {
      document.removeEventListener("mousemove", onMove, true)
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("keydown", onKey, true)
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      delete window.__daedalusPicker
      delete window.__daedalusPickerCleanup
      cleanup = null
    }
    document.addEventListener("mousemove", onMove, true)
    document.addEventListener("click", onClick, true)
    document.addEventListener("keydown", onKey, true)
    window.__daedalusPicker = true
    window.__daedalusPickerCleanup = function () { done(null) }
  })
})()
`
ipcMain.handle("preview-pick", async (event, guestId) => {
  const guest = webContents.fromId(guestId)
  if (!guest || guest.isDestroyed() || guest.hostWebContents !== event.sender) return null
  try {
    return await guest.executeJavaScript(PICK_SCRIPT, true)
  } catch {
    return null
  }
})
ipcMain.handle("preview-pick-cancel", (event, guestId) => {
  const guest = webContents.fromId(guestId)
  if (!guest || guest.isDestroyed() || guest.hostWebContents !== event.sender) return
  guest.executeJavaScript("window.__daedalusPickerCleanup && window.__daedalusPickerCleanup()", true).catch(() => {})
})
ipcMain.handle("preview-console-read", (event, guestId) => {
  const guest = webContents.fromId(guestId)
  if (!guest || guest.hostWebContents !== event.sender) return []
  return consoleBuffers.get(guestId) ?? []
})

/* The window's own material — see the long note in createWindow. Shared with a
   thread popout, because preload marks every window translucent on these
   platforms and a popout without the material would draw a grey void. */
const material = () => {
  /* Off by the reader (Settings › Appearance › Desktop window): no native
     material, so an opaque window colour, and preload leaves the page opaque. */
  const translucent = loadTranslucent()
  const solid = nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff"
  return {
    vibrancy: translucent && process.platform === "darwin" ? "sidebar" : undefined,
    visualEffectState: translucent && process.platform === "darwin" ? "active" : undefined,
    backgroundMaterial: translucent && process.platform === "win32" ? loadWindowMaterial() : undefined,
    roundedCorners: true,
    backgroundColor: !translucent
      ? solid
      : process.platform === "darwin"
        ? undefined
        : process.platform === "win32"
          ? WINDOW_TINT
          : solid,
  }
}

/** Clipboard keys, the context menu and the external-link rules — every window's. */
function guardWindow(w) {
  installClipboardHandlers(w)
  w.webContents.on("did-create-window", (child) => {
    framelessWindows.add(child)
    child.on("closed", () => framelessWindows.delete(child))
    guardWindow(child)
    if (process.platform !== "darwin") {
      child.setTitleBarOverlay({ color: "#00000000", symbolColor: overlaySymbolColor, height: 40 })
    }
    child.webContents.once("dom-ready", () => {
      child.webContents.send("theme-changed", appTheme.resolved, appTheme.colorTheme)
    })
  })
  /* External links open in the real browser, never inside the app shell — but a
     dock popout is `window.open` too (dockview's `addPopoutGroup` opens
     `popout.html` and portals the panel's DOM into it). It is same-origin and
     it needs a real window object back, so it is allowed as a native child
     window; denying it sent the empty room to the system browser. */
  w.webContents.setWindowOpenHandler(({ url }) => {
    const sameOrigin = (() => {
      try {
        return new URL(url).origin === new URL(w.webContents.getURL()).origin
      } catch {
        return false
      }
    })()
    if (!sameOrigin) {
      shell.openExternal(url)
      return { action: "deny" }
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        ...chrome(),
        ...material(),
        webPreferences: webPreferences(),
      },
    }
  })
  w.webContents.on("will-navigate", (event, url) => {
    let target
    try {
      target = new URL(url)
    } catch {
      event.preventDefault()
      return
    }

    const base = w.webContents.getURL()
    // A newly created popout can navigate before Chromium has assigned its URL.
    // Its initial URL was already checked by setWindowOpenHandler above.
    if (!base) return

    let baseOrigin
    try {
      baseOrigin = new URL(base).origin
    } catch {
      event.preventDefault()
      return
    }
    if (target.origin !== baseOrigin) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
}

function installClipboardHandlers(win) {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt) return
    if (!(input.control || input.meta)) return

    const commands = {
      c: "copy",
      x: "cut",
      v: "paste",
      a: "selectAll",
    }
    const command = commands[input.key.toLowerCase()]
    if (!command) return

    event.preventDefault()
    win.webContents[command]()
  })

  win.webContents.on("context-menu", (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "cut", enabled: params.isEditable && params.editFlags.canCut },
      { role: "paste", enabled: params.isEditable && params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll" },
    ])
    menu.popup({ window: win })
  })
}

async function createWindow() {
  const state = loadState()

  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width || 1280,
    height: state.height || 820,
    minWidth: 700,
    minHeight: 500,
    show: false,
    /* Dev/unpackaged runs have no bundled resources, so the window icon has to
       be pointed at the source PNG; a packaged build takes it from the
       electron-builder `icon` config instead. macOS ignores this entirely and
       uses the bundle icon. */
    icon: iconFile(),
    ...chrome(),
    /* The window's own material: macOS vibrancy, Windows 11 Acrylic or Mica.
       The Windows choice is device-local, defaults to Acrylic, and is read at
       creation for this window and every popout. Mica is user-selectable despite
       the observed limitation on build 26200: in this frameless configuration
       it draws near-black instead of the desktop wallpaper. Acrylic draws there.
       Keep the page transparent so the selected native material shows through.
       On Windows 11 build 26200 a frameless window with `backgroundMaterial: "mica"` draws
       **nothing** — the page is genuinely transparent (html/body/wrapper/sidebar
       all compute to `rgba(0,0,0,0)`, `body::before` is the 45% veil) and what
       shows through is near-black, not the desktop. The same window with
       `acrylic` reveals the wallpaper, and DWM *does* report the mica backdrop
       as set (`SYSTEMBACKDROP_TYPE=2`), so this is not "the option was ignored":
       mica is a tint of the wallpaper sampled somewhere the frameless window
       does not have, and it comes out as the dark flat tone. Acrylic is what
       actually reads as the desktop behind the app.

       (This repo went the other way once, in bf94706, on the reasoning below —
       mica is the stiller, cheaper material. Reasonable, but it does not draw
       here, so it is back to acrylic, which is what shipped before it and what
       the CHANGELOG's "vibrancy/acrylic" still says.)

       Acrylic is the live blur, so the caveat is real: text sits over a surface
       that changes whenever something under the window does. That is why nothing
       stands between the material and the page's text on its own — that is the
       global layer's job (see WINDOW_TINT and `--app-veil` in
       client/src/index.css), and it is a single knob, so swapping the material
       does not re-open it.

       NOT transparent, and that is load-bearing: a layered window loses its DWM
       rounding and its hairline border on Windows (verified on build 26200 — the
       corners go square and the edge disappears), and it is not what reveals the
       material either. Acrylic composites fine without it; the alpha
       `backgroundColor` in material() is what lets it through. */
    ...material(),
    title: "Daedalus",
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  })

  guardWindow(win)
  framelessWindows.add(win)
  win.on("closed", () => framelessWindows.delete(win))
  win.on("show", refreshTray)
  win.on("hide", refreshTray)

  if (state.maximized) win.maximize()

  // ready-to-show can never fire (WSLg withholds first frames); the timer
  // guarantees a window either way.
  const reveal = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show()
  }
  win.once("ready-to-show", reveal)
  setTimeout(reveal, 4000)

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[daedalus] load failed ${code} ${desc} -- ${url}`)
    reveal()
  })
  win.on("close", saveState)
  win.on("closed", () => {
    win = null
  })

  // Mic access for native SpeechRecognition (voice input) + notifications.
  const ALLOWED = ["media", "audioCapture", "notifications", "speaker-selection"]
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.includes(permission))
  })
  /* The request handler answers `Notification.requestPermission()`; this one
     answers the SYNCHRONOUS checks Chromium makes before it will even display a
     notification it was handed. Without it the ask can succeed and the
     notification still never render. */
  win.webContents.session.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED.includes(permission)
  )

  if (DEV_URL) {
    await waitForDevServer(DEV_URL)
    await win.loadURL(DEV_URL)
    // ponytail: DevTools is for a vite server, not for pointing the shell at a
    // deployed client — same door, different intent.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(DEV_URL)) win.webContents.openDevTools({ mode: "detach" })
  } else {
    // Once per run: a window reopened on macOS must land on the same origin.
    server ??= await startStaticServer(path.join(app.getAppPath(), "dist"))
    await win.loadURL(`http://127.0.0.1:${server.port}/`)
    startUpdateChecks()
  }
}

// Second launch focuses the existing window instead of opening a duplicate.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => void showMain())

  app.whenReady().then(() => {
    installMenu()
    installTray(iconFile(), {
      openThread: openThreadInMain,
      newThread: () => runInMain("newThread"),
      isVisible: () => !!win && !win.isDestroyed() && win.isVisible(),
      show: () => void showMain(),
      toggleWindow: () => (win && !win.isDestroyed() && win.isVisible() ? win.hide() : void showMain()),
    })
    return ensureWindow()
  })

  // A hidden (tray) window is still a window, so the dock icon has to show it.
  app.on("activate", () => void showMain())

  app.on("will-quit", () => globalShortcut.unregisterAll())

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("before-quit", () => {
    server?.close()
    server = null
  })
}
