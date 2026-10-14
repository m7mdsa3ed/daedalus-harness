/* ── The one thing the foot of a transcript says about the thread itself ──
   `statusFor` is the ladder; this draws every rung of it. One container, one
   `PhaseLine` that is never remounted (so a change of kind is the sentence
   swapping, not a cut), and a body under it that mounts afresh per *family* of
   kind and opens with a grid-rows transition (`harness-status-body`, index.css).
   Approvals, the held-on-failure card and the queue stay their own rows. */
import * as React from "react"
import { useNavigate } from "react-router"
import { PaperclipIcon, PlayIcon, RotateCwIcon, SettingsIcon } from "lucide-react"
import { PhaseLine } from "@/components/composer-status"
import { formatElapsed } from "@/components/step-row"
import { ActionPill } from "@/components/thread-cards"
import { Disclosure } from "@/components/tool-parts"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Progress } from "@/components/ui/progress"
import type { Actions } from "@/lib/actions"
import type { StatusActionKind, ThreadStatus as Status } from "@/lib/thread/status"
import { cn } from "@/lib/utils"

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
  const opening = !!status.step
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
  const live = status.tone === "progress" || status.kind === "retrying"
  const text = status.kind === "working" || status.kind === "waiting" ? `${status.headline.replace(/[.…]+$/, "")}…` : status.headline
  const hasBody =
    opening || !!retry || !!(detail || status.more || status.install || bar || visible.length || showCopy)
  /* One body per family: the opening steps share one, so stepping through them
     moves the text and the badge and does not re-open the box each time. */
  const family = opening ? "opening" : status.kind

  return (
    <div className="harness-status py-1" data-tone={status.tone}>
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
          tone={status.tone === "error" ? "error" : "normal"}
          label={opening ? "Opening this thread" : (LABEL[status.kind] ?? "Agent status")}
        />
      </button>
      {showLog && (
        <ul className="max-h-48 space-y-0.5 overflow-auto pl-6 pt-1 text-xs text-muted-foreground">
          {[...log].reverse().map((e, i) => (
            <li key={i} className="flex gap-2">
              <time className="shrink-0 tabular-nums">{clock(e.at)}</time>
              <span className="min-w-0 break-words">{e.text}</span>
            </li>
          ))}
        </ul>
      )}
      {hasBody && (
        <div key={family} className="harness-status-body">
          <div className="min-w-0 space-y-1 pl-6 pt-1 text-xs">
            {status.step && (
              <span className="harness-part-in inline-block rounded-pill bg-muted px-1.5 py-px text-[10px] tabular-nums text-muted-foreground">
                Step {status.step.n} of {status.step.of}
              </span>
            )}
            {retry && (
              <div className="harness-part-in flex items-center gap-2 tabular-nums text-muted-foreground">
                {retry.of && (
                  <span className="flex gap-1" aria-hidden>
                    {Array.from({ length: retry.of }, (_, i) => (
                      <span
                        key={i}
                        className={cn(
                          "size-1.5 rounded-full",
                          i < retry.attempt ? "bg-warning" : "bg-muted-foreground/25",
                          i === retry.attempt - 1 && !!retrySeconds && "animate-pulse"
                        )}
                      />
                    ))}
                  </span>
                )}
                <span>
                  Retry {retry.attempt}
                  {retry.of ? ` of ${retry.of}` : ""}
                  {retrySeconds ? ` · next try in ${retrySeconds}s` : ""}
                </span>
              </div>
            )}
            {bar && (
              <div className="harness-part-in [--part-i:1] flex max-w-xs items-center gap-2 pt-0.5">
                <Progress value={bar.done} max={bar.total} className="flex-1 [&_[data-slot=progress-track]]:h-1" />
                <span className="text-muted-foreground tabular-nums">
                  {Math.min(99, Math.floor((bar.done / bar.total) * 100))}%
                </span>
              </div>
            )}
            {/* Always said, never taken over by the slow line: the detail is the
                only thing that says nothing was lost. */}
            {(detail || (opening && slow && status.slow)) && (
              <div className="harness-part-in [--part-i:1] max-w-prose leading-relaxed whitespace-pre-line text-muted-foreground">
                {detail}
                {opening && slow && status.slow && <span className="mt-1 block">{status.slow}</span>}
              </div>
            )}
            {status.install && (
              <code className="harness-part-in [--part-i:2] block w-fit max-w-full rounded-sm bg-background/60 px-1.5 py-0.5 font-mono text-[11px] break-all text-foreground select-text">
                {status.install}
              </code>
            )}
            {status.more && (
              <Disclosure open={open} onToggle={() => setOpen((v) => !v)}>
                {open ? "Hide details" : "Show details"}
              </Disclosure>
            )}
            {open && status.more && (
              <pre className="max-h-56 overflow-auto rounded-sm border border-destructive/20 bg-background/50 p-2 font-mono text-[11px] whitespace-pre-wrap text-foreground">
                {status.more}
              </pre>
            )}
            {(visible.length > 0 || showCopy) && (
              <div className="harness-part-in [--part-i:3] flex flex-wrap items-center gap-1.5 pt-0.5">
                {visible.map((a) => (
                  <ActionPill
                    key={a.kind}
                    variant={a.kind === "dismiss" ? "ghost" : "outline"}
                    className={a.kind === "dismiss" ? "text-muted-foreground" : undefined}
                    disabled={busy && (a.kind === "revive" || a.kind === "reconnect" || a.kind === "restore")}
                    onClick={() => run(a.kind)}
                  >
                    {a.kind === "continue" && <PlayIcon className="size-3" />}
                    {a.kind === "retry" && <RotateCwIcon className="size-3" />}
                    {a.kind === "retryAsPaths" && <PaperclipIcon className="size-3" />}
                    {a.kind === "settings" && <SettingsIcon className="size-3" />}
                    {(a.kind === "revive" || a.kind === "reconnect" || a.kind === "restore") && (
                      <RotateCwIcon className={cn("size-3", busy && "animate-spin")} />
                    )}
                    {busy && a.busyLabel ? a.busyLabel : a.label}
                  </ActionPill>
                ))}
                {/* Every drawn error carries a Copy, whether or not there is a detail. */}
                {showCopy && (
                  <CopyButton
                    text={copyText}
                    size="icon-xs"
                    className="text-muted-foreground/80 hover:text-foreground"
                  />
                )}
              </div>
            )}
            {/* The way out of a wait that has stopped looking like one. Cancel
                gives up the wait, never the words: the message goes back in the box. */}
            {cancellable && waited >= CLOCK_MS && (
              <div className="harness-part-in [--part-i:3] flex items-center gap-2 pt-0.5 text-muted-foreground">
                <span className="tabular-nums">Waiting {formatElapsed(waited)}</span>
                <Button variant="outline" size="xs" onClick={() => run("cancel")}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
