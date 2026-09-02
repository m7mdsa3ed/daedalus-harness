/* ── Dev server ──
   The three routes behind a project's managed dev server, and the NDJSON
   stream that says what it is doing.

   `GET /api/projects/:id/dev` is the reading, `POST …/dev {action}` the
   controls, and `GET …/dev/events` the stream: its first line is the current
   `DevStatus`, every later line is the whole status again (absolute, never a
   delta), and a blank line is the heartbeat. Same transport as `watch.ts` and
   for the same reason — `fetch` with a bearer header, not `EventSource`,
   which cannot set one and would put the token in a URL.

   One connection per (server, project) however many panels are looking:
   subscribers are ref-counted, the last one to leave aborts the request, and
   a dropped connection retries with a backoff. There is no "overflow" to
   report on the way back, because the first line after a reconnect is the
   complete state — whatever was missed is already superseded by it. */
import { api, type DevAction, type DevStatus, type ServerSettings } from "@/lib/settings"

const devPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/dev`

export function getDevStatus(
  settings: ServerSettings,
  projectId: string,
  signal?: AbortSignal
): Promise<DevStatus> {
  return api<DevStatus>(settings, devPath(projectId), { signal })
}

export function devAction(
  settings: ServerSettings,
  projectId: string,
  action: DevAction
): Promise<DevStatus> {
  return api<DevStatus>(settings, devPath(projectId), {
    method: "POST",
    body: JSON.stringify({ action }),
  })
}

/** Parse the one line-shape the stream carries. Anything else — a half line,
    a future field the server adds first — is dropped rather than dispatched. */
function parseStatus(line: string): DevStatus | null {
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== "object") return null
    const status = value as Partial<DevStatus>
    if (typeof status.projectId !== "string" || typeof status.state !== "string") return null
    return { ...status, errors: Array.isArray(status.errors) ? status.errors : [] } as DevStatus
  } catch {
    return null
  }
}

type Listener = (status: DevStatus) => void

interface Connection {
  listeners: Set<Listener>
  abort: AbortController
  retry: number
  closed: boolean
}

const connections = new Map<string, Connection>()

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000

function emit(connection: Connection, status: DevStatus): void {
  for (const listener of [...connection.listeners]) {
    try {
      listener(status)
    } catch (error) {
      // One bad subscriber must not cost the others their status.
      console.error("Dev status listener threw", error)
    }
  }
}

async function run(settings: ServerSettings, projectId: string, connection: Connection) {
  while (!connection.closed) {
    try {
      const response = await fetch(new URL(`${devPath(projectId)}/events`, settings.url), {
        headers: { authorization: `Bearer ${settings.token}` },
        signal: connection.abort.signal,
      })
      /* A 404 is the project being gone (or a server that predates the
         route); retrying would hammer an answer that will not change. */
      if (response.status === 404) return
      if (!response.ok || !response.body) throw new Error(`dev events failed: ${response.status}`)

      connection.retry = 0
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          if (!line) continue // heartbeat
          const status = parseStatus(line)
          if (status) emit(connection, status)
        }
      }
    } catch (error) {
      if (connection.abort.signal.aborted || connection.closed) return
      console.warn("Dev status stream dropped, retrying", error)
    }

    if (connection.closed) return
    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** connection.retry)
    connection.retry += 1
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

/** Subscribe to a project's dev-server status. The first callback is the
    current state (the stream's opening line), and every later one is the
    whole state again. Returns the unsubscribe. */
export function subscribeDevStatus(
  settings: ServerSettings,
  projectId: string,
  onStatus: Listener
): () => void {
  const key = `${settings.id}:${projectId}`
  let connection = connections.get(key)
  if (!connection) {
    connection = { listeners: new Set(), abort: new AbortController(), retry: 0, closed: false }
    connections.set(key, connection)
    void run(settings, projectId, connection)
  }
  connection.listeners.add(onStatus)

  return () => {
    const current = connections.get(key)
    if (!current) return
    current.listeners.delete(onStatus)
    if (current.listeners.size > 0) return
    current.closed = true
    current.abort.abort()
    connections.delete(key)
  }
}

/** Labels for the pill and the tiles. `off` and `exited` both read "Stopped":
    to the person looking at the preview the difference is the `message`,
    which the panel shows beside the pill, not a second word. */
export const DEV_STATE_LABEL: Record<DevStatus["state"], string> = {
  off: "Stopped",
  installing: "Installing",
  starting: "Starting",
  ready: "Live",
  failed: "Failed",
  exited: "Stopped",
}

/** The preview's address as the browser can open it: the server-relative
    root the status carries, resolved against the connection, plus the in-app
    path. Computed at render, never stored — the key in the root is per boot. */
export function previewUrl(settings: ServerSettings, status: DevStatus, path = "/"): string | null {
  if (!status.url) return null
  const root = status.url.endsWith("/") ? status.url : `${status.url}/`
  return new URL(root + path.replace(/^\/+/, ""), settings.url).toString()
}
