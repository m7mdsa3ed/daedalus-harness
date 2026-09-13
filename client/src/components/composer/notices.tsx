/* ── What the composer says before the box ──
   The `Notice` boxes above the shelf, as data: this device's connection to the
   thread, and that the thread's agent has stopped. Both read left-aligned and
   solid-bordered — the archive note used to be a centered dashed rule that
   matched nothing, not even the failure standing directly above it.

   ── The line this file draws ──
   **A note here is about *sending*.** The connection banner is the socket that
   carries a message, and the archive note is the send that revives a stopped
   agent — both answer "can I get a message out, and what happens if I try".

   Everything about the *turn* goes at the foot of the transcript instead
   (`thread-view.tsx`): the wait while a thread opens, the working line, a held
   turn, an approval, a question, and the queue of messages waiting on the turn.
   That is where the next thing will happen, so that is where the reader is
   looking. A surface that could say either thing says it in exactly one of these
   two places — the same fact drawn twice, at two ends of the box, is the bug
   this boundary exists to prevent.

   ── Where they sit ──
   They hang on the *shelf's* edge, not the box's, and wear the box's ground.
   `--harness-composer-width` is the widest thing in the unit (the box); the
   strip is deliberately 40/32px narrower so it reads as tucked behind, and a
   note that ran the box's full width floated wider than the shelf beneath it.
   A note also floats over the transcript, so a bare tone tint let the
   conversation scroll visibly through it — it wears the composer's own glass
   (`--composer` at 70% over a blur) instead, the ground the box below already
   has, with the tone kept in the border, glyph and ink. */
import * as React from "react"
import { Archive, RotateCw } from "lucide-react"

import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/button"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { bannerFor, type ConnBanner } from "@/lib/thread/phase"
import type { ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"

/* Where a note sits and what it sits on — the strip's tuck and the composer's
   glass, so the note, the shelf and the box are one stepped unit. Kept as one
   string because every note must agree on both halves. */
const NOTE =
  "mx-auto mb-1.5 w-full max-w-[calc(min(100%,var(--harness-composer-width))_-_40px)] rounded-xl bg-composer/70 backdrop-blur-xl backdrop-saturate-150 @panel-sm:max-w-[calc(min(100%,var(--harness-composer-width))_-_32px)]"

/** One note above the box, as data rather than as a branch in the JSX. */
type ComposerNote = {
  /** Stable key, and the identity the busy button is keyed on. */
  id: string
  tone: "neutral" | "info" | "warn" | "error"
  /** Overrides the tone's default glyph. Absent ⇒ the tone's own. */
  icon?: React.ReactNode
  title: string
  message: React.ReactNode
  /** A recovery the note offers, in the vocabulary `failureFor` already uses. */
  action?: ConnBanner["action"]
}

/**
 * Every note the composer can raise, in one place.
 *
 * A table rather than a pair of `&&`s beside each other, so a third state is a
 * row here and not a third branch — and so the boundary at the top of this file
 * is visible in the data. The connection banner is the whole table already
 * (`bannerFor`, which owns the close codes); the archive note is the one that is
 * not a failure, appended by hand.
 */
function composerNotes(thread: ThreadState): ComposerNote[] {
  const notes: ComposerNote[] = []
  const banner = bannerFor(thread.phase)
  if (banner) {
    notes.push({
      id: "connection",
      tone: banner.tone,
      title: banner.title,
      message: banner.message,
      action: banner.action,
    })
  }
  if (thread.archived) {
    notes.push({
      id: "archived",
      tone: "neutral",
      icon: <Archive />,
      title: "This thread's agent isn't running",
      message: "Sending a message starts it again.",
    })
  }
  return notes
}

export function ComposerNotices({
  sessionId,
  actions,
  thread,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
}) {
  /** The note whose recovery is in flight, by id. */
  const [reviving, setReviving] = React.useState<string | null>(null)
  const notes = composerNotes(thread)

  /* One recovery path with three names. Which one a phase offers is decided in
     `failureFor`, beside the close codes it reads: a takeover only needs a
     reattach (the process is alive), the other codes mean the process is gone
     and `session/load` restores the conversation, and a trashed thread needs a
     restore before either. */
  const recover = (note: ComposerNote) => {
    if (!note.action) return
    setReviving(note.id)
    const run =
      note.action.kind === "restore" ? actions.restoreThread : actions.reconnectThread
    // The connection already writes the failure into the thread; the toast is
    // for the case where the user is looking at the button, not the transcript.
    run(sessionId)
      .catch((err) => reportError(err, note.action!.busyLabel.replace("…", " failed")))
      .finally(() => setReviving(null))
  }

  return (
    <>
      {notes.map((note) => {
        const busy = reviving === note.id
        return (
          <Notice
            key={note.id}
            tone={note.tone}
            icon={note.icon}
            className={NOTE}
            title={note.title}
            action={
              note.action && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => recover(note)}
                  disabled={busy}
                >
                  <RotateCw className={cn("size-3.5", busy && "animate-spin")} />
                  {busy ? note.action.busyLabel : note.action.label}
                </Button>
              )
            }
          >
            {note.message}
          </Notice>
        )
      })}
    </>
  )
}
