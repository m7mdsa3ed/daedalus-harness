import * as React from "react"
import { ChevronRightIcon, PauseIcon, PlayIcon, SlidersHorizontalIcon, SquareIcon } from "lucide-react"

import {
  AgentRequestActions,
  AgentRequestBody,
  AgentRequestCard,
  AgentRequestHeader,
  AgentRequestWell,
  REQUEST_BUTTON,
} from "@/components/agent-request"
import { SessionConfigPopover } from "@/components/session-config"
import { Button } from "@/components/ui/button"
import type { Actions } from "@/lib/actions"
import { describeError, reportError } from "@/lib/errors"
import type { ThreadState } from "@/lib/store"
import { holdOf } from "@/lib/thread/hold"
import { cn } from "@/lib/utils"

/**
 * The transcript's **held turn** card: a turn that failed and did not end.
 *
 * The third thing that stops a turn dead, drawn where the other two are — a
 * permission and a question — because to a reader they are the same event: the
 * agent has got as far as it can and is waiting on you. What it is *not* is an
 * `ErrorRow`. Nothing failed for good, the turn is still open, and the offer an
 * error row makes — send that prompt again — is precisely the one thing this
 * card exists to avoid: the turn is stopped at its last finished step with
 * every tool call it already made intact, so continuing costs nothing and
 * re-sending costs all of it.
 *
 * Three answers, in the order they are worth taking. **Change model** is a
 * second door onto the composer's own config menu, not a second menu: a rate
 * limit is fixed by moving off the model, the harness can do that on the
 * running process, and the next model step goes out against whatever the menu
 * was left on. **Continue** is the same resume the pause toggle sends — right
 * on its own when the limit has simply passed. **Stop** ends the turn the way
 * Stop always ends one, cleanly and without an error card.
 */
export function InlineHeldTurn({
  sessionId,
  actions,
  thread,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
}) {
  const [open, setOpen] = React.useState(false)
  /* Only a hold the *runtime* took. A pause the user asked for is already
     drawn by the toggle they pressed and needs no card explaining itself. */
  const hold = holdOf(thread)
  if (!hold.byError) return null

  /* Through `describeError`, so the provider's sentence and its JSON body are
     split the same way a failed turn's are — the title is the line that tells
     you which model to reach for, and the body stays folded until asked for. */
  const info = hold.error ? describeError(hold.error) : null
  const reason = info?.title || "The model provider returned an error"

  const resume = () =>
    void actions
      .resume(sessionId)
      .catch((err: unknown) => reportError(err, "Couldn't continue the turn"))
  const stop = () =>
    void actions.stop(sessionId).catch((err: unknown) => reportError(err, "Couldn't stop the turn"))

  return (
    <AgentRequestCard>
      <AgentRequestHeader icon={PauseIcon} label="Turn held">
        {reason}
      </AgentRequestHeader>
      <AgentRequestBody>
        <p className="text-muted-foreground">
          The turn stopped at its last finished step and kept everything before it. Change the
          model, then continue — nothing is re-run.
        </p>
        {info?.detail && (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground/80 hover:text-foreground"
            >
              <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
              {open ? "Hide details" : "Show details"}
            </button>
            {open && (
              <AgentRequestWell>
                <pre className="max-h-56 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
                  {info.detail}
                </pre>
              </AgentRequestWell>
            )}
          </>
        )}
      </AgentRequestBody>
      <AgentRequestActions>
        {/* The whole config menu, opened by this card's own button — see
            `SessionConfigPopover`'s `trigger`. Profile and persona are in
            there too, and both are honest answers to a spent quota; the ones
            that cost a restart say so before they take it. */}
        <SessionConfigPopover
          sessionId={sessionId}
          actions={actions}
          thread={thread}
          trigger={
            <Button variant="default" className={REQUEST_BUTTON}>
              <SlidersHorizontalIcon />
              Change model
            </Button>
          }
        />
        <Button variant="outline" className={REQUEST_BUTTON} onClick={resume}>
          <PlayIcon />
          Continue
        </Button>
        <Button
          variant="ghost"
          className={cn(REQUEST_BUTTON, "ms-auto text-muted-foreground hover:text-destructive")}
          onClick={stop}
        >
          <SquareIcon />
          Stop
        </Button>
      </AgentRequestActions>
    </AgentRequestCard>
  )
}
