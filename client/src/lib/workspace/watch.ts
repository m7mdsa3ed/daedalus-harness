/* ── Project file watch ──
   Reads the NDJSON stream from `GET /api/projects/:id/watch`.

   `fetch` and not `EventSource`, because EventSource cannot set an
   Authorization header and the alternative is the bearer token in a URL — in
   history, in logs, in whatever proxy sits in front. The body is newline-
   delimited JSON; blank lines are the server's heartbeat and are skipped.

   One connection per project no matter how many panels are watching, the same
   bargain the server makes: subscribers are ref-counted, and the last one to
   leave aborts the request. A dropped connection retries with a backoff and
   reports `overflow` on the way back, because anything that happened while it
   was down is exactly what "resync" means. */
import { loadSettings } from "@/lib/settings"

export interface WatchEvent {
  path: string
  kind: "change" | "rename"
}

export interface WatchBatch {
  projectId: string
  events: WatchEvent[]
  /** Too much happened to enumerate — drop cached listings and reload. */
  overflow: boolean
}

type Listener = (batch: WatchBatch) => void

interface Connection {
  listeners: Set<Listener>
  abort: AbortController
  retry: number
  closed: boolean
}

const connections = new Map<string, Connection>()

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000

function emit(connection: Connection, batch: WatchBatch): void {
  for (const listener of [...connection.listeners]) {
    try {
      listener(batch)
    } catch (error) {
      // One bad subscriber must not cost the others their events.
      console.error("Workspace watch listener threw", error)
    }
  }
}

async function run(projectId: string, connection: Connection): Promise<void> {
  while (!connection.closed) {
    try {
      const settings = loadSettings()
      if (!settings) return
      const response = await fetch(
        new URL(`/api/projects/${encodeURIComponent(projectId)}/watch`, settings.url),
        {
          headers: { authorization: `Bearer ${settings.token}` },
          signal: connection.abort.signal,
        }
      )
      /* A 404 is the project being gone, not a blip: retrying would hammer a
         route that will never answer differently. Anything else is worth
         another go. */
      if (response.status === 404) return
      if (!response.ok || !response.body) throw new Error(`watch failed: ${response.status}`)

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
          try {
            emit(connection, JSON.parse(line) as WatchBatch)
          } catch {
            /* a half-written line is not worth tearing the stream down for */
          }
        }
      }
    } catch (error) {
      if (connection.abort.signal.aborted || connection.closed) return
      console.warn("Workspace watch dropped, retrying", error)
    }

    if (connection.closed) return
    /* Whatever happened while we were disconnected is unknown, and unknown is
       what overflow means. Say so before sleeping, so a tree does not sit
       there stale for the length of the backoff. */
    emit(connection, { projectId, events: [], overflow: true })
    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** connection.retry)
    connection.retry += 1
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

/** Subscribe to a project's file events. Returns the unsubscribe. */
export function watchProject(projectId: string, listener: Listener): () => void {
  let connection = connections.get(projectId)
  if (!connection) {
    connection = { listeners: new Set(), abort: new AbortController(), retry: 0, closed: false }
    connections.set(projectId, connection)
    void run(projectId, connection)
  }
  connection.listeners.add(listener)

  return () => {
    const current = connections.get(projectId)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size > 0) return
    current.closed = true
    current.abort.abort()
    connections.delete(projectId)
  }
}
