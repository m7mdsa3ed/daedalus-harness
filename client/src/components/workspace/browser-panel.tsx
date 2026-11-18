/* ── The browser panel ──
   A window onto the project's headless Chrome (docs/plans/browser.md, Client).
   The browser and its tabs are the server's and shared: every panel on a
   project, every device and (phase 2) every agent see the same tabs, so this
   component owns nothing but a view -- which tab it is looking at, and the
   socket it looks through (`lib/workspace/browser-socket.ts`).

   The page is a canvas of screencast frames. Input goes the other way as
   commands mapped to CSS pixels by `lib/workspace/browser-input.ts`. While
   the canvas has the focus every key goes to the page, except the harness's
   own chorded shortcuts; IME and paste go through a hidden textarea as `text`.

   Gated twice: the server must speak it (`browserPanel`) and have a Chrome
   (`GET /api/browser/status`). A panel restored onto a server that has neither
   says which, rather than drawing a dead canvas. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  GlobeIcon,
  KeyboardIcon,
  MonitorSmartphoneIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react"
import {
  browserModifiers,
  type BrowserAgentActivity,
  type BrowserCommand,
  type BrowserDialog,
  type BrowserFrameHeader,
  type BrowserTab,
  type BrowserTabId,
} from "@daedalus/browser-protocol"

import { AgentIcon } from "@/components/entity-icon"
import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Logo } from "@/components/ui/logo"
import { PanelToolbar } from "@/components/workspace/primitives"
import { useCoarsePointer } from "@/hooks/use-device"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { useKeybindings } from "@/lib/keybindings"
import { useBrowserStatus } from "@/lib/queries/browser"
import { useAgents, useProjects } from "@/lib/queries/catalog"
import { loadSettings, serverName } from "@/lib/settings"
import { SHORTCUTS } from "@/lib/shortcuts"
import { useSessionMeta, useStoreSelect, useThread } from "@/lib/store"
import { cn } from "@/lib/utils"
import {
  addressToUrl,
  buttonsBit,
  elementToPage,
  elementToPageClamped,
  isComposing,
  isHarnessChord,
  isPasteChord,
  keyCommand,
  letterbox,
  mouseButton,
  nextClick,
  pageToElement,
  touchGesture,
  TOUCH,
  wheelCommand,
  type ClickTracker,
  type FrameGeometry,
  type TouchGesture,
} from "@/lib/workspace/browser-input"
import { BrowserSocket, browserSocketUrl, type BrowserSocketState } from "@/lib/workspace/browser-socket"
import { usePublishPanelStatus } from "@/lib/workspace/panel-status"
import { useThreadDockSession } from "@/lib/workspace/thread-docks"

type Params = { projectId: string; viewId: string; tabId?: string }
/** `actions` is how the agent badge pauses the thread that is driving; both
    docks hand it in, and without it the badge draws no control. */
type PanelProps = IDockviewPanelProps<Params> & { actions?: Actions }

/** How long a panel's size has to hold still before the page is resized to it:
    a sash drag would otherwise re-lay the page out every frame. */
const VIEWPORT_DEBOUNCE_MS = 150

export function BrowserPanel(props: PanelProps) {
  const status = useBrowserStatus()
  if (!status.enabled)
    return (
      <Unavailable
        title="This server has no browser panel"
        detail="It was saved by a build whose server runs one. Update the server to use it here."
      />
    )
  if (status.isPending) return <div className="h-full pt-[var(--dock-content-overlap,var(--app-header-h))]" />
  if (status.error)
    return (
      <div className="h-full p-3 pt-[calc(var(--dock-content-overlap,var(--app-header-h))+0.75rem)]">
        <Notice tone="error" title="Couldn't ask the server about its browser">
          {status.error.message}
        </Notice>
      </div>
    )
  if (!status.data.available)
    return <Unavailable title="No browser on this server" detail={status.data.reason} />
  return <BrowserView {...props} />
}

function Unavailable({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-2.5 pt-[var(--dock-content-overlap,var(--app-header-h))]">
      <Empty size="lg" icon={GlobeIcon} className="max-w-md text-foreground" action={action}>
        <span className="block font-medium">{title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{detail}</span>
      </Empty>
    </div>
  )
}

function useSocketState(socket: BrowserSocket): BrowserSocketState {
  return React.useSyncExternalStore(socket.subscribe, socket.getState, socket.getState)
}

function BrowserView({ api, params, actions }: PanelProps) {
  const { projectId } = params
  const sessionId = useThreadDockSession()
  const project = useProjects().find((candidate) => candidate.id === projectId)
  const coarse = useCoarsePointer()

  /* One socket per panel, for the panel's life. Recreated only if the project
     or the thread it reports to changes, which is a different viewer. Made in
     the effect, not a memo: a disposed socket cannot reopen, and StrictMode's
     second mount would otherwise be handed the one the first cleanup closed. */
  const [socket, setSocket] = React.useState<BrowserSocket | null>(null)
  const connected = !!loadSettings()
  React.useEffect(() => {
    const settings = loadSettings()
    if (!settings) return
    const next = new BrowserSocket(browserSocketUrl(settings, projectId, sessionId))
    next.connect()
    setSocket(next)
    return () => {
      next.dispose()
      setSocket((current) => (current === next ? null : current))
    }
  }, [projectId, sessionId])

  if (!connected) return <Unavailable title="Not connected" detail="Connect to a server to use its browser." />
  if (!socket) return <div className="h-full pt-[var(--dock-content-overlap,var(--app-header-h))]" />
  return (
    <BrowserSurface
      api={api}
      params={params}
      socket={socket}
      projectName={project?.name}
      coarse={coarse}
      actions={actions}
    />
  )
}

function BrowserSurface({
  api,
  params,
  socket,
  projectName,
  coarse,
  actions,
}: Pick<IDockviewPanelProps<Params>, "api" | "params"> & {
  socket: BrowserSocket
  projectName?: string
  coarse: boolean
  actions?: Actions
}) {
  const state = useSocketState(socket)
  const { tabs, front } = state
  const frontTab = tabs.find((tab) => tab.id === front) ?? null
  const dialog = front ? state.dialogs[front] : undefined
  const activity = front ? state.agents[front] : undefined
  const driver = useDriver(activity ?? null, front)
  const viewport = front ? state.viewports[front] : undefined
  const agentOwnsViewport = viewport?.owner.kind === "agent"

  const send = React.useCallback((command: BrowserCommand) => socket.send(command), [socket])

  /* ── Which tab this panel is looking at ──
     The descriptor remembers it, so a reload comes back to the same page. On
     each connection the remembered tab is asked for quietly (`watch`), which
     moves nothing for anybody else; picking one from the strip is `select`. */
  const wanted = React.useRef<BrowserTabId | undefined>(params.tabId)
  const asked = React.useRef(false)
  React.useEffect(() => {
    if (state.status !== "open") {
      asked.current = false
      return
    }
    if (asked.current || !tabs.length) return
    asked.current = true
    const id = wanted.current
    if (id && id !== front && tabs.some((tab) => tab.id === id)) send({ type: "watch", tabId: id })
  }, [state.status, tabs, front, send])
  /* The descriptor can also be pointed from outside — the thread dock does it
     when an agent lands on a tab (`browser_activity`). That tab is watched,
     and until this view is on it the descriptor is not written back with the
     tab it is leaving. A tab that is not (or no longer) in the strip gives the
     pointing up rather than holding the descriptor forever. */
  const written = React.useRef<BrowserTabId | undefined>(params.tabId)
  const pointed = React.useRef<{ tabId: BrowserTabId; watched: boolean } | null>(null)
  if (params.tabId !== written.current) {
    written.current = params.tabId
    if (params.tabId) {
      wanted.current = params.tabId
      pointed.current = { tabId: params.tabId, watched: false }
    }
  }
  React.useEffect(() => {
    const target = pointed.current
    if (target) {
      const listed = tabs.some((tab) => tab.id === target.tabId)
      if (front === target.tabId) pointed.current = null
      else if (state.status !== "open") target.watched = false
      else if (listed && !target.watched) {
        target.watched = true
        send({ type: "watch", tabId: target.tabId })
      } else if (!listed && tabs.length) pointed.current = null
      if (pointed.current) return
    }
    if (!front || front === params.tabId) return
    wanted.current = front
    written.current = front
    api.updateParameters({ ...params, tabId: front })
  }, [api, front, params, state.status, tabs, send])

  /* A hidden panel stops its frames; showing it again asks for them back. */
  React.useEffect(() => {
    const sub = api.onDidVisibilityChange(({ isVisible }) => {
      if (socket.getState().status !== "open") return
      const tabId = wanted.current ?? socket.getState().front
      if (isVisible && !tabId) return
      send({ type: "watch", tabId: isVisible ? tabId : null })
    })
    return () => sub.dispose()
  }, [api, socket, send])

  /* ── Title and status ── */
  React.useEffect(() => {
    api.setTitle(frontTab?.title?.trim() || hostOf(frontTab?.url) || "Browser")
  }, [api, frontTab?.title, frontTab?.url])
  usePublishPanelStatus(
    api.id,
    state.status === "ended"
      ? { tone: "warn", label: state.ended?.reason ?? "The browser disconnected" }
      : dialog
        ? { tone: "attention", label: "The page is asking something" }
        : frontTab?.loading
          ? { tone: "running", label: "Loading" }
          : null
  )

  /* ── Viewport ──
     The page is sized to the panel that last had input. An agent's size wins
     until a person resizes this panel or presses Reset: opening or focusing a
     panel is not disagreeing with it. */
  const surfaceRef = React.useRef<HTMLDivElement | null>(null)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const sizeRef = React.useRef(size)
  sizeRef.current = size
  const agentOwnsRef = React.useRef(agentOwnsViewport)
  agentOwnsRef.current = agentOwnsViewport
  const viewportRef = React.useRef(viewport)
  viewportRef.current = viewport
  const viewerIdRef = React.useRef(state.viewerId)
  viewerIdRef.current = state.viewerId

  const sendViewport = React.useCallback(
    (force: boolean) => {
      const { width, height } = sizeRef.current
      if (width < 1 || height < 1) return
      if (!force && agentOwnsRef.current) return
      send({ type: "viewport", width: Math.round(width), height: Math.round(height), dpr: window.devicePixelRatio || 1 })
    },
    [send]
  )
  /* Before input: take the viewport back from another *panel*, never from an agent. */
  const claimViewport = React.useCallback(() => {
    const current = viewportRef.current
    if (current?.owner.kind === "viewer" && current.owner.viewerId !== viewerIdRef.current) sendViewport(false)
  }, [sendViewport])

  React.useEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let first = true
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }))
      sizeRef.current = { width, height }
      clearTimeout(timer)
      const forced = !first
      first = false
      timer = setTimeout(() => sendViewport(forced), VIEWPORT_DEBOUNCE_MS)
    })
    observer.observe(el)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [sendViewport])
  /* A new connection, or a new tab in front, is told this panel's size. */
  React.useEffect(() => {
    if (state.status === "open" && front) sendViewport(false)
  }, [state.status, front, sendViewport])

  /* ── Frames ── */
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const bitmapRef = React.useRef<{ bitmap: ImageBitmap; header: BrowserFrameHeader } | null>(null)
  const [geometry, setGeometry] = React.useState<FrameGeometry | null>(null)

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current
    const { width, height } = sizeRef.current
    if (!canvas || width < 1 || height < 1) return
    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(width * dpr)
    const ph = Math.round(height * dpr)
    if (canvas.width !== pw) canvas.width = pw
    if (canvas.height !== ph) canvas.height = ph
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, pw, ph)
    const frame = bitmapRef.current
    if (!frame) return
    const box = letterbox(width, height, frame.header.deviceWidth, frame.header.deviceHeight)
    if (box.scale <= 0) return
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(frame.bitmap, box.x * dpr, box.y * dpr, box.width * dpr, box.height * dpr)
  }, [])

  React.useEffect(() => {
    socket.setFrameSink((bitmap, header) => {
      bitmapRef.current?.bitmap.close()
      bitmapRef.current = { bitmap, header }
      draw()
      setGeometry((current) =>
        current &&
        current.deviceWidth === header.deviceWidth &&
        current.deviceHeight === header.deviceHeight &&
        current.offsetTop === header.offsetTop &&
        current.pageScaleFactor === header.pageScaleFactor
          ? current
          : {
              deviceWidth: header.deviceWidth,
              deviceHeight: header.deviceHeight,
              offsetTop: header.offsetTop,
              pageScaleFactor: header.pageScaleFactor,
            }
      )
    })
    return () => {
      socket.setFrameSink(null)
      bitmapRef.current?.bitmap.close()
      bitmapRef.current = null
    }
  }, [socket, draw])
  React.useEffect(draw, [draw, size])
  /* Another tab in front: its first frame is not this one. */
  React.useEffect(() => {
    bitmapRef.current?.bitmap.close()
    bitmapRef.current = null
    setGeometry(null)
    draw()
  }, [front, draw])

  /* ── Pointer ── */
  const keysRef = React.useRef<HTMLTextAreaElement | null>(null)
  const focusKeys = React.useCallback(() => keysRef.current?.focus({ preventScroll: true }), [])
  const toPage = React.useCallback((clientX: number, clientY: number, clamp: boolean) => {
    const canvas = canvasRef.current
    const frame = socket.frame()
    if (!canvas || !frame) return null
    const rect = canvas.getBoundingClientRect()
    const map = clamp ? elementToPageClamped : elementToPage
    return map(clientX - rect.left, clientY - rect.top, rect.width, rect.height, frame)
  }, [socket])

  const clicks = React.useRef<ClickTracker | null>(null)
  const pressed = React.useRef<{ button: number; count: number } | null>(null)
  const moveFrame = React.useRef<number | null>(null)
  const lastMove = React.useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(null)
  const touch = React.useRef<{
    id: number
    start: { x: number; y: number; at: number }
    last: { x: number; y: number }
    gesture: TouchGesture
    timer: ReturnType<typeof setTimeout>
  } | null>(null)

  const mouse = React.useCallback(
    (
      event: "mousePressed" | "mouseReleased" | "mouseMoved",
      point: { x: number; y: number },
      button: number,
      buttons: number,
      clickCount: number,
      modifiers: number
    ) => {
      if (!front) return
      send({
        type: "mouse",
        tabId: front,
        event,
        x: point.x,
        y: point.y,
        button: button < 0 ? "none" : mouseButton(button),
        buttons,
        clickCount,
        modifiers,
      })
    },
    [front, send]
  )

  const heldButton = (buttons: number) => (buttons & 1 ? 0 : buttons & 2 ? 2 : buttons & 4 ? 1 : -1)

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!front || dialog) return
    focusKeys()
    claimViewport()
    const point = toPage(event.clientX, event.clientY, false)
    if (!point) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    if (event.pointerType === "touch") {
      if (touch.current) return
      const start = { x: event.clientX, y: event.clientY, at: event.timeStamp }
      const id = event.pointerId
      touch.current = {
        id,
        start,
        last: { x: event.clientX, y: event.clientY },
        gesture: "pending",
        /* Held still: a right click where the finger is. */
        timer: setTimeout(() => {
          const t = touch.current
          if (!t || t.id !== id || t.gesture !== "pending") return
          t.gesture = "long-press"
          mouse("mousePressed", point, 2, 2, 1, 0)
          mouse("mouseReleased", point, 2, 0, 1, 0)
        }, TOUCH.longPressMs),
      }
      return
    }
    const modifiers = browserModifiers(event)
    clicks.current = nextClick(clicks.current, {
      at: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
      button: event.button,
    })
    pressed.current = { button: event.button, count: clicks.current.count }
    mouse("mousePressed", point, event.button, event.buttons || buttonsBit(event.button), clicks.current.count, modifiers)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!front || dialog) return
    if (event.pointerType === "touch") {
      const t = touch.current
      if (!t || t.id !== event.pointerId) return
      const now = { x: event.clientX, y: event.clientY, at: event.timeStamp }
      t.gesture = touchGesture(t.gesture, t.start, now)
      if (t.gesture !== "drag") return
      clearTimeout(t.timer)
      /* One finger scrolls: the page moves with it, so the wheel goes the
         other way, measured in page pixels. */
      const from = toPage(t.last.x, t.last.y, true)
      const to = toPage(now.x, now.y, true)
      t.last = { x: now.x, y: now.y }
      if (!from || !to) return
      send({ type: "wheel", tabId: front, x: to.x, y: to.y, deltaX: from.x - to.x, deltaY: from.y - to.y, modifiers: 0 })
      return
    }
    const point = toPage(event.clientX, event.clientY, event.buttons !== 0)
    if (!point) return
    /* Coalesced to one per frame: a mouse reports far more often than the
       screencast can show, and every move is a round trip to Chrome. */
    lastMove.current = { ...point, buttons: event.buttons, modifiers: browserModifiers(event) }
    if (moveFrame.current !== null) return
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null
      const move = lastMove.current
      if (!move) return
      mouse("mouseMoved", move, heldButton(move.buttons), move.buttons, 0, move.modifiers)
    })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!front) return
    if (event.pointerType === "touch") {
      const t = touch.current
      if (!t || t.id !== event.pointerId) return
      clearTimeout(t.timer)
      touch.current = null
      if (t.gesture !== "pending" || event.type === "pointercancel") return
      /* A tap is a click. */
      const point = toPage(t.start.x, t.start.y, false)
      if (!point || dialog) return
      clicks.current = nextClick(clicks.current, { at: event.timeStamp, x: t.start.x, y: t.start.y, button: 0 })
      mouse("mousePressed", point, 0, 1, clicks.current.count, 0)
      mouse("mouseReleased", point, 0, 0, clicks.current.count, 0)
      return
    }
    const down = pressed.current
    if (!down || down.button !== event.button) return
    pressed.current = null
    const point = toPage(event.clientX, event.clientY, true)
    if (!point) return
    mouse("mouseReleased", point, event.button, event.buttons, down.count, browserModifiers(event))
  }

  React.useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current)
      if (touch.current) clearTimeout(touch.current.timer)
    },
    []
  )

  /* The wheel needs a non-passive listener to keep the panel from scrolling. */
  const frontRef = React.useRef(front)
  frontRef.current = front
  const dialogRef = React.useRef(dialog)
  dialogRef.current = dialog
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      const tabId = frontRef.current
      if (!tabId || dialogRef.current) return
      const point = toPage(event.clientX, event.clientY, false)
      if (!point) return
      event.preventDefault()
      send(wheelCommand(tabId, point, event, sizeRef.current.height))
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [toPage, send])

  /* ── Keys ──
     Everything to the page except the harness's own window-level chords --
     tab switching, the palette, splits -- which are left alone so the window
     listener still sees them. Thread, composer and editor chords are not
     withheld: the page is the thing being typed into, and Ctrl+Enter or
     Ctrl+F there mean the page's. */
  const binds = useKeybindings()
  const chords = React.useMemo(
    () => SHORTCUTS.filter((def) => def.scope === "Global").flatMap((def) => binds[def.id]?.chords ?? []),
    [binds]
  )
  const down = React.useRef(new Set<string>())
  const composing = React.useRef(false)

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!front || dialog) return
    const native = event.nativeEvent
    if (composing.current || isComposing(native)) return
    if (isHarnessChord(native, chords)) return
    /* Left to the browser so a `paste` event fires with *this* clipboard. */
    if (isPasteChord(native)) return
    if (native.key === "Escape" && native.shiftKey) {
      /* The way out of the page for the keyboard: Shift+Esc gives the focus back. */
      event.preventDefault()
      keysRef.current?.blur()
      return
    }
    event.preventDefault()
    claimViewport()
    down.current.add(native.code || native.key)
    send(keyCommand(front, native, "keyDown"))
  }
  const onKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!front) return
    const native = event.nativeEvent
    const id = native.code || native.key
    if (!down.current.delete(id)) return
    event.preventDefault()
    send(keyCommand(front, native, "keyUp"))
  }
  /* A key up the page never saw (the focus left mid-press) would leave a key
     held down in Chrome. */
  const onBlur = () => {
    if (!front) return down.current.clear()
    for (const code of down.current) send({ type: "key", tabId: front, event: "keyUp", key: "", code, modifiers: 0 })
    down.current.clear()
  }
  const sendText = (text: string) => {
    if (front && text) send({ type: "text", tabId: front, text })
  }
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault()
    sendText(event.clipboardData.getData("text/plain"))
  }
  const onCompositionEnd = (event: React.CompositionEvent<HTMLTextAreaElement>) => {
    composing.current = false
    sendText(event.data)
    event.currentTarget.value = ""
  }
  /* What arrives without a keydown we could translate: a soft keyboard's
     keyCode-229 presses, autocorrect, dictation. */
  const onInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    if (composing.current) return
    const value = event.currentTarget.value
    event.currentTarget.value = ""
    sendText(value)
  }
  const [focused, setFocused] = React.useState(false)
  /* On a touch screen a tap must not raise the keyboard over the page; it is
     asked for with the toolbar's keyboard button. */
  const [softKeyboard, setSoftKeyboard] = React.useState(false)

  /* ── Navigation ── */
  const [address, setAddress] = React.useState<string | null>(null)
  const go = (text: string) => {
    const url = addressToUrl(text)
    if (!url) return
    setAddress(null)
    if (front) send({ type: "navigate", tabId: front, action: "url", url })
    else send({ type: "tab", action: "new", url })
    focusKeys()
  }
  const history = (action: "back" | "forward" | "reload" | "stop") => {
    if (front) send({ type: "navigate", tabId: front, action })
  }

  const settings = loadSettings()
  const where = settings ? serverName(settings.url) : "the server"
  const connecting = state.status === "connecting"

  return (
    <div className="flex h-full min-h-0 flex-col pt-[var(--dock-content-overlap,var(--app-header-h))]">
      <TabStrip
        tabs={tabs}
        front={front}
        agents={state.agents}
        onSelect={(tabId) => {
          wanted.current = tabId
          send({ type: "tab", action: "select", tabId })
        }}
        onClose={(tabId) => send({ type: "tab", action: "close", tabId })}
        onNew={() => send({ type: "tab", action: "new" })}
        disabled={state.status !== "open"}
      />
      <PanelToolbar>
        <Button size="icon-xs" variant="ghost" aria-label="Back" title="Back" disabled={!front} onClick={() => history("back")}>
          <ArrowLeftIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Forward"
          title="Forward"
          disabled={!front}
          onClick={() => history("forward")}
        >
          <ArrowRightIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={frontTab?.loading ? "Stop" : "Reload"}
          title={frontTab?.loading ? "Stop" : "Reload"}
          disabled={!front}
          onClick={() => history(frontTab?.loading ? "stop" : "reload")}
        >
          {frontTab?.loading ? <XIcon /> : <RotateCwIcon />}
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            go(address ?? frontTab?.url ?? "")
          }}
        >
          <Input
            aria-label="Address"
            /* Says where the page is running, because it is not this machine:
               `localhost` here is the server's. */
            placeholder={`Search or type a URL · browsing from ${where}`}
            className="h-6 rounded-md px-2 text-xs md:text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={address ?? (frontTab && frontTab.url !== "about:blank" ? frontTab.url : "")}
            disabled={state.status !== "open"}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setAddress(null)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                setAddress(null)
                focusKeys()
              }
            }}
          />
        </form>
        {agentOwnsViewport && viewport && (
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 gap-1 text-xs text-muted-foreground"
            title="An agent set this page's size. Reset fits it to this panel."
            onClick={() => sendViewport(true)}
          >
            <MonitorSmartphoneIcon />
            <span className="tabular-nums">
              {viewport.width}×{viewport.height}
            </span>
            <span className="text-foreground">Reset</span>
          </Button>
        )}
        {coarse && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Keyboard"
            aria-pressed={softKeyboard}
            title="Type into the page"
            className={cn(softKeyboard && "bg-muted text-foreground")}
            onClick={() => {
              const next = !softKeyboard
              setSoftKeyboard(next)
              if (next) requestAnimationFrame(focusKeys)
              else keysRef.current?.blur()
            }}
          >
            <KeyboardIcon />
          </Button>
        )}
      </PanelToolbar>

      <div
        ref={surfaceRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-muted/40 outline-none",
          focused && "ring-1 ring-inset ring-ring/60"
        )}
      >
        {frontTab?.loading && <LoadingBar />}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={frontTab ? `Page: ${frontTab.title || frontTab.url}` : "Browser page"}
          className="absolute inset-0 size-full touch-none select-none outline-none"
          onFocus={focusKeys}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(event) => event.preventDefault()}
        />
        {/* The keyboard's way in: focused while the page is, invisible, and
            the only element IME and the soft keyboard can target. */}
        <textarea
          ref={keysRef}
          aria-label="Keyboard input to the page"
          className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode={coarse && !softKeyboard ? "none" : "text"}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPaste={onPaste}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={onCompositionEnd}
          onInput={onInput}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            setSoftKeyboard(false)
            onBlur()
          }}
        />
        {driver && geometry && (
          <AgentOverlay
            activity={driver}
            live={!!activity}
            geometry={geometry}
            width={size.width}
            height={size.height}
            actions={actions}
          />
        )}
        {dialog && front && (
          <DialogSheet
            key={front}
            dialog={dialog}
            onAnswer={(accept, promptText) => {
              send({ type: "dialog", tabId: front, accept, ...(promptText !== undefined ? { promptText } : {}) })
              focusKeys()
            }}
          />
        )}
        {state.status === "open" && !tabs.length && (
          <div className="absolute inset-0 flex items-center justify-center p-3">
            <Empty
              icon={GlobeIcon}
              action={
                <Button size="sm" variant="outline" onClick={() => send({ type: "tab", action: "new" })}>
                  <PlusIcon /> New tab
                </Button>
              }
            >
              No tabs open in {projectName ?? "this project"}'s browser.
            </Empty>
          </div>
        )}
        {connecting && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1 text-xs text-primary shadow-sm">
            <Logo working className="size-3.5 shrink-0" />
            <span className="harness-shimmer">connecting…</span>
          </div>
        )}
        {state.status === "ended" && state.ended && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-3">
            <Empty
              size="lg"
              icon={WifiOffIcon}
              className="max-w-md bg-background text-foreground"
              action={
                state.ended.retry ? (
                  <Button size="sm" variant="outline" onClick={() => socket.reconnect()}>
                    <RotateCwIcon /> Reconnect
                  </Button>
                ) : undefined
              }
            >
              <span className="block font-medium">The browser is not connected</span>
              <span className="mt-1 block text-xs text-muted-foreground">{state.ended.reason}</span>
            </Empty>
          </div>
        )}
        {state.error && (
          <div className="absolute inset-x-2 bottom-2">
            <Notice
              tone="error"
              action={
                <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => socket.dismissError()}>
                  <XIcon />
                </Button>
              }
            >
              {state.error.message}
            </Notice>
          </div>
        )}
      </div>
    </div>
  )
}

function hostOf(url: string | undefined): string {
  if (!url || url === "about:blank") return ""
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/* ── The strip ──
   The browser's tabs, which are the project's and not this panel's: closing
   one here closes it for every viewer. The look is the Preview panel's file
   strip (`web-panel.tsx`), so the two read as the same kind of row. */
function TabStrip({
  tabs,
  front,
  agents,
  onSelect,
  onClose,
  onNew,
  disabled,
}: {
  tabs: BrowserTab[]
  front: BrowserTabId | null
  agents: Record<BrowserTabId, BrowserAgentActivity>
  onSelect: (tabId: BrowserTabId) => void
  onClose: (tabId: BrowserTabId) => void
  onNew: () => void
  disabled: boolean
}) {
  return (
    <div role="tablist" aria-label="Browser tabs" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b">
      {tabs.map((tab) => {
        const active = tab.id === front
        const label = tab.title?.trim() || hostOf(tab.url) || "New tab"
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            title={tab.url}
            className={cn(
              "group/tab flex h-8 max-w-48 shrink-0 items-center gap-1 border-r pr-1 pl-2.5 text-xs",
              active ? "bg-background font-medium" : "text-muted-foreground hover:bg-muted/60"
            )}
          >
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 outline-none"
              onClick={() => onSelect(tab.id)}
            >
              <TabMark tab={tab} driving={!!agents[tab.id]} />
              <span className="truncate">{label}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${label}`}
              title="Close tab"
              className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
              onClick={() => onClose(tab.id)}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        aria-label="New tab"
        title="New tab"
        disabled={disabled}
        className="flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
        onClick={onNew}
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  )
}

function TabMark({ tab, driving }: { tab: BrowserTab; driving: boolean }) {
  const [broken, setBroken] = React.useState(false)
  if (tab.loading) return <Logo working className="size-3.5 shrink-0" />
  if (driving || tab.openedBy.kind === "agent")
    return <BotIcon aria-label="Opened by an agent" className={cn("size-3.5 shrink-0", driving && "text-primary")} />
  if (tab.favicon && !broken)
    return <img src={tab.favicon} alt="" className="size-3.5 shrink-0" onError={() => setBroken(true)} />
  return <GlobeIcon className="size-3.5 shrink-0" />
}

function LoadingBar() {
  return (
    <div aria-hidden className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-primary/15">
      <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
    </div>
  )
}

/* ── The agent overlay ──
   A ring on the element an agent is acting on, and a badge naming who. The
   server sets an action's record when it starts and clears it when it ends,
   so the live record lasts as long as one click; a badge drawn from it alone
   would flash and its Pause would be out of reach. So the badge is kept
   (`useDriver`) while the thread that drove is still working — a turn open or
   held — and for a beat after; only the ring is the live record's. */
const DRIVER_LINGER_MS = 4_000

function useDriver(activity: BrowserAgentActivity | null, front: BrowserTabId | null): BrowserAgentActivity | null {
  const [held, setHeld] = React.useState<BrowserAgentActivity | null>(null)
  const working = useStoreSelect((state) => {
    const thread = held ? state.threads[held.sessionId] : undefined
    return !!thread && (thread.turnActive || thread.paused)
  })
  React.useEffect(() => {
    if (activity) {
      setHeld(activity)
      return
    }
    if (!held || working) return
    const timer = window.setTimeout(() => setHeld(null), DRIVER_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [activity, held, working])
  if (activity) return activity
  return held && held.tabId === front ? held : null
}

function AgentOverlay({
  activity,
  live,
  geometry,
  width,
  height,
  actions,
}: {
  activity: BrowserAgentActivity
  /** An action is running now, not just recently. */
  live: boolean
  geometry: FrameGeometry
  width: number
  height: number
  actions?: Actions
}) {
  const ring = live && activity.rect ? pageToElement(activity.rect, width, height, geometry) : null
  return (
    <div aria-live="polite" className="pointer-events-none absolute inset-0 z-10">
      {ring && (
        <div
          className="absolute rounded-sm ring-2 ring-primary ring-offset-1 ring-offset-background/40 transition-all duration-150"
          style={{ left: ring.x, top: ring.y, width: ring.width, height: ring.height }}
        />
      )}
      <AgentBadge activity={activity} live={live} actions={actions} />
    </div>
  )
}

function AgentBadge({
  activity,
  live,
  actions,
}: {
  activity: BrowserAgentActivity
  live: boolean
  actions?: Actions
}) {
  const meta = useSessionMeta(activity.sessionId)
  const agent = useAgents().find((candidate) => candidate.id === meta?.agentId)
  const who = agent?.name ?? "An agent"
  return (
    <div className="pointer-events-auto absolute top-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md border bg-background/95 py-1 ps-2 pe-1 text-xs shadow-sm">
      <AgentIcon agentId={meta?.agentId} className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        <span className="font-medium">{who} is driving</span>
        {meta?.title ? <span className="text-muted-foreground"> · {meta.title}</span> : null}
      </span>
      {live && <span className="shrink-0 text-muted-foreground">{activity.action}</span>}
      {actions && <PauseAgent sessionId={activity.sessionId} actions={actions} />}
    </div>
  )
}

/* The composer's own pause toggle, on the thread that is driving: the same
   two actions, the same condition (`canPause` and a turn open or held), the
   same rule that a resume records its own failure in the thread. Nothing at
   all where the runtime cannot pause — Stop is the transcript's. */
function PauseAgent({ sessionId, actions }: { sessionId: string; actions: Actions }) {
  const thread = useThread(sessionId)
  if (!thread.canPause || !(thread.turnActive || thread.paused)) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn("shrink-0", thread.paused ? "text-primary hover:text-primary" : "text-muted-foreground")}
      title={thread.paused ? "Let the agent go on" : "Hold the agent at its next step"}
      onClick={() =>
        thread.paused
          ? actions.resume(sessionId).catch(() => {})
          : actions.pause(sessionId).catch((err) => reportError(err, "Couldn't pause the turn"))
      }
    >
      {thread.paused ? <PlayIcon /> : <PauseIcon />}
      {thread.paused ? "Resume" : "Pause agent"}
    </Button>
  )
}

/* ── A JavaScript dialog ──
   The page is blocked until it is answered, so the answer is in front of it:
   a sheet over the bottom of the canvas, not a modal over the app. */
function DialogSheet({
  dialog,
  onAnswer,
}: {
  dialog: BrowserDialog
  onAnswer: (accept: boolean, promptText?: string) => void
}) {
  const [text, setText] = React.useState(dialog.defaultValue ?? "")
  const confirmRef = React.useRef<HTMLButtonElement | null>(null)
  React.useEffect(() => {
    if (dialog.type !== "prompt") confirmRef.current?.focus()
  }, [dialog.type])
  const heading =
    dialog.type === "beforeunload"
      ? "Leave this page?"
      : dialog.type === "confirm"
        ? "The page asks you to confirm"
        : dialog.type === "prompt"
          ? "The page asks for an answer"
          : "The page says"
  return (
    <div className="absolute inset-0 z-20 flex items-end justify-center bg-background/40 p-3">
      <form
        role="alertdialog"
        aria-label={heading}
        className="w-full max-w-md rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        onSubmit={(event) => {
          event.preventDefault()
          onAnswer(true, dialog.type === "prompt" ? text : undefined)
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && dialog.type !== "alert") {
            event.preventDefault()
            onAnswer(false)
          }
        }}
      >
        <div className="text-xs font-medium text-muted-foreground">{heading}</div>
        {dialog.message && <p className="mt-1 text-sm break-words whitespace-pre-wrap">{dialog.message}</p>}
        {dialog.type === "prompt" && (
          <Input autoFocus className="mt-2" value={text} onChange={(event) => setText(event.target.value)} />
        )}
        <div className="mt-3 flex justify-end gap-2">
          {dialog.type !== "alert" && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onAnswer(false)}>
              {dialog.type === "beforeunload" ? "Stay" : "Cancel"}
            </Button>
          )}
          <Button ref={confirmRef} type="submit" size="sm">
            {dialog.type === "beforeunload" ? "Leave" : "OK"}
          </Button>
        </div>
      </form>
    </div>
  )
}
