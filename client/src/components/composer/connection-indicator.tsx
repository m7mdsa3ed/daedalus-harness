/* ── This device's connection to the thread, as one of the shelf's readings ──
   The connection banner, the reconnect ladder and the "this thread's agent
   isn't running" note were three `Notice` boxes stacked *above* the shelf
   (`composer/notices.tsx`, now gone). They are one fact — can this device get a
   message out, and what happens if it tries — so they are one home, and the
   home is the row the rest of the thread's readings already sit on.

   ── Why the strip and not a box ──
   A note above the box competes with the transcript for the reader's eye and
   is silent about its own severity until it is read; a reading on the shelf's
   floor is looked at constantly and read in full rarely, which is exactly the
   shape of "is my connection all right". So the tone turns the shelf's own
   ground (`ComposerStrip`'s `tone`, off `connectionTone` below, and the
   `--shelf-*` mixes in `index.css`), the mark takes the tone's ink, and the
   sentence itself is one press away, in the popover, with the one thing to do
   about it at its foot. Nothing is said twice.

   ── The two states, and why they are one table ──
   `bannerFor` owns the close codes and what each one means, and the archive
   note is the state it does not cover: a transcript read from the journal with
   no agent process behind it, which is not a failure at all — sending revives.
   They are one list here because they are one question, and a caller that
   wants the tone alone (`connectionTone`) must read the same answer the
   trigger draws. */
import * as React from "react"
import { Archive, InfoIcon, RotateCw, TriangleAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { READING_MARK, ReadingPanel, StripIndicator } from "@/components/composer/indicator"
import type { StripTone } from "@/components/composer-strip"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { ThreadState } from "@/lib/store"
import { bannerFor, type ConnBanner, type ConnPhase } from "@/lib/thread/phase"
import { cn } from "@/lib/utils"

/** The tone's ink, as the trigger's own text colour. It *replaces* the settled
    ground rather than fighting it — two `text-*` utilities in one class list
    is a coin toss decided by the stylesheet's own order. */
const TONE_TRIGGER: Record<StripTone, string> = {
  neutral: "text-muted-foreground hover:text-foreground",
  info: "text-sky-600 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300",
  warn: "text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300",
  error: "text-destructive hover:text-destructive",
}

const TONE_ICON: Record<StripTone, React.ComponentType<{ className?: string }>> = {
  neutral: InfoIcon,
  info: InfoIcon,
  warn: TriangleAlertIcon,
  error: TriangleAlertIcon,
}

/** What the trigger calls itself, which is not the popover's headline: the
    trigger has room for two short words in the footer's cluster. */
function labelFor(phase: ConnPhase): string {
  switch (phase.kind) {
    case "reconnecting":
      return "Reconnecting"
    case "parked":
      return "Offline"
    case "deleted":
      return "In Trash"
    case "failed":
      return phase.recover === "revive" ? "Agent stopped" : "Disconnected"
    default:
      return "Connection"
  }
}

export interface ConnectionNote {
  id: string
  tone: StripTone
  label: string
  icon: React.ReactNode
  title: string
  message: React.ReactNode
  /** A recovery in the vocabulary `failureFor` already uses. */
  action?: ConnBanner["action"]
}

/**
 * The one state of the connection, or null when there is nothing to say.
 *
 * Null covers `idle` (a draft has no connection to be waiting on), every
 * opening phase (`composerLock` says what is happening in the placeholder),
 * and a live thread — the ordinary case, where the shelf's ground stays the
 * shelf's ground.
 */
export function connectionNote(thread: ThreadState): ConnectionNote | null {
  const banner = bannerFor(thread.phase)
  if (banner) {
    return {
      id: "connection",
      tone: banner.tone,
      label: labelFor(thread.phase),
      icon: React.createElement(TONE_ICON[banner.tone], { className: READING_MARK }),
      title: banner.title,
      message: banner.message,
      action: banner.action,
    }
  }
  /* Read from the journal with no process behind it. Not a failure — the
     transcript is whole and correct, and sending is what revives it. */
  if (thread.archived) {
    return {
      id: "archived",
      tone: "neutral",
      label: "Agent stopped",
      icon: <Archive className={READING_MARK} />,
      title: "This thread's agent isn't running",
      message: "Sending a message starts it again.",
    }
  }
  return null
}

/** The same answer, for the surface that only needs the colour: the shelf's
    ground. Kept beside the note so the two cannot disagree. */
export function connectionTone(thread: ThreadState): StripTone | null {
  return connectionNote(thread)?.tone ?? null
}

/**
 * The connection's sentence and the recovery to try — the popover's body, and
 * the same body wherever the reading is drawn inline. Nothing on a healthy
 * thread (`connectionNote` null).
 */
export function ConnectionPanel({
  thread,
  sessionId,
  actions,
}: {
  thread: ThreadState
  sessionId: string
  actions: Actions
  /* Accepted for the panels' one shape; a recovery never closed the popover —
     a thread that comes back takes the reading with it. */
  onDone?: () => void
}) {
  /** The recovery in flight, so the button says so and cannot be pressed twice. */
  const [busy, setBusy] = React.useState(false)
  const note = connectionNote(thread)
  if (!note) return null

  /* One recovery path with three names, exactly as `failureFor` decided it: a
     takeover only needs a reattach (the process is alive), the other codes mean
     the process is gone and `session/load` restores the conversation, and a
     trashed thread needs a restore before either. */
  const recover = () => {
    const action = note.action
    if (!action) return
    setBusy(true)
    const run = action.kind === "restore" ? actions.restoreThread : actions.reconnectThread
    // The connection already writes the failure into the thread; the toast is
    // for the case where the user is looking at the button, not the transcript.
    run(sessionId)
      .catch((err) => reportError(err, action.busyLabel.replace("…", " failed")))
      .finally(() => setBusy(false))
  }

  return (
    <ReadingPanel
      heading={note.title}
      action={
        note.action && (
          <Button size="xs" variant="outline" className="w-full" onClick={recover} disabled={busy}>
            <RotateCw className={cn("size-3.5", busy && "animate-spin")} />
            {busy ? note.action.busyLabel : note.action.label}
          </Button>
        )
      }
    >
      <p className="text-xs text-muted-foreground">{note.message}</p>
    </ReadingPanel>
  )
}

/**
 * The connection, on the scope row's head — beside the project.
 *
 * Those two are the questions every other control on the floor is read
 * against: where the work lands, and whether this device can get a message out
 * about it. It also designs its own absence — nothing on a healthy thread —
 * which is what lets a reading that is usually a failure live on a row that is
 * otherwise permanently true.
 */
export function ConnectionIndicator({
  thread,
  sessionId,
  actions,
}: {
  thread: ThreadState
  sessionId: string
  actions: Actions
}) {
  const note = connectionNote(thread)
  if (!note) return null

  return (
    <StripIndicator
      icon={note.icon}
      label={note.label}
      title={note.title}
      tone={TONE_TRIGGER[note.tone]}
      /* `always` and not the pill's default: this is the one reading whose
         colour *is* the news, so its words never go quiet — a bare amber mark
         says nothing about what broke. It also widens the trigger with the
         words (`READING_TRIGGER_ALWAYS`), which is what stops the pill hanging
         out of its 24px square and over the project beside it. This is the
         reading that yields nothing; the project yields its name instead
         (`DraftScopeRow`'s `reading`). */
      labelAlways
    >
      {(close) => <ConnectionPanel thread={thread} sessionId={sessionId} actions={actions} onDone={close} />}
    </StripIndicator>
  )
}
