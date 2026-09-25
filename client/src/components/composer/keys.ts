/* ── What a key means in the box ──
   One ordering, stated once: whichever completer is open owns the navigation
   keys, then the history walk, then Enter. It is a plain closure and not a
   hook — there is no state here, only the order.

   Note the two different "mobile" questions this file and its caller sit
   between: what **Enter** means is the width's (`useIsMobile`), because a soft
   keyboard is a width question in practice, while how big the row's targets
   are is the device's (`useCoarsePointer`, in the card). They are not the same
   question and must not be collapsed into one. */
import type * as React from "react"

import { matchesChord } from "@/lib/shortcuts"

/** A menu that may swallow the keystroke. True when it consumed the event. */
interface KeyConsumer {
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => boolean
}

export function composerKeyDown({
  slash,
  commands,
  mentions,
  history,
  isMobile,
  enterSends,
  steerChords,
  send,
}: {
  slash: KeyConsumer
  commands: KeyConsumer
  mentions: KeyConsumer
  history: KeyConsumer
  /** The panel's width, not the device's pointer. */
  isMobile: boolean
  enterSends: boolean
  steerChords: string[]
  send: (opts?: { steer?: boolean }) => void | Promise<void>
}) {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    // The command menu owns navigation keys (and Enter) while open.
    if (slash.onKeyDown(e)) return
    // Then the `!` project menu — the other start-anchored completers. The two
    // cannot both be open (`!/name` holds no lone token) but the order is stated.
    if (commands.onKeyDown(e)) return
    // Then the `@` menu, for the same reason.
    if (mentions.onKeyDown(e)) return
    if (history.onKeyDown(e)) return
    if (e.key !== "Enter") return
    /* Past the queue: into the turn that is already running. Checked
       first because it is the more specific chord, and it is every
       Cmd/Ctrl+Enter now — with no turn running `send({steer})` is an
       ordinary send, so the chord never has to be told apart from the
       plain one by the person pressing it. It is also the send key
       when Enter has been set to break the line. */
    if (steerChords.some((chord) => matchesChord(e, chord))) {
      e.preventDefault()
      void send({ steer: true })
      return
    }
    /* Bare Enter sends on desktop and inserts a newline on touch, where
       Return is the only newline key there is and every soft keyboard
       shows it as one. Shift+Enter is the desktop escape hatch — and
       with `enterSends` off the two swap: Enter breaks the line and
       nothing but the chord above or the button sends. IME composition
       is left alone — Enter is how you accept a candidate. */
    if (isMobile || e.altKey || e.nativeEvent.isComposing) return
    if (!enterSends) return
    if (e.shiftKey) return
    e.preventDefault()
    void send()
  }
}
