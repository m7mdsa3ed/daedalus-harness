import * as React from "react"
import { Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

/* A button that says what its click is doing: its own mark at rest, a spinner
   and a travelling ring while the work runs, a tick for a moment after it
   landed. Adapted from morphin's animated-border-button / transaction-flow —
   without torph or motion: the swap is `harness-part-in`, the ring is CSS. */

export type ActionPhase = "idle" | "working" | "done"

const DONE_MS = 1500

/** Which of a surface's actions is running, or just finished. One at a time,
    because the surfaces it serves already disable everything while one runs. */
export function useActionState<K extends string>() {
  const [state, setState] = React.useState<{ key: K; phase: "working" | "done" } | null>(null)
  const timer = React.useRef<number | undefined>(undefined)
  React.useEffect(() => () => window.clearTimeout(timer.current), [])

  const run = React.useCallback(async (key: K, work: () => Promise<boolean>) => {
    window.clearTimeout(timer.current)
    setState({ key, phase: "working" })
    const ok = await work()
    /* A failure says itself where the surface puts errors; the button just
       goes back to rest rather than drawing a cross nobody can read. */
    setState(ok ? { key, phase: "done" } : null)
    if (ok) timer.current = window.setTimeout(() => setState(null), DONE_MS)
    return ok
  }, [])

  const phase = (key: K): ActionPhase => (state?.key === key ? state.phase : "idle")
  return { run, phase }
}

/** The working button keeps full strength while its disabled siblings dim —
    that contrast is what says which one is running. */
export function actionClass(phase: ActionPhase) {
  return cn(phase === "working" && "harness-busy-ring disabled:opacity-100")
}

export function ActionIcon({ phase, children }: { phase: ActionPhase; children: React.ReactNode }) {
  if (phase === "working") return <Spinner className="size-3.5" />
  if (phase === "done") return <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="harness-part-in size-3.5" />
  return children
}
