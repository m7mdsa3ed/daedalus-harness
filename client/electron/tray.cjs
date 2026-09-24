/* ── The tray / menu-bar icon: what the agents are doing, from outside the window ──
   The renderer is the only thing that knows which threads are running (the
   store, `lib/thread/statuses.ts`), so it pushes a summary over IPC
   (`desktop.setActivity`, throttled there) and this draws it: counts in the
   tooltip, "2 running · 1 waiting" as the menu-bar title on macOS (the one
   platform with a title beside a tray icon), and one menu row per busy thread.
   A row is routed exactly like a clicked notification — the main window is
   focused and told which thread (`notification-click`), and
   `installDesktopNotifications` navigates. Nothing here decides anything. */
const { Tray, Menu, nativeImage } = require("electron")

let tray = null
let activity = { running: 0, waiting: 0, items: [] }
let hooks = null

function summary() {
  const parts = []
  if (activity.running) parts.push(`${activity.running} running`)
  if (activity.waiting) parts.push(`${activity.waiting} waiting`)
  return parts.join(" · ")
}

function rebuild() {
  if (!tray || tray.isDestroyed()) return
  const text = summary()
  tray.setToolTip(text ? `Daedalus — ${text}` : "Daedalus")
  // macOS only; a no-op elsewhere. Waiting is spelled out so it reads apart from running.
  if (process.platform === "darwin") tray.setTitle(text ? ` ${text}` : "")
  /* Waiting first: a thread blocked on the reader is the one worth the click. */
  const rows = [...activity.items]
    .sort((a, b) => (a.state === b.state ? 0 : a.state === "waiting" ? -1 : 1))
    .map((item) => ({
      label: `${item.state === "waiting" ? "⚠ Waiting · " : "● "}${item.title || "Thread"}`.slice(0, 80),
      click: () => hooks.openThread(item.id),
    }))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(rows.length ? [...rows, { type: "separator" }] : [{ label: "Nothing running", enabled: false }, { type: "separator" }]),
      { label: hooks.isVisible() ? "Hide Daedalus" : "Show Daedalus", click: () => hooks.toggleWindow() },
      { label: "New thread", click: () => hooks.newThread() },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ]),
  )
}

/** `iconFile` is a PNG on disk; `hooks` are the window actions main owns. */
function installTray(iconFile, nextHooks) {
  hooks = nextHooks
  let image = nativeImage.createFromPath(iconFile)
  if (!image.isEmpty()) image = image.resize({ width: process.platform === "darwin" ? 16 : 20 })
  tray = new Tray(image)
  // Windows/Linux: a left click on the icon is "bring the window back".
  if (process.platform !== "darwin") tray.on("click", () => hooks.show())
  rebuild()
  return tray
}

function setActivity(next) {
  const items = Array.isArray(next?.items)
    ? next.items
        .filter((item) => item && typeof item.id === "string")
        .map((item) => ({ id: item.id, title: String(item.title ?? ""), state: item.state === "waiting" ? "waiting" : "running" }))
    : []
  activity = { running: Number(next?.running) || 0, waiting: Number(next?.waiting) || 0, items }
  rebuild()
}

module.exports = { installTray, setActivity, refreshTray: rebuild }
