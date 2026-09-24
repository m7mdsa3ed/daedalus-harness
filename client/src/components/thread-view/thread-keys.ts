/* ── The transcript's own keys ── Escape, the option digits and Enter, gated
   on the thread the URL points at. Split off the surface because it is the one
   part of it that draws nothing: a hook over `useHotkey`, the thread's pending
   queues and the composer handle Escape hands a reclaimed message back to. */
import type * as React from "react"
import { useHotkey } from "@/hooks/use-hotkey"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { KEYS, isInteractiveTarget, isTypingTarget, overlayOpen } from "@/lib/shortcuts"
import type { ThreadState } from "@/lib/store"
import type { ComposerHandle } from "@/components/composer/composer"
import { primaryPermissionOption } from "@/components/tool-approval"

/* ── Thread keys ──
   Escape, and the digits that answer a pending question, for the transcript the
   URL points at — the dock can have several mounted at once and only one of
   them is the one being looked at, so these are gated rather than bound per
   card. Priority is the order the screen reads: a question the agent is blocked
   on outranks a permission, which outranks the turn still running.

   Escape is deliberately live while the composer has focus. It does nothing in
   a textarea, and "skip this and move on" is a thing you want to do without
   taking your hands off the keys. The digits are not: a bare 1 belongs to
   whatever you are typing. */
export function useThreadKeys({
  sessionId,
  thread,
  actions,
  composer,
  enabled,
}: {
  sessionId: string
  thread: ThreadState
  actions: Actions
  /** Where a message Escape takes back goes. */
  composer: React.RefObject<ComposerHandle | null>
  enabled: boolean
}) {
  const { permissions, elicitations, turnActive } = thread
  /* The head of each queue is the ask the hotkeys answer — Escape, the digits
     and Enter all speak for the oldest card; the rest wait their turn. */
  const permission = permissions[0]
  const elicitation = elicitations[0]

  useHotkey(
    KEYS.escape,
    (event) => {
      // A dialog, menu or popup is open — that Escape is its own.
      if (overlayOpen()) return
      if (elicitation) {
        /* `decline` is a real answer, not an abort: the AskUserQuestion bridges
           read it as "the user skipped" and the turn carries on. See
           lib/elicitation. */
        event.preventDefault()
        elicitation.resolve({ action: "decline" })
        return
      }
      if (permission) {
        // Only if the agent offered a no. Nothing is assumed on its behalf.
        const reject = permission.request.options.find((option) =>
          option.kind.startsWith("reject")
        )
        if (!reject) return
        event.preventDefault()
        permission.resolve({ outcome: { outcome: "selected", optionId: reject.optionId } })
        return
      }
      if (turnActive) {
        event.preventDefault()
        /* Escape stops the turn AND takes back the message the user has not
           seen land — the newest queued row, or a steer whose step boundary
           has not arrived — so a send made a second ago costs one key to undo
           and the words are back in the box, not parked in a queue that a
           cancelled turn will never drain.
           Only into an empty box: the message leaves the queue server-side, so
           it must not land on top of something typed since. And nothing comes
           back once a new step has read the steer — by then the words are in
           the transcript, which is where they belong. */
        const box = composer.current
        actions
          .stop(sessionId, {
            ...(box?.isEmpty() ? { onReclaim: (text: string) => box.fill(text) } : {}),
          })
          .catch((err) => reportError(err, "Couldn't stop the turn"))
      }
    },
    { enabled }
  )

  useHotkey(
    OPTION_DIGITS,
    (event) => {
      if (!permission || isTypingTarget(event.target) || overlayOpen()) return
      const option = permission.request.options[Number(event.key) - 1]
      if (!option) return
      event.preventDefault()
      permission.resolve({ outcome: { outcome: "selected", optionId: option.optionId } })
    },
    { enabled: enabled && !!permission }
  )

  useHotkey(
    "enter",
    (event) => {
      if (!permission || isTypingTarget(event.target) || overlayOpen()) return
      // A focused button answers for itself — Enter must not also answer for it.
      if (isInteractiveTarget(event.target)) return
      // The same narrow yes the card gives the primary button to.
      const optionId = primaryPermissionOption(permission.request.options)
      if (!optionId) return
      event.preventDefault()
      permission.resolve({ outcome: { outcome: "selected", optionId } })
    },
    { enabled: enabled && !!permission }
  )
}

const OPTION_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
