const { app, BrowserWindow, Menu, Notification, shell, nativeTheme, ipcMain, clipboard } = require("electron")
const path = require("node:path")
const fs = require("node:fs")
const http = require("node:http")

const DEV_URL = process.env.ELECTRON_DEV_URL || ""

// WSLg's compositor renders Chromium's GPU path as a blank white surface for
// frameless windows. Software compositing is slower but actually draws.
const IS_WSL = process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
if (IS_WSL || process.env.ELECTRON_DISABLE_GPU) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch("disable-gpu-compositing")
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
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (sessionId) win.webContents.send("notification-click", String(sessionId))
  })
  notification.show()
  return true
})

ipcMain.on("theme-changed", (_event, resolved) => {
  if (!win || win.isDestroyed() || process.platform === "darwin") return
  win.setTitleBarOverlay({ color: "#00000000", symbolColor: symbolColorFor(resolved), height: 36 })
})

ipcMain.handle("write-clipboard", (_event, text) => {
  clipboard.writeText(String(text ?? ""))
  return true
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
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => srv.close() }))
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
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  )
}

function installClipboardHandlers() {
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
    icon: path.join(__dirname, "..", "build", "icon.png"),
    // Edge-to-edge: no OS title bar, the app paints its own chrome. macOS keeps
    // the traffic lights inset; Windows/Linux get an overlay for min/max/close.
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      process.platform === "darwin"
        ? undefined
        : { color: "#00000000", symbolColor: symbolColorFor(nativeTheme.shouldUseDarkColors ? "dark" : "light"), height: 36 },
    trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 14 } : undefined,
    // Native through-the-desktop blur: macOS vibrancy / Windows 11 acrylic.
    vibrancy: process.platform === "darwin" ? "sidebar" : undefined,
    visualEffectState: process.platform === "darwin" ? "active" : undefined,
    backgroundMaterial: process.platform === "win32" ? "acrylic" : undefined,
    // NOT transparent: Windows skips DWM rounding and ignores backgroundMaterial
    // on transparent windows. Vibrancy/acrylic composite fine without it — the
    // alpha backgroundColor below is what lets them through.
    roundedCorners: true,
    backgroundColor:
      process.platform === "darwin"
        ? undefined
        : process.platform === "win32"
          ? "#00000000"
          : nativeTheme.shouldUseDarkColors
            ? "#0a0a0a"
            : "#ffffff",
    title: "Daedalus",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })

  installClipboardHandlers()

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

  // External links open in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event, url) => {
    const base = win.webContents.getURL()
    if (new URL(url).origin !== new URL(base).origin) {
      event.preventDefault()
      shell.openExternal(url)
    }
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
    win.webContents.openDevTools({ mode: "detach" })
  } else {
    server = await startStaticServer(path.join(app.getAppPath(), "dist"))
    await win.loadURL(`http://127.0.0.1:${server.port}/`)
  }
}

// Second launch focuses the existing window instead of opening a duplicate.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    installMenu()
    return createWindow()
  })

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("before-quit", () => {
    server?.close()
    server = null
  })
}
