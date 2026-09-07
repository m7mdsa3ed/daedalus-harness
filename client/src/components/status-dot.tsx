/* The one mark a list draws for a thread's state. Lifted out of the project
   page when the landing page became a third caller — the reading is shared
   (lib/thread/statuses.ts), so the picture of it has to be too, or two lists
   colour the same word differently. */
import type { ThreadActivity } from "@/lib/thread/phase"
import { cn } from "@/lib/utils"

/** One dot, five colours: working, needs you, a turn that ended badly,
    something is wrong with the connection, and everything else. The connection
    tints are what a list could not say at all before — a thread mid-reconnect
    drew the same grey dot as one sitting quietly. */
export function StatusDot({ status }: { status: ThreadActivity }) {
  if (status === "running") {
    return (
      <span className="relative flex size-2 shrink-0 items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
        <span className="sr-only">running</span>
      </span>
    )
  }
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "waiting"
          ? "bg-amber-500 ring-2 ring-amber-500/20"
          : status === "failed"
            ? "bg-destructive"
            : status === "reconnecting" || status === "offline" || status === "gone"
              ? "bg-muted-foreground/70 animate-pulse"
              : "bg-muted-foreground/30"
      )}
    >
      <span className="sr-only">{status}</span>
    </span>
  )
}
