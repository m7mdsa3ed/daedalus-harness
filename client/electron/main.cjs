const { app, BrowserWindow, shell, nativeTheme, ipcMain } = require("electron")
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

let win = null
let server = null

const symbolColorFor = (resolved) => (resolved === "dark" ? "#e5e5e5" : "#171717")

ipcMain.on("theme-changed", (_event, resolved) => {
  if (!win || win.isDestroyed() || process.platform === "darwin") return
  win.setTitleBarOverlay({ color: "#00000000", symbolColor: symbolColorFor(resolved), height: 36 })
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
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["media", "audioCapture", "notifications", "speaker-selection"].includes(permission))
  })

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

  app.whenReady().then(createWindow)

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
