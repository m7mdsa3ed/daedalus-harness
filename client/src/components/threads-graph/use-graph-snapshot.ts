/* The store, read once a second instead of once a token: `state.threads` is
   replaced on every streamed chunk of every thread, and a graph rebuilt that
   often redraws nothing anyone can see change. Paused while the page is
   hidden; the session list is re-read every 10s, because a thread with no
   socket only moves when the list does. */
import * as React from "react"

import type { Actions } from "@/lib/actions"
import { captureError, type InlineError } from "@/lib/errors"
import { useStoreHandle, type State } from "@/lib/store"

const TICK_MS = 1000
const REFRESH_MS = 10_000

export function useGraphSnapshot(actions: Actions): { state: State; error: InlineError | null; retry: () => void } {
  const handle = useStoreHandle()
  const [state, setState] = React.useState(() => handle.getState())
  const [error, setError] = React.useState<InlineError | null>(null)

  const refresh = React.useCallback(() => {
    actions.refreshSessions().then(
      () => setError(null),
      (err: unknown) => setError(captureError(err, "Couldn't refresh the thread list"))
    )
  }, [actions])

  React.useEffect(() => {
    refresh()
    let last = Date.now()
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return
      setState(handle.getState())
      if (Date.now() - last >= REFRESH_MS) {
        last = Date.now()
        refresh()
      }
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [handle, refresh])

  return { state, error, retry: refresh }
}
