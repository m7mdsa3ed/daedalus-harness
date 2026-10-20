/* ── The settings change this thread is carrying ──
   A reading of the thread like the ones beside it — but about what the thread
   is *about to be* on rather than what it is doing, so it belongs with the
   conversation it is about to answer, at the foot of the transcript, beside
   the queue. It used to be a reading in the composer's end cluster and a row
   in the settings menu, which put one fact in two chrome places at once; the
   transcript is where the thing it describes happens.

   **In flight outranks held**, the way `configView` reads the two: a pick the
   server has not answered is the newest statement of intent, and a change
   already staged is what that pick is about to become. Both states are drawn
   the same way for the same reason — a process-costing change is one fact
   whether it was staged for the next send or spent on the spot because a held
   turn was waiting for it. That second case used to be a toast and nothing
   else.

   The card carries the change itself, and the one thing worth doing about it —
   which exists only once the server is holding it. A pick still in flight has
   nothing to cancel yet.

   A staged tool link is part of the same `StagedConfig`, so it is named here
   too; the tools menu keeps its own header where the picks are made. */
import { useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import { CheckIcon, ClockIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Actions } from "@/lib/actions"
import { describeConfig } from "@/lib/actions"
import { useCommands, useMcpServers, useProfiles, useSkills } from "@/lib/queries/catalog"
import { reportError } from "@/lib/errors"
import type { ThreadState } from "@/lib/store"

/** The ids a tool patch names, resolved against the catalog that lists them.
    `undefined` is a field the patch did not touch; `[]` is a set emptied. */
function toolNames(items: { id: string; name: string }[], ids: string[] | undefined): string | null {
  if (ids === undefined) return null
  if (ids.length === 0) return "none"
  return ids.map((id) => items.find((item) => item.id === id)?.name ?? id).join(", ")
}

export function PendingSettings({
  thread,
  sessionId,
  actions,
}: {
  thread: ThreadState
  sessionId: string
  actions: Actions
}) {
  const profiles = useProfiles()
  /* The tool catalogs, because `describeConfig` speaks only for the session
     row's own settings — a staged tool link is a change this card must be able
     to name too, or a tools-only change would draw it blank. */
  const mcpServers = useMcpServers()
  const skills = useSkills()
  const commands = useCommands()
  const pending = thread.pendingConfig
  const held = thread.stagedConfig
  /* "Apply now" is a request this device is waiting on — and, until it lands,
     one there is nothing on the server to draw: `stagedConfig` is unchanged
     and no `pendingConfig` was ever set, because the patch was not picked here.
     So the wait is this component's own, and it reads as the same in-flight
     state a pick draws. */
  const [applyingNow, setApplyingNow] = useState(false)
  /* One card per thread, so a pick that has not landed yet supersedes the
     staged change it is about to become rather than stacking beside it. */
  const patch = pending ?? held
  if (!patch) return null
  const applying = pending !== null || applyingNow
  const action = thread.turnActive ? "Steer now" : "Apply now"
  const tools = [
    patch.mcpServerIds !== undefined && `MCP: ${toolNames(mcpServers, patch.mcpServerIds)}`,
    patch.skillIds !== undefined && `Skills: ${toolNames(skills, patch.skillIds)}`,
    patch.commandIds !== undefined && `Commands: ${toolNames(commands, patch.commandIds)}`,
  ]
    .filter(Boolean)
    .join(" · ")
  const description = [describeConfig(patch, profiles, thread), tools].filter(Boolean).join(" · ")

  return (
    <section aria-label="Pending settings change" className="mt-2">
      <header className="mb-1.5 flex items-center gap-1.5 px-1">
        {applying ? (
          <Spinner className="size-3 text-muted-foreground" />
        ) : (
          <ClockIcon className="size-3 text-warning" />
        )}
        <h3 className="text-xs font-medium text-muted-foreground">
          {applying ? "Applying settings" : "Settings on next send"}
        </h3>
      </header>
      <div
        className={cn("rounded-xl border bg-muted/50 px-3 py-2", applying && "border-primary/30")}
      >
        <p className="min-w-0 break-words text-sm text-foreground">{description}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {applying
            ? "A change that costs the process restarts the agent; one that does not moves on the running turn. Either way nothing is lost — the conversation comes back through a load."
            : `Picks are held until a turn starts — or a spawn, for what only a restart can place. Nothing is applied before you ask. ${action} takes what the running agent can take as it is${thread.turnActive ? ", and the rest waits for the next turn" : ""}.`}
        </p>
        {!applying && (
          <div className="mt-2 flex gap-1.5">
            <Button
              size="xs"
              className="flex-1"
              onClick={() => {
                setApplyingNow(true)
                void actions
                  .applyStagedConfig(sessionId)
                  .catch((err) => reportError(err, "Couldn't apply that change"))
                  .finally(() => setApplyingNow(false))
              }}
            >
              <CheckIcon data-icon="inline-start" />
              {action}
            </Button>
            <Button
              size="xs"
              variant="outline"
              className="flex-1"
              onClick={() => void actions.cancelStagedConfig(sessionId)}
            >
              <XIcon data-icon="inline-start" />
              Cancel
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
