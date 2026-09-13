/* ── The settings change this thread is carrying ──
   A reading of the thread like the four beside it, but about what the thread
   is *about to be* on rather than what it is doing. */
import { ClockIcon, LoaderCircleIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { READING_MARK, StripIndicator } from "@/components/composer/indicator"
import { cn } from "@/lib/utils"
import type { Actions } from "@/lib/actions"
import { describeConfig } from "@/lib/actions"
import { useProfiles } from "@/lib/queries/catalog"
import type { ThreadState } from "@/lib/store"

/**
 * A settings change to this thread, in whichever of its two states it is in.
 *
 * It used to be a toast, then a banner above the composer. It is neither: the
 * change is reported where the other readings of the thread are, so a reader
 * looking at what the thread *is* on sees what it is *about to be* on beside it.
 *
 * **In flight outranks held**, the way `configView` reads the two: a pick the
 * server has not answered is the newest statement of intent, and a change
 * already staged is what that pick is about to become. Both states are drawn
 * the same way for the same reason — a process-costing change is one fact
 * whether it was staged for the next send or spent on the spot because a held
 * turn was waiting for it (see `applyConfig`'s exclusions). That second case
 * used to be a toast and nothing else, which is the inconsistency this closes:
 * the same pick reported in one place, whatever the turn underneath it was
 * doing.
 *
 * The popover carries the change itself, and the one thing worth doing about
 * it — which exists only once the server is holding it. A pick still in flight
 * has nothing to cancel yet.
 */
export function ConfigIndicator({
  thread,
  sessionId,
  actions,
}: {
  thread: ThreadState
  sessionId: string
  actions: Actions
}) {
  const profiles = useProfiles()
  const pending = thread.pendingConfig
  const staged = thread.stagedConfig
  if (!pending && !staged) return null

  if (pending) {
    return (
      <StripIndicator
        icon={<LoaderCircleIcon className={cn(READING_MARK, "animate-spin")} />}
        label="Applying…"
        heading="Applying this change"
        title={`Applying — ${describeConfig(pending, profiles)}`}
      >
        <p className="text-xs text-muted-foreground">
          A change that costs the process restarts the agent; one that does not moves on the running
          turn. Either way nothing is lost — the conversation comes back through a load.
        </p>
        <p className="text-xs text-foreground">{describeConfig(pending, profiles)}</p>
      </StripIndicator>
    )
  }

  const held = staged
  if (!held) return null

  return (
    <StripIndicator
      icon={<ClockIcon className={READING_MARK} />}
      label="Applies on send"
      heading="Applies with your next message"
      title={`Applies with your next message — ${describeConfig(held, profiles)}`}
      tone="text-amber-600 hover:text-amber-600 dark:text-amber-400"
      action={
        <Button
          size="xs"
          variant="outline"
          className="w-full"
          onClick={() => void actions.cancelStagedConfig(sessionId)}
        >
          <XIcon className="size-3.5" />
          Cancel the change
        </Button>
      }
    >
      <p className="text-xs text-muted-foreground">
        A change that costs the process is taken by the next spawn — which is the next message you
        send. Nothing is waiting for a turn boundary, and nothing is applied before you ask.
      </p>
      <p className="text-xs text-foreground">{describeConfig(held, profiles)}</p>
    </StripIndicator>
  )
}
