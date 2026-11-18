// Phase 0 spike for docs/plans/browser.md. Plain Node ESM: `node scripts/browser-spike.mjs`.
// Prints one JSON object of measurements on stdout.
import puppeteer from "puppeteer-core"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import http from "node:http"

const CHROME = process.env.DAEDALUS_CHROME ?? "/usr/bin/google-chrome"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const metrics = {}
const notes = []

const PAGE = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<button id="b" onclick="document.getElementById('out').textContent='clicked'">Press me</button>
<label>Name <input id="i" aria-label="Name"></label>
<div id="out">idle</div>
<ul>${Array.from({ length: 2000 }, (_, n) => `<li style="height:24px;background:hsl(${n % 360} 60% 85%)">row ${n}</li>`).join("")}</ul>
</body></html>`
const dataUrl = (html) => "data:text/html;charset=utf-8," + encodeURIComponent(html)

// ---- /proc helpers ------------------------------------------------------------
function procTree(root) {
  const parent = new Map()
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8")
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
      parent.set(Number(d), ppid)
    } catch {}
  }
  const out = [root]
  for (let i = 0; i < out.length; i++) for (const [pid, pp] of parent) if (pp === out[i]) out.push(pid)
  return out
}
function kb(file, key) {
  try {
    const m = readFileSync(file, "utf8").match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"))
    return m ? Number(m[1]) : 0
  } catch { return 0 }
}
function treeMemory(browser) {
  const pids = procTree(browser.process().pid)
  let rss = 0, pss = 0
  const byType = {}
  for (const p of pids) {
    const r = kb(`/proc/${p}/status`, "VmRSS"), s = kb(`/proc/${p}/smaps_rollup`, "Pss")
    rss += r; pss += s
    let type = "browser"
    try { type = readFileSync(`/proc/${p}/cmdline`, "utf8").match(/--type=([\w-]+)/)?.[1] ?? (p === pids[0] ? "browser" : "other") } catch {}
    byType[type] = (byType[type] ?? 0) + Math.round(s / 1024)
  }
  return { processes: pids.length, rssMB: Math.round(rss / 1024), pssMB: Math.round(pss / 1024), pssMBByType: byType }
}

// ---- settle wait (as the plan describes it) -----------------------------------
function trackRequests(page) {
  const inflight = new Set()
  let lastChange = Date.now()
  const on = (r) => { inflight.add(r); lastChange = Date.now() }
  const off = (r) => { inflight.delete(r); lastChange = Date.now() }
  page.on("request", on); page.on("requestfinished", off); page.on("requestfailed", off)
  return { inflight, last: () => lastChange }
}
async function settle(page, tracker, action, { quietMs = 500, quietCap = 3000, total = 10000 } = {}) {
  const t0 = Date.now()
  let navigated = false
  const nav = page.waitForNavigation({ timeout: total }).then(() => { navigated = true }, () => {})
  await action()
  // A navigation counts as "started" if one is reported within a short window after the action.
  await Promise.race([nav, sleep(100)])
  const quietStart = Date.now()
  let capped = false
  while (true) {
    if (tracker.inflight.size === 0 && Date.now() - tracker.last() >= quietMs) break
    if (Date.now() - quietStart >= quietCap) { capped = true; break }
    await sleep(25)
  }
  // DOM-stable frame: two rAFs.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return { ms: Date.now() - t0, navigated, capped, inflightAtEnd: tracker.inflight.size }
}

async function launch(userDataDir, extraArgs = []) {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    userDataDir,
    defaultViewport: { width: 1280, height: 800 },
    args: ["--no-first-run", "--no-default-browser-check", ...extraArgs],
  })
}

// Local server: a page whose image takes 800ms, to check the settle wait sees in-flight requests.
const srv = http.createServer((req, res) => {
  if (req.url === "/slow.png") return setTimeout(() => { res.writeHead(200, { "content-type": "image/png" }); res.end() }, 800)
  res.writeHead(200, { "content-type": "text/html" })
  res.end(`<!doctype html><title>slow</title><img src="/slow.png"><a href="/">self</a>`)
})
await new Promise((r) => srv.listen(0, "127.0.0.1", r))
const port = srv.address().port

const dir = mkdtempSync(join(tmpdir(), "browser-spike-"))
const tLaunch = Date.now()
const browser = await launch(dir)
metrics.launchMs = Date.now() - tLaunch
metrics.chromeVersion = await browser.version()
// pipe: no DevToolsActivePort file and no --remote-debugging-port in argv.
metrics.pipeOnly = !browser.process().spawnargs.some((a) => a.startsWith("--remote-debugging-port")) &&
  browser.process().spawnargs.includes("--remote-debugging-pipe")

const page = (await browser.pages())[0] ?? (await browser.newPage())
await sleep(1000)
metrics.memoryBlank = treeMemory(browser)
const tracker = trackRequests(page)
await page.goto(dataUrl(PAGE))

// ---- screencast + wheel -------------------------------------------------------
const cdp = await page.createCDPSession()
let frames = 0, bytes = 0
const lat = []          // frame metadata timestamp -> receipt, ms
const inputToFrame = [] // wheel dispatch -> next frame, ms
let pendingInput = null
cdp.on("Page.screencastFrame", (f) => {
  const now = Date.now()
  frames++
  bytes += f.data.length * 0.75
  if (f.metadata.timestamp) lat.push(now - f.metadata.timestamp * 1000)
  if (pendingInput !== null) { inputToFrame.push(now - pendingInput); pendingInput = null }
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
})
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 })
await sleep(300)
const before = frames
const t0 = Date.now()
let wheels = 0
while (Date.now() - t0 < 3000) {
  if (pendingInput === null) pendingInput = Date.now()
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: wheels % 120 < 60 ? 120 : -120 })
  wheels++
  await sleep(16)
}
const dt = (Date.now() - t0) / 1000
const scrolled = await page.evaluate(() => window.scrollY)
await cdp.send("Page.stopScreencast")
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor((s.length - 1) * p)]) : null }
metrics.screencast = {
  framesIn3s: frames - before, fps: +((frames - before) / dt).toFixed(1), wheelEvents: wheels,
  avgFrameKB: Math.round(bytes / frames / 1024), scrollYAtEnd: scrolled,
  metaToReceiptMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95) },
  wheelToNextFrameMs: { p50: pct(inputToFrame, 0.5), p95: pct(inputToFrame, 0.95), n: inputToFrame.length },
}
await page.evaluate(() => window.scrollTo(0, 0))

// ---- AX snapshot -> elementHandle -> click --------------------------------------
const tSnap = Date.now()
const snap = await page.accessibility.snapshot({ interestingOnly: true })
metrics.axSnapshotMs = Date.now() - tSnap
let nodeCount = 0
const find = (n, pred) => { nodeCount++; if (pred(n)) return n; for (const c of n.children ?? []) { const r = find(c, pred); if (r) return r } return null }
const btnNode = find(snap, (n) => n.role === "button" && n.name === "Press me")
nodeCount = 0; find(snap, () => false); metrics.axNodes = nodeCount
const clickRuns = []
for (let k = 0; k < 10; k++) {
  await page.evaluate(() => { document.getElementById("out").textContent = "idle" })
  const s = await page.accessibility.snapshot({ interestingOnly: true })
  const n = find(s, (x) => x.role === "button" && x.name === "Press me")
  const h = await n.elementHandle()
  await h.click()
  clickRuns.push((await page.$eval("#out", (e) => e.textContent)) === "clicked")
  await h.dispose()
}
metrics.axClick = { found: !!btnNode, hasElementHandleFn: typeof btnNode?.elementHandle === "function", ok: clickRuns.filter(Boolean).length, of: clickRuns.length }

const inputNode = find(snap, (n) => n.role === "textbox" && n.name === "Name")
const ih = await inputNode.elementHandle()
await ih.type("hello spike") // fill via real key events
const v1 = await page.$eval("#i", (e) => e.value)
// Puppeteer has no ElementHandle.fill; replace = triple-click select then type.
await ih.click({ count: 3 }); await ih.type("replaced")
const v2 = await page.$eval("#i", (e) => e.value)
metrics.fill = { typed: v1, afterReplace: v2, ok: v1 === "hello spike" && v2 === "replaced" }

// ---- settle ---------------------------------------------------------------------
metrics.settle = {
  dataUrlGoto: await settle(page, tracker, () => page.goto(dataUrl("<title>two</title><p>second</p>"), { waitUntil: "load" }).catch(() => {})),
  dataUrlLinkClick: await (async () => {
    await page.goto(dataUrl(`<a id="l" href="${dataUrl("<title>three</title>").replace(/"/g, "&quot;")}">go</a>`))
    return settle(page, tracker, () => page.click("#l"))
  })(),
  httpSlowImage: await settle(page, tracker, () => page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" })),
  noopClick: await settle(page, tracker, () => page.evaluate(() => 0)),
}

// ---- memory -------------------------------------------------------------------
await page.goto(dataUrl(PAGE)); await sleep(1000)
metrics.memory1Tab = treeMemory(browser)
const extra = []
for (let k = 0; k < 4; k++) { const p = await browser.newPage(); await p.goto(dataUrl(PAGE + `<p>tab ${k}</p>`)); extra.push(p) }
await sleep(1500)
metrics.memory5Tabs = treeMemory(browser)
metrics.memoryPerExtraTabMB = {
  rss: Math.round((metrics.memory5Tabs.rssMB - metrics.memory1Tab.rssMB) / 4),
  pss: Math.round((metrics.memory5Tabs.pssMB - metrics.memory1Tab.pssMB) / 4),
}

// ---- session restore ------------------------------------------------------------
const restoreUrls = [`http://127.0.0.1:${port}/?a`, `http://127.0.0.1:${port}/?b`]
for (const p of [page, ...extra]) await p.goto("about:blank")
await extra[0].goto(restoreUrls[0]); await extra[1].goto(restoreUrls[1])
await sleep(2500) // let Chrome write the session file
await browser.close() // graceful: Browser.close over the pipe
const tryRestore = async (args) => {
  const b = await launch(dir, args)
  await sleep(2000)
  const urls = (await b.pages()).map((p) => p.url())
  await b.close()
  return { args, urls, restored: restoreUrls.every((u) => urls.includes(u)) }
}
let sessionFiles = []
try { sessionFiles = readdirSync(join(dir, "Default", "Sessions")) } catch {}
metrics.sessionRestore = {
  sessionFilesWritten: sessionFiles,
  plain: await tryRestore([]),
  restoreLastSession: await tryRestore(["--restore-last-session"]),
}

srv.close()
rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify({ metrics, notes }, null, 2))
