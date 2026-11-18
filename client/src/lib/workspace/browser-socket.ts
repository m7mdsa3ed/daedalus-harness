/* ── The browser panel's socket ──
   One per panel, onto the project's browser (`/browser`, beside `/terminal`;
   docs/plans/browser.md). Two streams on it, kept apart on purpose:

   - **State** is JSON and absolute (`@daedalus/browser-protocol`): each
     message replaces what was held for its key, so this is a small external
     store a component reads with `useSyncExternalStore`, and a viewer that
     reconnects is right after the first few messages.
   - **Frames** are binary and never touch React: decoded with
     `createImageBitmap` and handed to whoever drew the last one. While one is
     decoding, arrivals are not queued -- only the newest is kept and decoded
     next, so a slow device skips frames instead of falling behind. The newest
     is kept rather than dropped because a screencast only sends on change: a
     dropped *last* frame would leave a stale picture until the page moved.

   The token is in the query string for the reason `terminals.ts` gives: the
   WebSocket constructor cannot set a header. */
import {
  BROWSER_CLOSE,
  BROWSER_PROTOCOL_VERSION,
  BROWSER_SOCKET_PATH,
  decodeBrowserFrame,
  type BrowserAgentActivity,
  type BrowserCommand,
  type BrowserDialog,
  type BrowserErrorMessage,
  type BrowserFrameHeader,
  type BrowserServerMessage,
  type BrowserTab,
  type BrowserTabId,
  type BrowserViewportMessage,
} from "@daedalus/browser-protocol"

import type { ServerSettings } from "@/lib/settings"

export function browserSocketUrl(settings: ServerSettings, projectId: string, sessionId?: string | null): string {
  const url = new URL(BROWSER_SOCKET_PATH, settings.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", settings.token)
  url.searchParams.set("projectId", projectId)
  if (sessionId) url.searchParams.set("sessionId", sessionId)
  return url.toString()
}

export type BrowserSocketStatus =
  /** Opening, or waiting to reopen after a drop. */
  | "connecting"
  | "open"
  /** Closed and not coming back on its own; `ended` says why. */
  | "ended"

/** Why the socket stopped. `retry` is whether a person pressing Reconnect has
    any chance -- a missing Chrome or project will not appear on a second try. */
export interface BrowserSocketEnd {
  code: number
  reason: string
  retry: boolean
}

export interface BrowserSocketState {
  status: BrowserSocketStatus
  /** Set when `status` is "ended". */
  ended: BrowserSocketEnd | null
  viewerId: string | null
  browserVersion: string | null
  tabs: BrowserTab[]
  /** The tab whose frames this viewer receives. */
  front: BrowserTabId | null
  dialogs: Record<BrowserTabId, BrowserDialog>
  agents: Record<BrowserTabId, BrowserAgentActivity>
  viewports: Record<BrowserTabId, Omit<BrowserViewportMessage, "type" | "tabId">>
  /** The last failed command, live only: cleared by the next one that works. */
  error: BrowserErrorMessage | null
}

const INITIAL: BrowserSocketState = {
  status: "connecting",
  ended: null,
  viewerId: null,
  browserVersion: null,
  tabs: [],
  front: null,
  dialogs: {},
  agents: {},
  viewports: {},
  error: null,
}

/** What the server's close codes mean to a person. Anything not here is a
    dropped connection, retried on its own. */
const ENDINGS: Record<number, { reason: string; retry: boolean }> = {
  [BROWSER_CLOSE.closed]: { reason: "The browser was closed.", retry: true },
  [BROWSER_CLOSE.unauthorized]: { reason: "The server refused the token.", retry: false },
  [BROWSER_CLOSE.unavailable]: { reason: "This server has no Chrome to run.", retry: false },
  [BROWSER_CLOSE.notFound]: { reason: "This project no longer exists.", retry: false },
  [BROWSER_CLOSE.limit]: { reason: "Too many browsers are running on this server.", retry: true },
}

/** Backoff for a dropped connection, then it gives up and offers a button. */
const RETRY_MS = [500, 1000, 2000, 4000, 8000]

export type FrameSink = (bitmap: ImageBitmap, header: BrowserFrameHeader) => void

export class BrowserSocket {
  private readonly url: string
  private ws: WebSocket | null = null
  private state: BrowserSocketState = INITIAL
  private readonly listeners = new Set<() => void>()
  private sink: FrameSink | null = null
  private decoding = false
  private pending: ArrayBuffer | null = null
  private latest: BrowserFrameHeader | null = null
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(url: string) {
    this.url = url
  }

  /* ── The store ── */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getState = (): BrowserSocketState => this.state

  private set(patch: Partial<BrowserSocketState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** The header of the newest frame drawn: the geometry pointer input is
      mapped through. Not state, because it changes at frame rate. */
  frame(): BrowserFrameHeader | null {
    return this.latest
  }

  /** Who draws frames. One at a time: the panel's canvas. */
  setFrameSink(sink: FrameSink | null) {
    this.sink = sink
  }

  /* ── The connection ── */

  connect() {
    if (this.disposed) return
    this.clearTimer()
    this.ws?.close(1000)
    this.set({ status: "connecting", ended: null })
    const ws = new WebSocket(this.url)
    ws.binaryType = "arraybuffer"
    this.ws = ws
    ws.onopen = () => {
      this.attempts = 0
    }
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) this.onFrame(event.data)
      else this.onMessage(String(event.data))
    }
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.ws = null
      const known = ENDINGS[event.code]
      if (known) return this.end(event.code, event.reason || known.reason, known.retry)
      if (this.attempts >= RETRY_MS.length)
        return this.end(event.code, event.reason || "Lost the connection to the browser.", true)
      const wait = RETRY_MS[this.attempts++]
      this.set({ status: "connecting" })
      this.timer = setTimeout(() => this.connect(), wait)
    }
  }

  /** Reconnect now, from the button: the backoff starts over. */
  reconnect() {
    this.attempts = 0
    this.connect()
  }

  private end(code: number, reason: string, retry: boolean) {
    this.set({ status: "ended", ended: { code, reason, retry } })
  }

  dispose() {
    this.disposed = true
    this.clearTimer()
    this.sink = null
    this.pending = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      /* 1000: a viewer leaving. The browser keeps running for the others. */
      ws.close(1000, "panel closed")
    }
    this.listeners.clear()
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Send a command. False when there is no open socket to send it on. */
  send(command: BrowserCommand): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(command))
    return true
  }

  /* ── Inbound ── */

  private onMessage(raw: string) {
    let message: BrowserServerMessage
    try {
      message = JSON.parse(raw) as BrowserServerMessage
    } catch {
      return
    }
    switch (message.type) {
      case "hello":
        if (message.version !== BROWSER_PROTOCOL_VERSION) {
          const ws = this.ws
          this.ws = null
          ws?.close(1000)
          this.end(0, `The server speaks browser protocol ${message.version}; this app speaks ${BROWSER_PROTOCOL_VERSION}.`, false)
          return
        }
        this.set({
          status: "open",
          viewerId: message.viewerId,
          browserVersion: message.browserVersion,
          /* A new socket is a new viewer: the server says everything again. */
          dialogs: {},
          agents: {},
          viewports: {},
          error: null,
        })
        return
      case "tabs": {
        const ids = new Set(message.tabs.map((tab) => tab.id))
        this.set({
          tabs: message.tabs,
          dialogs: keep(this.state.dialogs, ids),
          agents: keep(this.state.agents, ids),
          viewports: keep(this.state.viewports, ids),
        })
        return
      }
      case "front":
        if (message.tabId !== this.state.front) this.latest = null
        this.set({ front: message.tabId })
        return
      case "dialog":
        this.set({ dialogs: put(this.state.dialogs, message.tabId, message.dialog) })
        return
      case "agent":
        this.set({ agents: put(this.state.agents, message.tabId, message.activity) })
        return
      case "viewport": {
        const { type: _type, tabId, ...viewport } = message
        this.set({ viewports: put(this.state.viewports, tabId, viewport) })
        return
      }
      case "error":
        this.set({ error: message })
        return
    }
  }

  /** Clear the last error once the reader has seen it. */
  dismissError() {
    if (this.state.error) this.set({ error: null })
  }

  private onFrame(data: ArrayBuffer) {
    if (this.decoding) {
      this.pending = data
      return
    }
    void this.decode(data)
  }

  private async decode(data: ArrayBuffer) {
    const frame = decodeBrowserFrame(data)
    /* Another tab's frame, sent before the server switched: not ours to draw. */
    if (!frame || frame.header.tabId !== this.state.front) return this.next()
    this.decoding = true
    try {
      const bitmap = await createImageBitmap(new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }))
      if (this.disposed || frame.header.tabId !== this.state.front) bitmap.close()
      else {
        this.latest = frame.header
        if (this.sink) this.sink(bitmap, frame.header)
        else bitmap.close()
      }
    } catch {
      /* A truncated JPEG: the next frame replaces it. */
    } finally {
      this.decoding = false
      this.next()
    }
  }

  private next() {
    const pending = this.pending
    this.pending = null
    if (pending) void this.decode(pending)
  }
}

function put<T>(map: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const next = { ...map }
  if (value === null) delete next[key]
  else next[key] = value
  return next
}

function keep<T>(map: Record<string, T>, ids: Set<string>): Record<string, T> {
  const entries = Object.entries(map).filter(([id]) => ids.has(id))
  return entries.length === Object.keys(map).length ? map : Object.fromEntries(entries)
}
