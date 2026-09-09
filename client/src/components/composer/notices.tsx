/* ── What the composer says before the box ──
   The two dashed notes above the shelf: what this device's connection is
   doing, and that this thread's agent is not running. Both are the composer
   unit's width (`--harness-composer-width`), like everything else in it. */
import * as React from "react"
import { Archive, RotateCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { bannerFor } from "@/lib/thread/phase"
import type { ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"

export function ComposerNotices({
  sessionId,
  actions,
  thread,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
}) {
  const [reviving, setReviving] = React.useState(false)
  const banner = bannerFor(thread.phase)

  /* One recovery path with three names. Which one a phase offers is decided in
     `failureFor`, beside the close codes it reads: a takeover only needs a
     reattach (the process is alive), the other codes mean the process is gone
     and `session/load` restores the conversation, and a trashed thread needs a
     restore before either. */
  const recover = () => {
    if (!banner?.action) return
    setReviving(true)
    const run =
      banner.action.kind === "restore" ? actions.restoreThread : actions.reconnectThread
    // The connection already writes the failure into the thread; the toast is
    // for the case where the user is looking at the button, not the transcript.
    run(sessionId)
      .catch((err) => reportError(err, banner.action!.busyLabel.replace("…", " failed")))
      .finally(() => setReviving(false))
  }

  return (
    <>
      {/* What this device's connection is doing, when it is doing something
          worth interrupting for. A *state*, not a transcript row: the ladder
          used to append an error when it gave up, and giving up is exactly the
          condition that ends on its own — so the row stayed in the middle of
          the conversation, one per outage, describing something that was over. */}
      {banner && (
        <div
          className={cn(
            "mx-auto mb-1.5 flex w-full max-w-[var(--harness-composer-width)] flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-1.5 text-center text-xs",
            banner.tone === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          <span>
            <span className="font-medium">{banner.title}</span> {banner.message}
          </span>
          {banner.action && (
            <Button size="xs" variant="outline" onClick={recover} disabled={reviving}>
              <RotateCw className={cn("size-3.5", reviving && "animate-spin")} />
              {reviving ? banner.action.busyLabel : banner.action.label}
            </Button>
          )}
        </div>
      )}
      {thread.archived && (
        <div className="mx-auto mb-1.5 flex w-full max-w-[var(--harness-composer-width)] items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-1.5 text-center text-xs text-muted-foreground">
          <Archive className="size-3.5 shrink-0" />
          <span>This thread's agent isn't running. Sending a message starts it again.</span>
        </div>
      )}
    </>
  )
}
