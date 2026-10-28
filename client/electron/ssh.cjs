/* ── Connecting to a harness over SSH ──
   The desktop app's other way in: no public port, no token to copy. Everything
   runs through the system's own `ssh` — the person's keys, agent and
   ~/.ssh/config, and no SSH library in the app.

   Trust is explicit. `StrictHostKeyChecking=accept-new` would trust whatever
   key a host shows the first time, and for a server whose only door is SSH
   (`setup.sh --local`) a forged first connect is everything. So a host with no
   known key is scanned, the renderer shows the fingerprints, and only a
   confirmed scan — held here, never sent back from the page — is appended to
   known_hosts. Every other call runs `StrictHostKeyChecking=yes`.

   ponytail: key auth only (BatchMode). A password or passphrase prompt needs a
   PTY in main; add it when someone needs it.

   A tunnel is one `ssh -N -L` per saved host, on a local port chosen once and
   stored with the server entry: the saved server URL carries it, so a fresh
   port per launch would be a different server every launch. It is restarted
   with a backoff when it drops — thread sockets ride their own reconnect
   ladder meanwhile — and killed when the app quits. */
const { execFile, spawn } = require("node:child_process")
const fs = require("node:fs")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")

const SSH_DIR = path.join(os.homedir(), ".ssh")
const STRICT = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15"]

/** A host name as `ssh` takes it — no option injection through the field. */
const checkHost = (host) => {
  if (typeof host !== "string" || !/^[A-Za-z0-9._@:%\[\]-]+$/.test(host) || host.startsWith("-"))
    throw new Error("That host name has characters ssh would not take.")
  return host
}
/** A remote path as one shell word: a leading ~/ stays the remote $HOME. */
const shellPath = (dir) => {
  if (typeof dir !== "string" || !dir.trim()) throw new Error("A directory is required.")
  const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`
  if (dir === "~") return `"$HOME"`
  return dir.startsWith("~/") ? `"$HOME"/${quote(dir.slice(2))}` : quote(dir)
}

const run = (file, args, { input, timeout = 30_000 } = {}) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    )
    if (input !== undefined) child.stdin.end(input)
  })

/** Where a binary is on PATH, or null — `where` on Windows, where the OpenSSH
    client is an optional feature. */
async function locate(name) {
  const { code, stdout } = await run(process.platform === "win32" ? "where" : "which", [name])
  return code === 0 ? stdout.split(/\r?\n/)[0].trim() || null : null
}

/** The concrete hosts in ~/.ssh/config, wildcards left out. */
function configHosts() {
  try {
    const text = fs.readFileSync(path.join(SSH_DIR, "config"), "utf8")
    const hosts = new Set()
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*Host\s+(.+)$/i)
      if (!m) continue
      for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h)) hosts.add(h)
    }
    return [...hosts]
  } catch {
    return []
  }
}

/** The hostname and port `ssh` would actually dial, after ~/.ssh/config. */
async function resolved(host) {
  const { code, stdout, stderr } = await run("ssh", ["-G", host])
  if (code !== 0) throw new Error(stderr.trim() || `ssh could not resolve ${host}`)
  const get = (key) => stdout.match(new RegExp(`^${key} (.+)$`, "m"))?.[1]?.trim()
  return { hostname: get("hostname") ?? host, port: Number(get("port") ?? 22) }
}

/** Scans waiting for the person's yes, by host. Never taken from the page. */
const scans = new Map()

async function hostKey(host) {
  checkHost(host)
  const { hostname, port } = await resolved(host)
  const name = port === 22 ? hostname : `[${hostname}]:${port}`
  if ((await run("ssh-keygen", ["-F", name])).code === 0) return { known: true, fingerprints: [] }
  const scan = await run("ssh-keyscan", ["-T", "10", "-p", String(port), hostname])
  const keys = scan.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).join("\n")
  if (!keys) throw new Error(scan.stderr.trim() || `${hostname} did not answer a key scan`)
  const fp = await run("ssh-keygen", ["-lf", "-"], { input: keys + "\n" })
  scans.set(host, keys + "\n")
  return { known: false, fingerprints: fp.stdout.split(/\r?\n/).filter(Boolean) }
}

function trust(host) {
  const keys = scans.get(host)
  if (!keys) throw new Error("Scan the host's key first.")
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 })
  fs.appendFileSync(path.join(SSH_DIR, "known_hosts"), keys, { mode: 0o600 })
  scans.delete(host)
  return true
}

/** Is there a harness at `dir`, and what does its bootstrap file say. */
async function probe(host, dir) {
  checkHost(host)
  const d = shellPath(dir)
  const { code, stdout, stderr } = await run("ssh", [
    ...STRICT,
    host,
    `cat ${d}/server/data/config.json 2>/dev/null || echo '{}'; echo '---'; grep -s '^DAEDALUS_PORT=' ${d}/server/.env || true; echo '---'; test -f ${d}/setup.sh && echo checkout || (test -e ${d} && echo occupied || echo absent)`,
  ])
  if (code !== 0) throw new Error(stderr.trim() || `ssh to ${host} failed (${code})`)
  const [configText, envText, where] = stdout.split("---\n")
  let config = {}
  try {
    config = JSON.parse(configText)
  } catch {
    /* an unreadable file is the same as none */
  }
  const envPort = Number(envText.split("=")[1]) || null
  return {
    /** `checkout` (has setup.sh), `occupied` (something else is there), `absent`. */
    dir: where.trim(),
    token: typeof config.token === "string" ? config.token : null,
    port: envPort ?? (typeof config.port === "number" ? config.port : null),
  }
}

/** Clone (into nothing but an empty spot) and run setup.sh, streaming its
    output to `onOutput`. Resolves the exit code. */
function install(host, dir, repo, port, onOutput) {
  checkHost(host)
  if (typeof repo !== "string" || !repo.trim() || repo.startsWith("-")) throw new Error("A repository URL is required.")
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("A port is required.")
  const d = shellPath(dir)
  const r = `'${repo.trim().replace(/'/g, `'\\''`)}'`
  const script = [
    "set -e",
    `if [ -f ${d}/setup.sh ]; then echo "Using the checkout already at ${dir}"; `,
    `elif [ -e ${d} ]; then echo "${dir} exists and is not a harness checkout — choose another directory." >&2; exit 3; `,
    `else git clone ${r} ${d}; fi`,
    `${d}/setup.sh --local --port ${port}`,
  ].join("\n")
  return new Promise((resolve) => {
    const child = spawn("ssh", [...STRICT, host, "bash -s"], { windowsHide: true })
    child.stdout.on("data", (chunk) => onOutput(chunk.toString()))
    child.stderr.on("data", (chunk) => onOutput(chunk.toString()))
    child.on("error", (err) => {
      onOutput(`${err.message}\n`)
      resolve(1)
    })
    child.on("close", (code) => resolve(code ?? 1))
    child.stdin.end(script + "\n")
  })
}

/** A port nothing is listening on, chosen once per saved host. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

/** Is something accepting on 127.0.0.1:port. */
const accepting = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1")
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

/** One per saved host: `{child, localPort, remotePort, state, error, stopped, retry}`. */
const tunnels = new Map()

function tunnel(host, localPort, remotePort, report) {
  checkHost(host)
  const existing = tunnels.get(host)
  if (existing && !existing.stopped && existing.localPort === localPort && existing.remotePort === remotePort) {
    return existing.state === "open" ? Promise.resolve({ ok: true, port: localPort }) : existing.ready
  }
  if (existing) stop(host)
  const t = { localPort, remotePort, state: "connecting", error: null, stopped: false, retry: 0, child: null, ready: null }
  tunnels.set(host, t)
  const say = () => report({ host, state: t.state, port: localPort, error: t.error })

  const start = () =>
    new Promise(async (resolve) => {
      /* Something else on the port would pass the readiness check below and
         take this server's traffic: say so instead of re-picking silently. */
      if (await accepting(localPort)) {
        t.state = "down"
        t.error = `local port ${localPort} is already in use by another program`
        t.stopped = true
        say()
        return resolve({ ok: false, error: t.error })
      }
      let stderr = ""
      t.state = "connecting"
      say()
      const child = spawn(
        "ssh",
        [
          ...STRICT,
          "-N",
          "-o", "ExitOnForwardFailure=yes",
          "-o", "ServerAliveInterval=15",
          "-o", "ServerAliveCountMax=3",
          "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
          host,
        ],
        { windowsHide: true },
      )
      t.child = child
      child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)))
      let settled = false
      const settle = (value) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      /* Up once the local end accepts; ssh binds it only after it has
         authenticated and the forward was allowed. */
      const poll = setInterval(async () => {
        if (await accepting(localPort)) {
          clearInterval(poll)
          t.state = "open"
          t.error = null
          t.retry = 0
          say()
          settle({ ok: true, port: localPort })
        }
      }, 300)
      child.on("exit", () => {
        clearInterval(poll)
        t.child = null
        if (t.stopped) return
        t.error = stderr.trim().split("\n").pop() || "the tunnel closed"
        t.state = "down"
        say()
        settle({ ok: false, error: t.error })
        /* Dropped after it was up (or failed to come up): try again, slower
           each time, until the app quits or the entry is switched away. */
        const wait = Math.min(30_000, 1000 * 2 ** t.retry++)
        setTimeout(() => {
          if (!t.stopped && tunnels.get(host) === t) t.ready = start()
        }, wait).unref?.()
      })
    })

  t.ready = start()
  return t.ready
}

function stop(host) {
  const t = tunnels.get(host)
  if (!t) return
  t.stopped = true
  t.child?.kill()
  tunnels.delete(host)
}

function stopAll() {
  for (const host of [...tunnels.keys()]) stop(host)
}

/** Wire the IPC: every handler answers `{ok:true, ...}` or `{ok:false, error}`
    rather than rejecting, so the page reads one shape. */
function installSsh(ipcMain, app, windows) {
  const answer = (fn) => async (_event, ...args) => {
    try {
      return { ok: true, ...(await fn(...args)) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  const broadcast = (channel, payload) => {
    for (const w of windows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
  ipcMain.handle("ssh:available", answer(async () => ({ available: !!(await locate("ssh")) })))
  ipcMain.handle("ssh:hosts", answer(async () => ({ hosts: configHosts() })))
  ipcMain.handle("ssh:host-key", answer(hostKey))
  ipcMain.handle("ssh:trust", answer(async (host) => ({ trusted: trust(host) })))
  ipcMain.handle("ssh:probe", answer(probe))
  ipcMain.handle(
    "ssh:install",
    answer(async (host, dir, repo, port) => ({
      code: await install(host, dir, repo, port, (text) => broadcast("ssh:output", { host, text })),
    })),
  )
  ipcMain.handle("ssh:free-port", answer(async () => ({ port: await freePort() })))
  ipcMain.handle(
    "ssh:tunnel",
    answer(async (host, localPort, remotePort) => {
      const result = await tunnel(host, localPort, remotePort, (status) => broadcast("ssh:status", status))
      if (!result.ok) throw new Error(result.error)
      return { port: result.port }
    }),
  )
  ipcMain.handle(
    "ssh:stop",
    answer(async (host) => {
      stop(host)
      return {}
    }),
  )
  app.on("before-quit", stopAll)
}

module.exports = { installSsh, shellPath, checkHost }
