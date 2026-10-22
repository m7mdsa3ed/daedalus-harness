const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

/* pnpm links `node_modules/ws` into `.pnpm/`, and a symlink made in WSL does not
   resolve for a Windows Electron reading the tree over \\wsl.localhost. The real
   package directory is reachable by path, so look there when the link is not. */
function loadWs() {
  try {
    return require("ws")
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error
    const store = path.join(__dirname, "..", "node_modules", ".pnpm")
    const entry = fs.existsSync(store) && fs.readdirSync(store).find((name) => name.startsWith("ws@"))
    if (!entry) throw error
    return require(path.join(store, entry, "node_modules", "ws"))
  }
}

const { WebSocketServer, WebSocket } = loadWs()

/* ── DevTools protocol front door ──
   Electron serves CDP, but its browser target answers `Target.createTarget`
   with "Not supported", and `chrome-devtools-mcp`'s `new_page` is exactly that
   call - so an agent could list the app's pages and never open one of its own.

   This is a byte-for-byte relay in front of Chromium's real debugging port
   with ONE repair: `Target.createTarget` on the browser socket (and the
   `PUT /json/new` that is its HTTP twin) is answered here, by `createTarget`,
   which opens a window and returns its target id. Everything else - the page
   sockets, the flattened sessions multiplexed on the browser socket, the
   events - passes untouched, so the MCP sees no difference except that the
   call now works. Host and Origin are forwarded as they came, so Chromium's
   own DNS-rebinding refusal still applies. */

const CREATE_TARGET = "Target.createTarget"

/**
 * @param {object} options
 * @param {number} options.port        The port the MCP is told about (DAEDALUS_DEBUG_PORT).
 * @param {Promise<number>} options.upstream  Chromium's real port, once it is up.
 * @param {(params: object) => Promise<string>} options.createTarget  Opens a page, resolves its CDP target id.
 */
function startCdpProxy({ port, upstream, createTarget }) {
  const server = http.createServer(async (req, res) => {
    let upstreamPort
    try {
      upstreamPort = await upstream
    } catch (error) {
      res.writeHead(502).end(`DevTools is not up: ${error.message}`)
      return
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/json/new") {
      try {
        const target = url.search.startsWith("?") ? decodeURIComponent(url.search.slice(1)) : ""
        const targetId = await createTarget({ url: target || "about:blank" })
        const list = await getJson(upstreamPort, "/json/list", req.headers.host)
        const entry = list.find((item) => item.id === targetId)
        res.writeHead(entry ? 200 : 500, { "content-type": "application/json" })
        res.end(JSON.stringify(entry ?? { error: "The new page never listed" }))
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: error.message }))
      }
      return
    }
    const forward = http.request(
      { host: "127.0.0.1", port: upstreamPort, path: req.url, method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      }
    )
    forward.on("error", (error) => res.headersSent || res.writeHead(502).end(error.message))
    req.pipe(forward)
  })

  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  server.on("upgrade", (req, socket, head) => {
    sockets.handleUpgrade(req, socket, head, (client) => relay(client, req))
  })

  function relay(client, req) {
    /* Only the browser socket can create a target; a page socket has no such call. */
    const browser = (req.url ?? "").startsWith("/devtools/browser/")
    const queued = []
    let remote = null
    const closeBoth = () => {
      if (client.readyState <= WebSocket.OPEN) client.close()
      if (remote && remote.readyState <= WebSocket.OPEN) remote.close()
    }
    const toRemote = (data, isBinary) => {
      if (remote && remote.readyState === WebSocket.OPEN) remote.send(data, { binary: isBinary })
      else queued.push([data, isBinary])
    }

    upstream.then(
      (upstreamPort) => {
        remote = new WebSocket(`ws://127.0.0.1:${upstreamPort}${req.url}`, { perMessageDeflate: false })
        remote.on("open", () => {
          for (const [data, isBinary] of queued.splice(0)) remote.send(data, { binary: isBinary })
        })
        remote.on("message", (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
        })
        remote.on("close", closeBoth)
        remote.on("error", closeBoth)
      },
      closeBoth
    )

    client.on("message", (data, isBinary) => {
      if (browser && !isBinary) {
        let message = null
        try {
          message = JSON.parse(data.toString())
        } catch {
          // Not JSON - Chromium will say so itself.
        }
        if (message && message.method === CREATE_TARGET && !message.sessionId) {
          createTarget(message.params ?? {}).then(
            (targetId) => client.send(JSON.stringify({ id: message.id, result: { targetId } })),
            (error) =>
              client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: String(error.message ?? error) } }))
          )
          return
        }
      }
      toRemote(data, isBinary)
    })
    client.on("close", closeBoth)
    client.on("error", closeBoth)
  }

  server.on("error", (error) => console.error(`[daedalus] DevTools proxy on ${port}: ${error.message}`))
  server.listen(port, "127.0.0.1")
  return server
}

function getJson(port, path, host) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers: host ? { host } : undefined }, (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => {
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      })
      .on("error", reject)
  })
}

/**
 * Chromium's real port. It is started on port 0 (a free one) and says which in
 * `DevToolsActivePort` under the user-data dir; the file can be a previous
 * run's, so a port only counts once it answers.
 */
async function findUpstream(userDataDir, { timeoutMs = 15000 } = {}) {
  const fs = require("node:fs")
  const path = require("node:path")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const port = Number(fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split("\n")[0])
      if (port > 0) {
        await getJson(port, "/json/version")
        return port
      }
    } catch {
      // Not written yet, or stale - look again.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Chromium's DevTools port never came up")
}

module.exports = { startCdpProxy, findUpstream }
