/* ── This device's connection to the thread, at the foot of the transcript ──
   The connection banner, the reconnect ladder and the "this thread's agent
   isn't running" note were three `Notice` boxes stacked *above* the shelf
   (`composer/notices.tsx`). They were then folded into one reading on the
   shelf's floor (`composer/connection-indicator.tsx`), where the tone turned
   the shelf's own ground and the sentence lived one press away in a popover.

   They are a card again, and the card is at the *foot of the transcript* —
   with the wait, the working line and the turn's own stops. The reading was
   the wrong shape for this fact on two counts. A popover is where a number
   true of the thread right now is read in full *rarely*; a dead connection is
   a sentence with a button, and it needs to be readable without a press. And
   the shelf is the composer's own object — the thing you type into — so a
   failure drawn on it read as a property of the composer rather than of the
   thread, and it took the shelf's ground with it: an entire surface coloured
   amber to say one thing, the loudest possible way to report something that
   ends on its own.

   So: the tone and the words are one `Notice` (the app's own alert, four
   semantic tones, glyph and role derived), drawn where the turn is, with the
   one thing to do about it on the card. Nothing about the connection is drawn
   on the composer at all.

   ── The states, and why they are one table ──
   `bannerFor` owns the close codes and what each one means, and the archive
   note is the state it does not cover: a transcript read from the journal with
   no agent process behind it, which is not a failure at all — sending revives.
   They are one list here because they are one question. */
import * as React from "react"
import { Archive, RotateCw } from "lucide-react"

import { Notice } from "@/components/notice"
import { Disclosure } from "@/components/tool-parts"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import type { Actions } from "@/lib/actions"
import type { ThreadState } from "@/lib/store"
import { bannerFor, type ConnBanner } from "@/lib/thread/phase"
import { cn } from "@/lib/utils"

/** The four tones `Notice` means: sky, amber, destructive and the muted ground
    a note that is only explaining something wears. */
export type ConnectionTone = "neutral" | "info" | "warn" | "error"

export interface ConnectionNote {
  tone: ConnectionTone
  title: string
  message: string
  /** The cause, folded — see `ConnBanner.detail`. */
  detail?: string
  /** Overrides the glyph the tone would draw — the archive note is not a
      warning and wants its own mark. */
  icon?: React.ReactNode
  /** A recovery in the vocabulary `failureFor` already uses. */
  action?: ConnBanner["action"]
}

/**
 * The one state of the connection, or null when there is nothing to say.
 *
 * Null covers `idle` (a draft has no connection to be waiting on), every
 * opening phase (`StartingLine` says what is happening at the same foot) and
 * a live thread — the ordinary case.
 */
export function connectionNote(thread: ThreadState): ConnectionNote | null {
  const banner = bannerFor(thread.phase)
  if (banner) {
    return {
      tone: banner.tone,
      title: banner.title,
      message: banner.message,
      detail: banner.detail,
      action: banner.action,
    }
  }
  /* Read from the journal with no process behind it. Not a failure — the
     transcript is whole and correct, and sending is what revives it. */
  if (thread.archived) {
    return {
      tone: "neutral",
      title: "This thread's agent isn't running",
      message: "Sending a message restarts the agent and picks the conversation back up.",
      icon: <Archive />,
    }
  }
  return null
}

/**
 * The connection, drawn at the foot of the transcript.
 *
 * One recovery path with three names, exactly as `failureFor` decided it: a
 * takeover only needs a reattach (the process is alive), the other codes mean
 * the process is gone and `session/load` restores the conversation, and a
 * trashed thread needs a restore before either.
 */
export function ConnectionCard({
  thread,
  sessionId,
  actions,
}: {
  thread: ThreadState
  sessionId: string
  actions: Actions
}) {
  /** The recovery in flight, so the button says so and cannot be pressed twice. */
  const [busy, setBusy] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const note = connectionNote(thread)
  if (!note) return null

  const recover = () => {
    const action = note.action
    if (!action) return
    setBusy(true)
    const run = action.kind === "restore" ? actions.restoreThread : actions.reconnectThread
    /* The failure is already in the thread — `reconnectThread` records it, and
       the phase puts it back on this card — so a toast would be a third telling. */
    run(sessionId)
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  return (
    <Notice
      tone={note.tone}
      size="sm"
      icon={note.icon}
      title={note.title}
      action={
        note.action && (
          <Button size="xs" variant="outline" onClick={recover} disabled={busy}>
            <RotateCw className={cn("size-3.5", busy && "animate-spin")} />
            {busy ? note.action.busyLabel : note.action.label}
          </Button>
        )
      }
    >
      <p className="text-muted-foreground">{note.message}</p>
      {/* Every drawn error carries a Copy, whether or not there is a detail
          to fold under it. */}
      {note.tone === "error" && (
        <div className="flex items-center gap-1">
          {note.detail && (
            <Disclosure open={open} onToggle={() => setOpen((v) => !v)}>
              {open ? "Hide details" : "Show details"}
            </Disclosure>
          )}
          <CopyButton
            text={[note.title, note.message, note.detail].filter(Boolean).join("\n\n")}
            size="icon-xs"
            className="text-muted-foreground/80 hover:text-foreground"
          />
        </div>
      )}
      {open && note.detail && (
        <pre className="max-h-56 overflow-auto rounded-sm border border-destructive/20 bg-background/50 p-2 font-mono text-[11px] whitespace-pre-wrap text-foreground">
          {note.detail}
        </pre>
      )}
    </Notice>
  )
}
