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

ipcMain.on("theme-changed", (_event, resolved, source) => {
  /* The native material tints itself from the OS theme, never from the page:
     a light app on a dark desktop got a dark acrylic/vibrancy slab behind its
     sidebar, which is what "too dark in light mode" was. `themeSource` is the
     one knob that repoints it, and it takes the app's *mode*, not the resolved
     colour — pinning "light"/"dark" also pins `prefers-color-scheme`, so a
     theme set to follow the OS has to stay "system" or it stops following it. */
  nativeTheme.themeSource = source === "light" || source === "dark" ? source : "system"
  if (!win || win.isDestroyed() || process.platform === "darwin") return
  win.setTitleBarOverlay({ color: "#00000000", symbolColor: symbolColorFor(resolved), height: 36 })
  /* No setBackgroundColor here any more: the tint is a constant, and acrylic's own
     light/dark variant is picked by the `themeSource` set two lines up. */
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
    /* The window's own material: macOS vibrancy, Windows 11 acrylic.
       Acrylic and not mica, and that is a measurement, not a taste. On Windows
       11 build 26200 a frameless window with `backgroundMaterial: "mica"` draws
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
       does not re-open it. */
    vibrancy: process.platform === "darwin" ? "sidebar" : undefined,
    visualEffectState: process.platform === "darwin" ? "active" : undefined,
    backgroundMaterial: process.platform === "win32" ? "acrylic" : undefined,
    /* NOT transparent, and that is load-bearing: a layered window loses its DWM
       rounding and its hairline border on Windows (verified on build 26200 — the
       corners go square and the edge disappears), and it is not what reveals the
       material either. Acrylic composites fine without it; the alpha
       `backgroundColor` below is what lets it through. */
    roundedCorners: true,
    backgroundColor:
      process.platform === "darwin"
        ? undefined
        : process.platform === "win32"
          ? WINDOW_TINT
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

  /* External links open in the real browser, never inside the app shell — but a
     dock popout is `window.open` too (dockview's `addPopoutGroup` opens
     `popout.html` and portals the panel's DOM into it). It is same-origin and
     it needs a real window object back, so it is allowed as a native child
     window; denying it sent the empty room to the system browser. */
  win.webContents.setWindowOpenHandler(({ url }) => {
    const sameOrigin = (() => {
      try {
        return new URL(url).origin === new URL(win.webContents.getURL()).origin
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
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
        webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, spellcheck: true },
      },
    }
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
    // ponytail: DevTools is for a vite server, not for pointing the shell at a
    // deployed client — same door, different intent.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(DEV_URL)) win.webContents.openDevTools({ mode: "detach" })
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
