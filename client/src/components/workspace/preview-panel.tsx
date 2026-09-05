/* ── Preview ──
   The Browser panel looking at a project's own managed dev server
   (`viewId: "preview"`). Same frame, same sandbox, same viewport presets as
   the ordinary web panel — what differs is where the address comes from and
   what sits around the frame.

   **The address is derived, never stored.** `DevStatus.url` is a
   server-relative root carrying a key minted per boot; it is resolved against
   the connection at render (`previewUrl`) and combined with the in-app path
   the bridge reports. Nothing here writes it to the panel's params, so a
   layout restored tomorrow asks the server again rather than framing a key
   that no longer opens anything.

   **Opening the panel starts the server.** A preview with a stopped server in
   it is a control that asks to be pressed before it does anything; the panel
   presses it, once per mount, and only from `off` — a server that *failed*
   or *exited* stays that way until someone reads why, because a restart loop
   against a broken command is just the failure again, faster.

   **The frame talks, the panel listens — carefully.** The bridge the proxy
   injects posts `daedalus:*` messages; the panel accepts one only when
   `event.source` is its own frame's window (the sandbox makes the origin
   opaque, so that is the whole check) and parses every field before trusting
   it. Errors from inside the page and errors the server read off a process
   are one list, and one click hands any of them to the project's thread as a
   prompt; a picked element lands in that thread's composer as a line; the
   console the page writes is drawn in a drawer, line by line, with a way to
   hand one of those over too.

   **Auto-fix is a loop with a ceiling.** Switched on, a new error is sent to
   the thread on its own once the thread is idle — and the same error is sent
   at most twice (`AUTO_FIX_ROUNDS`), which is where Lovable and Replit both
   stopped, for the reason that a third round is the agent arguing with
   itself. The ledger is keyed by `errorSignature`, so a reload re-reporting
   the same failure is not a fresh round.

   **History is the repository, and restore is a commit.** The drawer lists
   the project's commits — the persona commits after every change, so they
   read as the user's own asks — and Restore makes a new commit with the old
   tree (never a reset). Checkpoint commits whatever is uncommitted under a
   name, which is how a working state gets pinned before a risky ask. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  FlagIcon,
  HistoryIcon,
  MonitorIcon,
  PackageCheckIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SendIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SquareDashedMousePointerIcon,
  SquareIcon,
  SquareTerminalIcon,
  TabletIcon,
  TriangleAlertIcon,
  Undo2Icon,
  WandSparklesIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react"

import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useDock } from "@/components/workspace/dock"
import { PanelEmptyState, PanelToolbar } from "@/components/workspace/primitives"
import type { Actions } from "@/lib/actions"
import { appendDraft } from "@/lib/drafts"
import { inlineFromQuery, reportError } from "@/lib/errors"
import { useProjects } from "@/lib/queries/catalog"
import { useDevAction, useDevStatus } from "@/lib/queries/dev-server"
import { useHistoryAction, useProjectHistory } from "@/lib/queries/history"
import { currentThreadId } from "@/lib/router"
import { useServer } from "@/lib/server-context"
import { activityAt, isTopLevel, type DevStatus, type DevTask, type GitCommit } from "@/lib/settings"
import { useStoreHandle } from "@/lib/store"
import { shortAge } from "@/lib/time"
import { toast } from "@/lib/toast"
import { Logo } from "@/components/ui/logo"
import { cn } from "@/lib/utils"
import { DEV_STATE_LABEL, previewUrl } from "@/lib/workspace/dev-server"
import { usePublishPanelStatus } from "@/lib/workspace/panel-status"
import {
  consolePrompt,
  errorSignature,
  fixPrompt,
  parsePreviewMessage,
  pickLine,
  previewErrorFromMessage,
  previewErrorFromTerminal,
  type ConsoleLevel,
  type ConsoleLine,
  type ParentMessage,
  type PreviewError,
} from "@/lib/workspace/preview-bridge"

/** Identical to the web panel's, on purpose — see the note there. No
    `allow-same-origin`: the preview is served from the harness's own origin,
    and a page the user is writing must not be able to read the app's
    storage or its token. */
const SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads"

const VIEWPORTS = [
  { id: "desktop", label: "Desktop", icon: MonitorIcon, width: null },
  { id: "tablet", label: "Tablet", icon: TabletIcon, width: 834 },
  { id: "mobile", label: "Mobile", icon: SmartphoneIcon, width: 390 },
] as const

type ViewportId = (typeof VIEWPORTS)[number]["id"]

/** How many times auto-fix will send one error before it stops and says so. */
const AUTO_FIX_ROUNDS = 2
/** How long a burst of errors is collected before auto-fix sends them as one. */
const AUTO_FIX_DEBOUNCE_MS = 1500
/** Console lines kept per page load. */
const CONSOLE_MAX = 300

/** The pill's tone per state. Amber while something is in progress, green
    for live, red for a failure, plain for stopped. */
const PILL_TONE: Record<DevStatus["state"], string> = {
  off: "bg-muted text-muted-foreground",
  exited: "bg-muted text-muted-foreground",
  installing: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  starting: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  ready: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/10 text-destructive",
}

const SOURCE_TAG: Record<PreviewError["source"], { label: string; title: string }> = {
  preview: { label: "page", title: "From the page" },
  terminal: { label: "term", title: "From the dev server's output" },
  build: { label: "build", title: "From the production build" },
  check: { label: "check", title: "From the check script" },
}

const normalizePath = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) return "/"
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

type Drawer = "console" | "history" | null

export function PreviewPanel({
  api,
  projectId,
  actions,
}: {
  api: IDockviewPanelProps["api"]
  projectId: string
  actions: Actions
}) {
  const settings = useServer()
  const dock = useDock()
  const store = useStoreHandle()
  const confirm = useConfirm()
  const project = useProjects().find((candidate) => candidate.id === projectId)
  const { data: status, error: statusError, isPending } = useDevStatus(projectId)
  const act = useDevAction()

  const frame = React.useRef<HTMLIFrameElement>(null)
  /* The in-app path as the bridge last reported it, and the address bar's
     own text — separate so typing is not undone by a `ready` arriving from a
     navigation the page made on its own. */
  const [path, setPath] = React.useState("/")
  const [typed, setTyped] = React.useState("/")
  /* Where the frame is pointed when it (re)mounts. Set by the address bar
     only when the bridge is not there to navigate in place. */
  const [srcPath, setSrcPath] = React.useState("/")
  const [viewport, setViewport] = React.useState<ViewportId>("desktop")
  /* Bumped to remount the frame — the one way to reload a sandboxed frame
     from outside, since `contentWindow.location` is not ours to touch. */
  const [reloadKey, setReloadKey] = React.useState(0)
  const [bridgeReady, setBridgeReady] = React.useState(false)
  const [inspecting, setInspecting] = React.useState(false)
  const [bridgeErrors, setBridgeErrors] = React.useState<PreviewError[]>([])
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set())
  const [stripOpen, setStripOpen] = React.useState(false)
  const [drawer, setDrawer] = React.useState<Drawer>(null)
  const [consoleLines, setConsoleLines] = React.useState<ConsoleLine[]>([])
  const [autoFix, setAutoFix] = React.useState(false)
  /* Bridge navigation history, counted here: a sandboxed frame will not say
     how long its own history is, so the panel keeps a depth of what it saw
     — enough to grey the arrows honestly. */
  const [nav, setNav] = React.useState({ back: 0, forward: 0 })

  React.useEffect(() => {
    api.setTitle(project ? `Preview — ${project.name}` : "Preview")
  }, [api, project])

  /* The dev server, on the tab. This is the panel most likely to be the one
     nobody is looking at — you start it, dock it beside the thread and read the
     transcript — so a server that died, or a page throwing, has to be able to
     say so from the strip. A build in progress is `running`; anything the user
     has to act on is `warn`.

     `errorCount` is read below, after the ledger is built; the publish itself
     sits with the rest of the panel's effects. */

  const post = React.useCallback((message: ParentMessage) => {
    /* "*" is the only target that reaches an opaque origin; what makes it
       safe is that the frame is ours and the message carries nothing secret. */
    frame.current?.contentWindow?.postMessage(message, "*")
  }, [])

  const reload = React.useCallback(() => {
    setBridgeReady(false)
    setInspecting(false)
    setBridgeErrors([])
    setConsoleLines([])
    setReloadKey((current) => current + 1)
  }, [])

  const run = React.useCallback(
    (action: "start" | "stop" | "restart" | "build" | "check") => {
      if (action === "start" || action === "restart") {
        setBridgeErrors([])
        setHidden(new Set())
      }
      act.mutate(
        { projectId, action },
        { onError: (err) => reportError(err, `Couldn't ${action === "check" ? "run the check" : action === "build" ? "build" : `${action} the dev server`}`) }
      )
    },
    [act, projectId]
  )

  /* Opening the panel is asking for the app: a server that is simply off is
     started, once, the first time the status is known. `failed` and `exited`
     are left alone — they have a reason on them the user should read. */
  const autoStarted = React.useRef(false)
  React.useEffect(() => {
    if (autoStarted.current || !status || !project?.devCommand) return
    if (status.state !== "off") {
      autoStarted.current = true
      return
    }
    autoStarted.current = true
    run("start")
  }, [status, project?.devCommand, run])

  /* A server that comes up (or back up) after the frame was holding the
     "stopped" page gets the frame pointed at it again. Tracked by a ref so a
     stream re-delivering `ready` does not reload a page that is already live. */
  const lastState = React.useRef<DevStatus["state"] | null>(null)
  React.useEffect(() => {
    const state = status?.state ?? null
    const previous = lastState.current
    lastState.current = state
    if (state === "ready" && previous !== null && previous !== "ready") reload()
  }, [status?.state, reload])

  /* Which thread an error or a picked element goes to: the focused chat's if
     it is in this project (the route follows the focused chat), else the
     project's most recently active thread. Read at click time, not subscribed. */
  const targetThread = React.useCallback((): string | null => {
    const sessions = store.getState().sessions
    const focused = sessions.find((s) => s.id === currentThreadId())
    if (focused && focused.projectId === projectId && !focused.deletedAt) return focused.id
    const mine = sessions
      .filter((s) => s.projectId === projectId && !s.deletedAt && isTopLevel(s))
      .sort((a, b) => activityAt(b) - activityAt(a))
    return mine[0]?.id ?? null
  }, [store, projectId])

  const noThread = () =>
    toast.warning("No thread in this project yet", {
      description: "Start a thread in the project and the preview can hand it errors and elements.",
    })

  const sendToThread = React.useCallback(
    (text: string): boolean => {
      const id = targetThread()
      if (!id) {
        noThread()
        return false
      }
      dock.openChat(id)
      /* A send failure is recorded in the thread itself (see actions.send);
         toasting it here too would say it twice. */
      void actions.send(id, text).catch(() => {})
      return true
    },
    [actions, dock, targetThread]
  )

  const fix = (errors: PreviewError[]) => {
    if (errors.length === 0) return
    sendToThread(fixPrompt(errors))
  }

  /* The bridge's messages. `event.source` is the check — the sandbox makes
     the frame's origin opaque, so there is no origin to compare, and the
     frame's own window is the one sender this panel will listen to. */
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = frame.current?.contentWindow
      if (!win || event.source !== win) return
      const message = parsePreviewMessage(event.data)
      if (!message) return
      switch (message.type) {
        case "daedalus:ready": {
          setBridgeReady(true)
          setPath((previous) => {
            /* A path change the page made itself is a step forward in its
               history; the arrows follow. A history command's own `ready`
               is reconciled by the arrow handlers, which set `nav` first. */
            if (previous !== message.path && !navPending.current) setNav((n) => ({ back: n.back + 1, forward: 0 }))
            navPending.current = false
            return message.path
          })
          /* Follow the page unless the address bar is being edited. */
          if (document.activeElement?.getAttribute("data-preview-address") !== "1")
            setTyped(message.path)
          return
        }
        case "daedalus:error": {
          const next = previewErrorFromMessage(message)
          setBridgeErrors((current) =>
            current.some((e) => e.message === next.message && e.detail === next.detail)
              ? current
              : [...current, next].slice(-20)
          )
          setStripOpen(true)
          return
        }
        case "daedalus:console": {
          setConsoleLines((current) => {
            const last = current[current.length - 1]
            if (last && last.level === message.level && last.text === message.text)
              return [...current.slice(0, -1), { ...last, count: last.count + 1, at: message.at }]
            const line: ConsoleLine = {
              id: `${message.at}:${Math.random().toString(36).slice(2, 8)}`,
              level: message.level,
              text: message.text,
              at: message.at,
              count: 1,
            }
            return [...current, line].slice(-CONSOLE_MAX)
          })
          return
        }
        case "daedalus:pick": {
          setInspecting(false)
          const id = targetThread()
          if (!id) return noThread()
          appendDraft(id, pickLine(message))
          dock.openChat(id)
          return
        }
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [dock, targetThread])

  /* The picker follows the toggle, and a remount forgets it (the bridge is
     new), so it is re-sent whenever the bridge comes back while it is on. */
  React.useEffect(() => {
    if (bridgeReady) post({ type: "daedalus:inspect", on: inspecting })
  }, [bridgeReady, inspecting, post])

  const navPending = React.useRef(false)
  const go = (raw: string) => {
    const next = normalizePath(raw)
    setTyped(next)
    if (bridgeReady) {
      post({ type: "daedalus:navigate", path: next })
    } else {
      /* No bridge to navigate in place (the page has not loaded, or is a
         stopped page): point the frame there and let it come up on the path. */
      setPath(next)
      setSrcPath(next)
      reload()
    }
  }
  const step = (delta: -1 | 1) => {
    if (!bridgeReady) return
    navPending.current = true
    setNav((n) => (delta < 0 ? { back: n.back - 1, forward: n.forward + 1 } : { back: n.back + 1, forward: n.forward - 1 }))
    post({ type: "daedalus:history", delta })
  }

  const openLogs = (terminalId?: string | null) => {
    const id = terminalId ?? status?.terminalId ?? status?.installTerminalId
    if (!id) return
    dock.openPanel({ kind: "terminal", projectId, terminalId: id }, { direction: "below" })
  }

  /* One list from every reporter, dedupe by text; newest last. */
  const errors = React.useMemo(() => {
    const merged = [...(status?.errors ?? []).map(previewErrorFromTerminal), ...bridgeErrors]
      .filter((e) => !hidden.has(e.id))
      .sort((a, b) => a.at - b.at)
    const seen = new Set<string>()
    return merged.filter((e) => {
      const key = `${e.message}\n${e.detail}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [status?.errors, bridgeErrors, hidden])

  /* What the tab says (see the note beside `setTitle` above). The dev server's
     own state first, because a server that is not running is why the page is
     blank; errors from a running one after that. */
  const devState = status?.state
  usePublishPanelStatus(
    api.id,
    devState === "failed"
      ? { tone: "warn", label: "The dev server failed" }
      : devState === "exited"
        ? { tone: "warn", label: "The dev server stopped" }
        : devState === "installing" || devState === "starting"
          ? { tone: "running", label: DEV_STATE_LABEL[devState] }
          : errors.length > 0
            ? {
                tone: "warn",
                label: errors.length === 1 ? "1 error in the preview" : `${errors.length} errors in the preview`,
              }
            : null
  )

  const clearErrors = () => {
    setHidden((current) => {
      const next = new Set(current)
      for (const e of errors) next.add(e.id)
      return next
    })
    setStripOpen(false)
  }

  /* ── Auto-fix ──
     A ledger of rounds per error signature, and a debounce so a burst (a
     Vite error and the runtime error it causes) goes as one prompt. Sent
     only while the target thread is idle: an error that arrives mid-turn is
     usually the agent's own half-finished edit, and the turn's end will
     either have fixed it or re-report it. */
  const rounds = React.useRef(new Map<string, number>())
  const exhausted = React.useRef(new Set<string>())
  React.useEffect(() => {
    if (!autoFix || errors.length === 0) return
    const timer = setTimeout(() => {
      const id = targetThread()
      if (!id) return
      if (store.getState().threads[id]?.turnActive) return
      const due: PreviewError[] = []
      const spent: PreviewError[] = []
      for (const e of errors) {
        const sig = errorSignature(e)
        const used = rounds.current.get(sig) ?? 0
        if (used >= AUTO_FIX_ROUNDS) {
          if (!exhausted.current.has(sig)) spent.push(e)
          exhausted.current.add(sig)
          continue
        }
        rounds.current.set(sig, used + 1)
        due.push(e)
      }
      if (spent.length > 0)
        toast.warning(spent.length === 1 ? "Auto-fix gave up on one error" : `Auto-fix gave up on ${spent.length} errors`, {
          description: `Sent ${AUTO_FIX_ROUNDS} times without it going away. Fix it by hand, or describe what you see.`,
        })
      if (due.length === 0) return
      if (sendToThread(fixPrompt(due)))
        toast.info(due.length === 1 ? "Auto-fix sent one error to the agent" : `Auto-fix sent ${due.length} errors to the agent`)
    }, AUTO_FIX_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [autoFix, errors, sendToThread, store, targetThread])

  /* A fresh run clears the ledger: the errors of the last run are gone from
     the strip, and a repeat after a restart is a new question. */
  React.useEffect(() => {
    if (status?.state === "installing" || status?.state === "starting") {
      rounds.current.clear()
      exhausted.current.clear()
    }
  }, [status?.state])

  const state = status?.state ?? "off"
  const busy = state === "installing" || state === "starting" || act.isPending
  const src = status ? previewUrl(settings, status, srcPath) : null
  const showFrame = !!src && (state === "ready" || state === "starting" || state === "installing")
  const width = VIEWPORTS.find((entry) => entry.id === viewport)?.width ?? null
  const hasLogs = !!(status?.terminalId ?? status?.installTerminalId)
  const canStart = state === "off" || state === "failed" || state === "exited"
  const queryError = inlineFromQuery(statusError, "Couldn't read the dev server")
  const task = status?.task ?? null
  const taskRunning = task?.state === "running"
  const externalUrl = status ? previewUrl(settings, status, path) : null

  const copyUrl = async () => {
    if (!externalUrl) return
    try {
      await writeClipboard(externalUrl)
      toast.success("Preview address copied", {
        description: "It carries this boot's key — it stops working when the server restarts.",
      })
    } catch (err) {
      reportError(err, "Couldn't copy the address")
    }
  }

  const consoleErrors = consoleLines.filter((l) => l.level === "error" || l.level === "warn").length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar className="flex-wrap gap-y-1">
        <div className="flex items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Back"
            className="size-6"
            disabled={!bridgeReady || nav.back <= 0}
            onClick={() => step(-1)}
          >
            <ArrowLeftIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Forward"
            className="size-6"
            disabled={!bridgeReady || nav.forward <= 0}
            onClick={() => step(1)}
          >
            <ArrowRightIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Reload"
            className="size-6"
            disabled={!showFrame}
            onClick={reload}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>

        <form
          className="min-w-24 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            go(typed)
          }}
        >
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={() => setTyped(path)}
            placeholder="/"
            aria-label="Path in the app"
            data-preview-address="1"
            disabled={!showFrame}
            className="h-7 font-mono text-xs"
          />
        </form>

        <StatusPill state={state} status={status ?? null} pending={isPending} />
        {task && <TaskChip task={task} onLogs={() => openLogs(task.terminalId)} />}

        <div className="flex items-center gap-0.5">
          {canStart ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Start the dev server"
              title={project?.devCommand ? `Start: ${project.devCommand}` : "Start the dev server"}
              className="size-6"
              disabled={act.isPending}
              onClick={() => run("start")}
            >
              <PlayIcon className="size-3.5" />
            </Button>
          ) : (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Restart the dev server"
                title="Restart"
                className="size-6"
                disabled={act.isPending}
                onClick={() => run("restart")}
              >
                <RotateCwIcon className={cn("size-3.5", busy && "animate-spin")} />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Stop the dev server"
                title="Stop"
                className="size-6"
                disabled={act.isPending}
                onClick={() => run("stop")}
              >
                <SquareIcon className="size-3.5" />
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Run a task"
                  title="Run the check or the production build"
                  className="size-6"
                  disabled={taskRunning}
                >
                  {taskRunning ? <Spinner className="size-3.5" /> : <ShieldCheckIcon className="size-3.5" />}
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => run("check")}>
                <ShieldCheckIcon /> Run the check
                <span className="ml-auto pl-3 text-[11px] text-muted-foreground">types, lint</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => run("build")}>
                <PackageCheckIcon /> Production build
                <span className="ml-auto pl-3 text-[11px] text-muted-foreground">does it ship?</span>
              </DropdownMenuItem>
              {task && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openLogs(task.terminalId)}>
                    <ScrollTextIcon /> Last {task.kind}'s output
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Logs"
            title="Logs — the dev server's terminal"
            className="size-6"
            disabled={!hasLogs}
            onClick={() => openLogs()}
          >
            <ScrollTextIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={inspecting ? "Stop selecting" : "Select an element"}
            title={inspecting ? "Stop selecting (Esc in the page)" : "Select an element to talk about"}
            aria-pressed={inspecting}
            className={cn("size-6", inspecting && "bg-primary/10 text-primary")}
            disabled={!bridgeReady}
            onClick={() => setInspecting((current) => !current)}
          >
            <SquareDashedMousePointerIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={drawer === "console" ? "Hide the console" : "Show the console"}
            title="Console — what the page logs"
            aria-pressed={drawer === "console"}
            className={cn("relative size-6", drawer === "console" && "bg-primary/10 text-primary")}
            onClick={() => setDrawer((current) => (current === "console" ? null : "console"))}
          >
            <SquareTerminalIcon className="size-3.5" />
            {consoleErrors > 0 && drawer !== "console" && (
              <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-amber-500" />
            )}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={drawer === "history" ? "Hide history" : "Show history"}
            title="History — every change, and a way back to any of them"
            aria-pressed={drawer === "history"}
            className={cn("size-6", drawer === "history" && "bg-primary/10 text-primary")}
            onClick={() => setDrawer((current) => (current === "history" ? null : "history"))}
          >
            <HistoryIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={autoFix ? "Stop fixing errors automatically" : "Fix errors automatically"}
            title={
              autoFix
                ? `Auto-fix is on: new errors go to the agent by themselves, at most ${AUTO_FIX_ROUNDS} rounds each`
                : "Auto-fix: send new errors to the agent without asking"
            }
            aria-pressed={autoFix}
            className={cn("size-6", autoFix && "bg-primary/10 text-primary")}
            onClick={() => setAutoFix((current) => !current)}
          >
            <WandSparklesIcon className="size-3.5" />
          </Button>
          {errors.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              aria-label={`${errors.length} errors`}
              aria-expanded={stripOpen}
              className="h-6 gap-1 px-1.5 text-destructive hover:text-destructive"
              onClick={() => setStripOpen((current) => !current)}
            >
              <TriangleAlertIcon className="size-3.5" />
              <span className="font-mono text-[11px] tabular-nums">{errors.length}</span>
            </Button>
          )}
        </div>

        <div className="hidden items-center gap-0.5 @panel-md:flex">
          {VIEWPORTS.map((entry) => (
            <Button
              key={entry.id}
              size="icon-xs"
              variant="ghost"
              aria-label={entry.label}
              title={entry.label}
              className={cn("size-6", viewport === entry.id && "text-primary")}
              onClick={() => setViewport(entry.id)}
            >
              <entry.icon className="size-3.5" />
            </Button>
          ))}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Copy the preview address"
            title="Copy the preview address"
            className="size-6"
            disabled={!externalUrl}
            onClick={() => void copyUrl()}
          >
            <CopyIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open in your browser"
            title="Open in your browser"
            className="size-6"
            disabled={!externalUrl}
            onClick={() => externalUrl && window.open(externalUrl, "_blank", "noopener")}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        </div>
      </PanelToolbar>

      {errors.length > 0 && (
        <ErrorStrip
          errors={errors}
          open={stripOpen}
          onToggle={() => setStripOpen((current) => !current)}
          onFix={(e) => fix([e])}
          onFixAll={() => fix(errors)}
          onClear={clearErrors}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/20">
          {isPending ? (
            <div className="p-4">
              <Skeleton className="h-full min-h-40 w-full rounded-lg" />
            </div>
          ) : queryError ? (
            <PanelEmptyState>
              <TriangleAlertIcon className="size-5 text-destructive" />
              <p className="max-w-xs text-foreground">{queryError.title}</p>
              {queryError.detail && <p className="max-w-xs">{queryError.detail}</p>}
            </PanelEmptyState>
          ) : showFrame ? (
            <div className="mx-auto h-full" style={width ? { width, maxWidth: "100%" } : undefined}>
              <iframe
                key={reloadKey}
                ref={frame}
                src={src}
                title={project ? `Preview: ${project.name}` : "Preview"}
                className="h-full w-full border-0 bg-white"
                sandbox={SANDBOX}
                referrerPolicy="no-referrer"
              />
            </div>
          ) : (
            <Stopped
              status={status ?? null}
              devCommand={project?.devCommand ?? null}
              pending={act.isPending}
              onStart={() => run("start")}
              onLogs={hasLogs ? () => openLogs() : undefined}
            />
          )}
        </div>
        {drawer === "history" && (
          <HistoryDrawer
            projectId={projectId}
            onClose={() => setDrawer(null)}
            onRestore={async (commit) => {
              const ok = await confirm({
                title: `Restore to "${commit.subject}"?`,
                description:
                  "The files go back to how they were at that change, as a new change on top — nothing is deleted from the history, and anything uncommitted is checkpointed first.",
                confirmLabel: "Restore",
              })
              return ok
            }}
          />
        )}
      </div>

      {drawer === "console" && (
        <ConsoleDrawer
          lines={consoleLines}
          onClear={() => setConsoleLines([])}
          onClose={() => setDrawer(null)}
          onSend={(line) => sendToThread(consolePrompt(line))}
        />
      )}
    </div>
  )
}

function StatusPill({
  state,
  status,
  pending,
}: {
  state: DevStatus["state"]
  status: DevStatus | null
  pending: boolean
}) {
  if (pending) return <Skeleton className="h-5 w-14 rounded-pill" />
  const live = state === "installing" || state === "starting"
  const title =
    state === "ready" && status?.readyAt
      ? `Live for ${shortAge(status.readyAt)}${status.port ? ` on port ${status.port}` : ""}`
      : (status?.message ?? undefined)
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-pill px-2 text-[11px] font-medium",
        PILL_TONE[state]
      )}
    >
      {live ? (
        <Spinner className="size-3" />
      ) : (
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            state === "ready" ? "bg-emerald-500" : state === "failed" ? "bg-destructive" : "bg-muted-foreground/60"
          )}
        />
      )}
      {DEV_STATE_LABEL[state]}
    </span>
  )
}

/** The last build/check, as a chip beside the status: running, passed or
    failed, with the click opening its terminal. */
function TaskChip({ task, onLogs }: { task: DevTask; onLogs: () => void }) {
  const label = task.kind === "build" ? "Build" : "Check"
  const tone =
    task.state === "running"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : task.state === "passed"
        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        : "bg-destructive/10 text-destructive"
  return (
    <button
      type="button"
      onClick={onLogs}
      title={task.message ?? `${task.command} — ${task.state}`}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-pill px-2 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone
      )}
    >
      {task.state === "running" ? (
        <Spinner className="size-3" />
      ) : task.state === "passed" ? (
        <CheckIcon className="size-3" />
      ) : (
        <XIcon className="size-3" />
      )}
      {label}
      {task.state === "running" ? "…" : task.state === "passed" ? " passed" : " failed"}
    </button>
  )
}

/** What the frame's place holds while there is nothing to frame: the state
    in words, the reason when there is one, and the control that fixes it. */
function Stopped({
  status,
  devCommand,
  pending,
  onStart,
  onLogs,
}: {
  status: DevStatus | null
  devCommand: string | null
  pending: boolean
  onStart: () => void
  onLogs?: () => void
}) {
  const state = status?.state ?? "off"
  if (!devCommand && !status?.command) {
    return (
      <PanelEmptyState>
        <p className="max-w-xs">
          This project has no dev command. Set one in the project's settings (
          <code className="font-mono">pnpm dev</code>, for instance) and the harness will run it here.
        </p>
      </PanelEmptyState>
    )
  }
  if (state === "installing" || state === "starting") {
    return (
      <PanelEmptyState>
        <Logo working className="size-6 text-primary" />
        <p>{state === "installing" ? "Installing dependencies…" : "Starting the dev server…"}</p>
      </PanelEmptyState>
    )
  }
  return (
    <PanelEmptyState>
      <p className="text-sm text-foreground">
        {state === "failed" ? "The dev server failed" : "The dev server is stopped"}
      </p>
      {status?.message && (
        <p className="max-w-sm font-mono text-[11px] break-words text-muted-foreground">{status.message}</p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onStart} disabled={pending}>
          <PlayIcon /> {state === "failed" ? "Try again" : "Start"}
        </Button>
        {onLogs && (
          <Button size="sm" variant="outline" onClick={onLogs}>
            <ScrollTextIcon /> Logs
          </Button>
        )}
      </div>
    </PanelEmptyState>
  )
}

/** The errors, folded under the toolbar. Closed it is one line — the count
    and Fix all; open it lists each with its own Fix. */
function ErrorStrip({
  errors,
  open,
  onToggle,
  onFix,
  onFixAll,
  onClear,
}: {
  errors: PreviewError[]
  open: boolean
  onToggle: () => void
  onFix: (error: PreviewError) => void
  onFixAll: () => void
  onClear: () => void
}) {
  return (
    <div className="shrink-0 border-b border-destructive/20 bg-destructive/5 text-xs">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          onClick={onToggle}
        >
          <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")} />
          <span className="truncate">
            {errors.length === 1 ? "1 error" : `${errors.length} errors`}
            {!open && errors.length > 0 && (
              <span className="text-muted-foreground"> — {errors[errors.length - 1]!.message}</span>
            )}
          </span>
        </button>
        <Button size="xs" variant="ghost" className="h-6 text-destructive hover:text-destructive" onClick={onFixAll}>
          <WrenchIcon /> Fix all
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Clear errors" className="size-6" onClick={onClear}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      {open && (
        <ul className="max-h-[min(40%,14rem)] divide-y divide-destructive/10 overflow-y-auto border-t border-destructive/10">
          {errors.map((e) => (
            <li key={e.id} className="flex items-start gap-2 px-2 py-1.5">
              <span
                className="mt-0.5 shrink-0 rounded-sm bg-background/60 px-1 font-mono text-[10px] uppercase text-muted-foreground"
                title={SOURCE_TAG[e.source].title}
              >
                {SOURCE_TAG[e.source].label}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[11px] break-words text-foreground">{e.message}</p>
                {e.detail && (
                  <pre className="mt-0.5 max-h-24 overflow-auto font-mono text-[10px] leading-snug whitespace-pre-wrap text-muted-foreground">
                    {e.detail}
                  </pre>
                )}
              </div>
              <Button size="xs" variant="ghost" className="h-6 shrink-0" onClick={() => onFix(e)}>
                <WrenchIcon /> Fix
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const LEVEL_TONE: Record<ConsoleLevel, string> = {
  log: "text-foreground",
  info: "text-sky-700 dark:text-sky-300",
  debug: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-destructive",
}

/** The page's console, under the frame: every level the bridge forwards,
    filterable down to warnings and errors, newest at the bottom and kept
    there while nobody has scrolled up. One line can be handed to the agent. */
function ConsoleDrawer({
  lines,
  onClear,
  onClose,
  onSend,
}: {
  lines: ConsoleLine[]
  onClear: () => void
  onClose: () => void
  onSend: (line: ConsoleLine) => void
}) {
  const [onlyProblems, setOnlyProblems] = React.useState(false)
  const list = React.useRef<HTMLUListElement>(null)
  const pinned = React.useRef(true)
  const shown = onlyProblems ? lines.filter((l) => l.level === "warn" || l.level === "error") : lines

  React.useEffect(() => {
    const el = list.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [shown.length])

  return (
    <div className="flex h-44 shrink-0 flex-col border-t bg-background text-xs">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <SquareTerminalIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">Console</span>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{lines.length}</span>
        <div className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          className={cn("h-6", onlyProblems && "bg-primary/10 text-primary")}
          aria-pressed={onlyProblems}
          onClick={() => setOnlyProblems((current) => !current)}
        >
          Problems only
        </Button>
        <Button size="xs" variant="ghost" className="h-6" onClick={onClear} disabled={lines.length === 0}>
          Clear
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close the console" className="size-6" onClick={onClose}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <ul
        ref={list}
        onScroll={(event) => {
          const el = event.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
        }}
        className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto font-mono text-[11px]"
      >
        {shown.length === 0 ? (
          <li className="px-2 py-3 text-center text-muted-foreground">
            {lines.length === 0 ? "Nothing logged yet." : "No warnings or errors."}
          </li>
        ) : (
          shown.map((line) => (
            <li key={line.id} className="group flex items-start gap-2 px-2 py-1">
              <span className={cn("w-9 shrink-0 text-[10px] uppercase", LEVEL_TONE[line.level])}>{line.level}</span>
              <span className={cn("min-w-0 flex-1 break-words whitespace-pre-wrap", LEVEL_TONE[line.level])}>
                {line.text}
              </span>
              {line.count > 1 && (
                <span className="shrink-0 rounded-pill bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums">
                  ×{line.count}
                </span>
              )}
              <button
                type="button"
                title="Send this line to the agent"
                aria-label="Send this line to the agent"
                onClick={() => onSend(line)}
                className="shrink-0 rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <SendIcon className="size-3" />
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

/** The project's commits beside the frame: each one a restore point. The
    top row is where the tree is now; Restore on any other makes a new commit
    with that tree. Checkpoint pins the working state under a name. */
function HistoryDrawer({
  projectId,
  onClose,
  onRestore,
}: {
  projectId: string
  onClose: () => void
  /** Asked before a restore; false cancels it. */
  onRestore: (commit: GitCommit) => Promise<boolean>
}) {
  const { commits, isPending, error, refetch } = useProjectHistory(projectId)
  const act = useHistoryAction(projectId)
  const [message, setMessage] = React.useState("")
  const queryError = inlineFromQuery(error, "Couldn't read the history")

  const checkpoint = () => {
    act.mutate(
      { action: "checkpoint", message: message.trim() },
      {
        onSuccess: (result) => {
          setMessage("")
          if (result.committed) toast.success("Checkpoint saved", { description: result.commit?.subject })
          else toast.info("Nothing to checkpoint", { description: "Every change is already committed." })
        },
        onError: (err) => reportError(err, "Couldn't save a checkpoint"),
      }
    )
  }

  const restore = async (commit: GitCommit) => {
    if (!(await onRestore(commit))) return
    act.mutate(
      { action: "restore", hash: commit.hash },
      {
        onSuccess: (result) => {
          if (result.restored) toast.success("Restored", { description: result.commit?.subject })
          else toast.info("Already there", { description: "The files already match that change." })
        },
        onError: (err) => reportError(err, "Couldn't restore"),
      }
    )
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-background text-xs @panel-md:w-80">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <HistoryIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">History</span>
        <div className="flex-1" />
        <Button size="icon-xs" variant="ghost" aria-label="Refresh" className="size-6" onClick={() => void refetch()}>
          <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close history" className="size-6" onClick={onClose}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <form
        className="flex items-center gap-1 border-b px-2 py-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          checkpoint()
        }}
      >
        <Input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Checkpoint — name this state"
          aria-label="Checkpoint message"
          className="h-7 text-xs"
        />
        <Button size="xs" variant="outline" type="submit" className="h-7 shrink-0" disabled={act.isPending}>
          <FlagIcon /> Save
        </Button>
      </form>
      <ol className="min-h-0 flex-1 overflow-y-auto">
        {queryError ? (
          <li className="px-3 py-4 text-center">
            <p className="text-foreground">{queryError.title}</p>
            {queryError.detail && <p className="mt-1 text-muted-foreground">{queryError.detail}</p>}
          </li>
        ) : isPending ? (
          <li className="space-y-2 p-3">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </li>
        ) : commits.length === 0 ? (
          <li className="px-3 py-6 text-center text-muted-foreground">
            No changes committed yet. The agent commits after each completed change; Save above pins the
            current state.
          </li>
        ) : (
          commits.map((commit, index) => (
            <li
              key={commit.hash}
              className={cn(
                "group flex items-start gap-2 border-b border-border/60 px-2 py-2",
                index === 0 && "bg-primary/[0.04]"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  index === 0 ? "bg-primary" : "bg-border group-hover:bg-muted-foreground/50"
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-foreground" title={commit.subject}>
                  {commit.subject}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] text-muted-foreground">
                  <span>{commit.short}</span>
                  <span>{shortAge(commit.at * 1000)}</span>
                  {commit.filesChanged > 0 && (
                    <span>
                      {commit.filesChanged} {commit.filesChanged === 1 ? "file" : "files"}
                      {commit.insertions > 0 && <span className="text-emerald-600 dark:text-emerald-400"> +{commit.insertions}</span>}
                      {commit.deletions > 0 && <span className="text-destructive"> −{commit.deletions}</span>}
                    </span>
                  )}
                </p>
              </div>
              {index === 0 ? (
                <span className="shrink-0 rounded-pill bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                  current
                </span>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  disabled={act.isPending}
                  onClick={() => void restore(commit)}
                >
                  <Undo2Icon /> Restore
                </Button>
              )}
            </li>
          ))
        )}
      </ol>
    </aside>
  )
}
import { writeClipboard } from "@/lib/clipboard"
