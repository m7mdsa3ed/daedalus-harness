/* ── The settings change this thread is carrying ──
   A reading of the thread like the four beside it, but about what the thread
   is *about to be* on rather than what it is doing. */
import { ClockIcon, LoaderCircleIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { READING_MARK, ReadingPanel, StripIndicator } from "@/components/composer/indicator"
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
  const reading = configReading(thread)
  const change = thread.pendingConfig ?? thread.stagedConfig
  if (!reading || !change) return null
  const pending = Boolean(thread.pendingConfig)
  return (
    <StripIndicator
      icon={
        pending ? (
          <LoaderCircleIcon className={cn(READING_MARK, "animate-spin")} />
        ) : (
          <ClockIcon className={READING_MARK} />
        )
      }
      label={reading.label}
      title={`${pending ? "Applying" : reading.title} — ${describeConfig(change, profiles)}`}
      tone={pending ? undefined : "text-amber-600 hover:text-amber-600 dark:text-amber-400"}
    >
      {(close) => <ConfigPanel thread={thread} sessionId={sessionId} actions={actions} onDone={close} />}
    </StripIndicator>
  )
}

/**
 * Which of the two states the thread's settings change is in, as the words
 * the trigger and the panel's heading use — or null when there is no change,
 * which is exactly when `ConfigIndicator` draws nothing. Pure: the change's
 * own description needs the profile list and is the panel's to spell.
 */
export function configReading(thread: ThreadState): { label: string; title: string } | null {
  if (thread.pendingConfig) return { label: "Applying…", title: "Applying this change" }
  if (thread.stagedConfig) return { label: "Applies on send", title: "Applies with your next message" }
  return null
}

/**
 * The change itself, and — once the server is holding it — the way to cancel
 * it. The popover's body, and the same body wherever the reading is drawn
 * inline. Nothing when there is no change.
 */
export function ConfigPanel({
  thread,
  sessionId,
  actions,
}: {
  thread: ThreadState
  sessionId: string
  actions: Actions
  /* Accepted for the panels' one shape; cancelling never closed the popover —
     the change going away takes the reading with it. */
  onDone?: () => void
}) {
  const profiles = useProfiles()
  const reading = configReading(thread)
  if (!reading) return null

  const pending = thread.pendingConfig
  if (pending) {
    return (
      <ReadingPanel heading={reading.title}>
        <p className="text-xs text-muted-foreground">
          A change that costs the process restarts the agent; one that does not moves on the running
          turn. Either way nothing is lost — the conversation comes back through a load.
        </p>
        <p className="text-xs text-foreground">{describeConfig(pending, profiles)}</p>
      </ReadingPanel>
    )
  }

  const held = thread.stagedConfig
  if (!held) return null
  return (
    <ReadingPanel
      heading={reading.title}
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
    </ReadingPanel>
  )
}
