/* ── The one thing the foot of a transcript says about the thread itself ──
   `statusFor` is the ladder; this draws every rung of it. One container, one
   `PhaseLine` that is never remounted (so a change of kind is the sentence
   swapping, not a cut), and a body under it that is mounted once and opens and
   closes with a grid-rows transition (`harness-status-body`, index.css).
   Approvals, the held-on-failure card and the queue stay their own rows. */
import * as React from "react"
import {
  ArrowUpIcon,
  CircleHelpIcon,
  PaperclipIcon,
  PauseIcon,
  PlayIcon,
  PowerOffIcon,
  RotateCwIcon,
  SettingsIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WifiOffIcon,
  WorkflowIcon,
  XCircleIcon,
} from "lucide-react"
import { useNavigate } from "react-router"
import { PhaseLine } from "@/components/composer-status"
import { useNow } from "@/components/composer/agents-indicator"
import { formatElapsed } from "@/components/step-row"
import { ActionPill } from "@/components/thread-cards"
import { Disclosure } from "@/components/tool-parts"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Progress } from "@/components/ui/progress"
import type { Actions } from "@/lib/actions"
import { useLayoutOptionsContext } from "@/lib/layout-options"
import type { StatusActionKind, ThreadStatus as Status } from "@/lib/thread/status"
import { formatDuration } from "@/lib/tokens"

/** A wait this long gets its extra sentence, and one this long gets a clock and a way out. */
const SLOW_MS = 6_000
const CLOCK_MS = 10_000
/** Replays smaller than this fold imperceptibly; a bar for them is noise. */
const LONG_REPLAY_EVENTS = 400

const LABEL: Partial<Record<Status["kind"], string>> = {
  reconnecting: "Connection status",
  parked: "Connection status",
  failed: "Connection status",
  trashed: "Connection status",
  archived: "Agent stopped",
  held: "Turn held",
  retrying: "Agent retrying",
  sending: "Sending message",
  working: "Agent working",
  waiting: "Agent working",
  "turn-failed": "Turn failed",
  /* Not "Agent working": the turn is over, and that label is what Stop and the
     composer read from. This one is the run the agent left going. */
  background: "Workflow running",
}

/* The mark at the head of the line: what the reading *is*, before the sentence
   is read. Absent means the app's own mark, which is the honest answer for the
   readings where the harness itself is doing the work on the thread's behalf —
   opening it, spawning the agent, folding a replay, the agent writing a reply.
   Everything else wears the glyph and the colour the rest of the app already
   gives that meaning (amber needs you, red failed, grey stopped), so a thread
   waiting on you and a thread reconnecting are told apart at the mark rather
   than by reading two sentences whose first words agree. */
function statusMark(status: Status): React.ReactNode {
  switch (status.kind) {
    case "waiting":
      return <CircleHelpIcon aria-hidden className="size-4 text-warning" />
    case "retrying":
      return <RotateCwIcon aria-hidden className="size-4 animate-spin text-warning" />
    case "reconnecting":
      return <WifiOffIcon aria-hidden className="size-4 text-warning" />
    case "parked":
      return <WifiOffIcon aria-hidden className="size-4 text-destructive" />
    case "failed":
      return <XCircleIcon aria-hidden className="size-4 text-destructive" />
    case "turn-failed":
      return status.tone === "error" ? (
        <XCircleIcon aria-hidden className="size-4 text-destructive" />
      ) : (
        <TriangleAlertIcon aria-hidden className="size-4 text-warning" />
      )
    case "trashed":
      return <Trash2Icon aria-hidden className="size-4 text-muted-foreground" />
    case "archived":
      return <PowerOffIcon aria-hidden className="size-4 text-muted-foreground" />
    case "held":
      return <PauseIcon aria-hidden className="size-4 text-muted-foreground" />
    case "background":
      return <WorkflowIcon aria-hidden className="size-4 text-primary" />
    case "sending":
      return <ArrowUpIcon aria-hidden className="size-4 text-primary" />
    default:
      return undefined
  }
}

/** Whole seconds until `at`, ticking once a second only while there is one. */
function useSecondsUntil(at: number | null): number | null {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (at === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [at])
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000))
}

/** The opening wait's two clocks. Only a wait that can be given up on ticks:
    a clock re-rendering a replay once a second would be motion with nothing behind it. */
function useWaitClock(waiting: boolean, cancellable: boolean) {
  const [slow, setSlow] = React.useState(false)
  React.useEffect(() => {
    setSlow(false)
    if (!waiting) return
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [waiting])
  const [waited, setWaited] = React.useState(0)
  React.useEffect(() => {
    setWaited(0)
    if (!cancellable) return
    const since = Date.now()
    const timer = setInterval(() => setWaited(Date.now() - since), 1000)
    return () => clearInterval(timer)
  }, [cancellable])
  return { slow, waited }
}

/** What the line has said, per thread, newest last. Module-level so a remount keeps it.
    ponytail: this device's view of the status only; not journaled, gone on reload. */
const LOG_MAX = 50
const logs = new Map<string, { at: number; text: string }[]>()
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false })

export function ThreadStatus({
  status,
  sessionId,
  actions,
  onAction,
  canRetryAsPaths = false,
}: {
  status: Status
  sessionId: string
  actions: Actions
  /** The failed turn's own doors (`turn-failed`): the same handlers its `ErrorRow` is given. */
  onAction?: (kind: StatusActionKind, itemId?: string) => void
  /** Whether "Retry as file paths" would change anything (`wentInline`). */
  canRetryAsPaths?: boolean
}) {
  const navigate = useNavigate()
  const [busy, setBusy] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [showLog, setShowLog] = React.useState(false)
  const [, bump] = React.useReducer((n: number) => n + 1, 0)
  // Read at render, never seeded into state: the switch has to land on a status
  // line that is already on screen.
  const { showStatusDetail } = useLayoutOptionsContext()
  const opening = !!status.opening
  const cancellable = !!status.actions?.some((a) => a.kind === "cancel")
  const { slow, waited } = useWaitClock(opening, cancellable)
  const seconds = useSecondsUntil(status.kind === "reconnecting" ? (status.nextAt ?? null) : null)
  // The backoff is counted from the moment this retry was announced.
  const retry = status.retry
  const retryAt = React.useMemo(
    () => (retry?.delayMs ? Date.now() + retry.delayMs : null),
    [retry?.attempt, retry?.delayMs] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const retrySeconds = useSecondsUntil(retryAt)
  // The open turn's clock, and the thread's total with it once there is a past to add.
  const now = useNow(!!status.ran)
  const ran = status.ran
  const turnMs = ran ? Math.max(0, now - ran.since) : 0
  const runtime = ran
    ? ran.before > 0
      ? `${formatDuration(turnMs)} · ${formatDuration(ran.before + turnMs)} total`
      : formatDuration(turnMs)
    : undefined
  // A detail folded for one failure must not stay open for the next.
  React.useEffect(() => setOpen(false), [status.kind, status.itemId])

  /* Silence is what makes a wait feel broken, so the next attempt is counted
     out; and a device with no network is told that, not blamed on the server.
     ponytail: only the two phases that are waiting on the network say it. */
  const offline = typeof navigator !== "undefined" && !navigator.onLine
  let detail = status.detail
  if (status.kind === "reconnecting" || status.kind === "parked") {
    if (offline) detail = "You are offline. This reconnects as soon as the network is back."
    else if (seconds && detail) detail = `${detail} Next attempt in ${seconds}s.`
  }
  React.useEffect(() => {
    const log = logs.get(sessionId) ?? []
    if (log[log.length - 1]?.text === status.headline) return
    log.push({ at: Date.now(), text: status.headline })
    if (log.length > LOG_MAX) log.shift()
    logs.set(sessionId, log)
    bump()
  }, [sessionId, status.headline])
  const log = logs.get(sessionId) ?? []
  const bar = status.bar && status.bar.total >= LONG_REPLAY_EVENTS ? status.bar : null

  const run = (kind: StatusActionKind) => {
    if (kind === "cancel") return actions.cancelWait(sessionId)
    if (kind === "settings") return void navigate("/settings/agents")
    if (kind === "revive" || kind === "reconnect" || kind === "restore") {
      setBusy(true)
      const go = kind === "restore" ? actions.restoreThread : actions.reconnectThread
      /* The failure is already in the thread — `reconnectThread` records it and
         the phase puts it back here — so a toast would be a third telling. */
      go(sessionId)
        .catch(() => {})
        .finally(() => setBusy(false))
      return
    }
    onAction?.(kind, status.itemId)
  }

  const visible = (status.actions ?? []).filter(
    (a) => a.kind !== "cancel" && (a.kind !== "retryAsPaths" || canRetryAsPaths)
  )
  const showCopy = status.tone === "error" || status.kind === "turn-failed" || !!status.more
  const copyText = [status.headline, detail, status.install, status.more].filter(Boolean).join("\n\n")
  /* A retry is *waiting*, not working: the shimmer is what the app wears while
     words are being produced, and a backoff that shimmered read as an answer
     arriving slowly rather than as a request that died and is being re-sent.
     The spinning mark still moves, so the line is not mistaken for dead. */
  const live = status.tone === "progress"
  const text = status.kind === "working" || status.kind === "waiting" ? `${status.headline.replace(/[.…]+$/, "")}…` : status.headline
  const hasBody =
    opening ||
    !!retry ||
    !!((showStatusDetail && (detail || status.slow)) || status.more || status.install || bar || visible.length || showCopy)

  /* One body for the life of the line, never remounted: a change of kind used to
     cut the old body away and re-open a new one from nothing. It stays, its
     parts fade in as they appear, and it closes on the last content it held
     (a closing box with nothing in it is just a cut). */
  const last = React.useRef<React.ReactNode>(null)
  if (hasBody) {
    last.current = (
      <div className="min-w-0 space-y-1 pl-7 pt-1 text-sm">
          {/* The attempt, as one meta line. It used to lead with a row of dots
              — one per attempt, the current one pulsing — which is a picture
              nothing else in the app draws and which restated a count the words
              already give. What survives is the reading itself: which attempt
              this is, and how long the wait is, separated the way every other
              meta line in the app separates two facts. */}
          {retry && (
            <div className="harness-part-in flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">
                Retry {retry.attempt}
                {retry.of ? ` of ${retry.of}` : ""}
              </span>
              {retrySeconds ? (
                <>
                  <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span>next try in {retrySeconds}s</span>
                </>
              ) : null}
            </div>
          )}
          {bar && (
            <div className="harness-part-in [--part-i:1] flex max-w-xs items-center gap-2">
              <Progress value={bar.done} max={bar.total} className="flex-1 [&_[data-slot=progress-track]]:h-1" />
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.min(99, Math.floor((bar.done / bar.total) * 100))}%
              </span>
            </div>
          )}
          {/* Always said, never taken over by the slow line: the detail is the
              only thing that says nothing was lost. A description, so the one
              switch takes it — what a status *offers* (Retry, Copy, the JSON
              under Show details) is not a description and stays. */}
          {showStatusDetail && (detail || (opening && slow && status.slow)) && (
            <div key={detail} className="harness-part-in [--part-i:1] max-w-prose leading-relaxed whitespace-pre-line text-muted-foreground">
              {detail}
              {opening && slow && status.slow && <span className="mt-1 block">{status.slow}</span>}
            </div>
          )}
          {status.install && (
            <code className="harness-part-in [--part-i:2] block w-fit max-w-full rounded-md bg-muted px-2 py-1 font-mono text-xs break-all text-foreground select-text">
              {status.install}
            </code>
          )}
          {/* One row for everything the line offers. It used to be two — a
              "Show details" line of its own, then a bar of actions under it —
              so a retry that had nothing but a fold and a Copy drew three
              stacked rows of one short thing each, and the last one was an
              orphaned glyph. `ErrorRow` puts its fold above a bar because it
              carries five actions; a status line carries one or two, so they
              share the line and the fold leads it. */}
          {(visible.length > 0 || showCopy || status.more) && (
            <div className="harness-part-in [--part-i:3] flex flex-wrap items-center gap-2 pt-1">
              {status.more && (
                <Disclosure open={open} onToggle={() => setOpen((v) => !v)} className="me-1">
                  {open ? "Hide details" : "Show details"}
                </Disclosure>
              )}
              {visible.map((a) => (
                <ActionPill
                  key={a.kind}
                  variant={a.kind === "dismiss" ? "ghost" : "outline"}
                  className={a.kind === "dismiss" ? "text-muted-foreground" : undefined}
                  disabled={busy && (a.kind === "revive" || a.kind === "reconnect" || a.kind === "restore")}
                  onClick={() => run(a.kind)}
                >
                  {a.kind === "continue" && <PlayIcon />}
                  {a.kind === "retry" && <RotateCwIcon />}
                  {a.kind === "retryAsPaths" && <PaperclipIcon />}
                  {a.kind === "settings" && <SettingsIcon />}
                  {(a.kind === "revive" || a.kind === "reconnect" || a.kind === "restore") && (
                    <RotateCwIcon className={busy ? "animate-spin" : undefined} />
                  )}
                  {busy && a.busyLabel ? a.busyLabel : a.label}
                </ActionPill>
              ))}
              {/* Every drawn error carries a Copy, whether or not there is a
                  detail — and it wears the word, the way `ErrorRow`'s does. A
                  lone icon in the action row was a glyph with nothing to say it
                  copies the failure. */}
              {showCopy && (
                <CopyButton
                  text={copyText}
                  label="Copy"
                  size="xs"
                  className="text-muted-foreground hover:text-foreground"
                />
              )}
            </div>
          )}
          {/* The way out of a wait that has stopped looking like one. Cancel
              gives up the wait, never the words: the message goes back in the box. */}
          {cancellable && waited >= CLOCK_MS && (
            <div className="harness-part-in [--part-i:3] flex items-center gap-2 pt-1 text-xs text-muted-foreground">
              <span className="tabular-nums">Waiting {formatElapsed(waited)}</span>
              <Button variant="outline" size="xs" onClick={() => run("cancel")}>
                Cancel
              </Button>
            </div>
          )}
      </div>
    )
  }

  return (
    /* No padding of its own: the foot gives every item one `py-1` wrapper
       (thread-view), this one included. */
    <div className="harness-status" data-tone={status.tone}>
      <button
        type="button"
        className="block w-full text-left"
        aria-expanded={showLog}
        title={showLog ? "Hide events" : "Show events"}
        onClick={() => setShowLog((v) => !v)}
      >
        <PhaseLine
          text={text}
          still={!live}
          /* The sentence takes the reading's own tone, so the line and the pill
             under it say the same thing: a retry is amber, not primary. */
          tone={status.tone === "error" ? "error" : status.tone === "warn" ? "warn" : "normal"}
          label={opening ? "Opening this thread" : (LABEL[status.kind] ?? "Agent status")}
          mark={statusMark(status)}
          trail={runtime}
        />
      </button>
      {showLog && (
        <ul className="max-h-48 space-y-1 overflow-auto pl-7 pt-1 text-xs text-muted-foreground">
          {[...log].reverse().map((e, i) => (
            <li key={i} className="flex gap-2">
              <time className="shrink-0 tabular-nums">{clock(e.at)}</time>
              <span className="min-w-0 break-words">{e.text}</span>
            </li>
          ))}
        </ul>
      )}
      {last.current && (
        <div className="harness-status-body" data-open={hasBody} inert={!hasBody}>
          {last.current}
        </div>
      )}
    </div>
  )
}
