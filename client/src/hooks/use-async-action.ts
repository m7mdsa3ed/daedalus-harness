/* ── The busy flag around one async action ──
   The setBusy/try/catch block every settings surface wrote by hand, with the
   failure routed per lib/errors.ts's rule: a surface the user is looking at
   holds its own error (`captureError`, drawn by an ErrorNote / FormActions),
   a background action toasts (`reportError`). */
import * as React from "react"
import { captureError, reportError, type InlineError } from "@/lib/errors"

/**
 * `run(context, fn)` — `context` names the action the way every call site
 * already did ("Couldn't save the profile"), per call because one busy flag
 * can guard two actions (an agent dialog's Save and its Reset).
 *
 * The two flavours differ on success as well as on failure, and the pairing
 * is deliberate. The inline flavour keeps `busy` up after `fn` resolves:
 * every caller ends success by closing or navigating away, and a Save button
 * re-enabled in that gap is a double submit. The toast flavour stays on
 * screen (a refresh button, a card), so it stands back down.
 */
export function useAsyncAction(opts: { toast?: boolean } = {}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const toast = opts.toast === true

  const run = React.useCallback(
    async (context: string, fn: () => Promise<void>) => {
      setBusy(true)
      setError(null)
      try {
        await fn()
        if (toast) setBusy(false)
      } catch (err) {
        if (toast) reportError(err, context)
        else setError(captureError(err, context))
        setBusy(false)
      }
    },
    [toast]
  )

  return { busy, error, run }
}
