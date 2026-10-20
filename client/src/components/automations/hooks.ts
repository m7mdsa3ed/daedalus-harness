/* The three actions every automations surface shares — fire by hand, pause or
   resume, delete — as toast-reporting callbacks. The list rows, the detail
   header and the palette all press the same buttons. */
import * as React from "react"
import { useNavigate } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { reportError } from "@/lib/errors"
import { useDeleteAutomation, useRunAutomation, useUpdateAutomation } from "@/lib/queries/automations"
import { automationPath, newAutomationPath } from "@/lib/router"
import type { Routine } from "@/lib/settings"
import { toast } from "@/lib/toast"

/** Fire by hand. `dryRun` forces every question back to "ask" for this one run
    whatever the policy says — the run that clears the blanket grant's gate. */
export function useFire() {
  const run = useRunAutomation()
  return React.useCallback(
    async (automation: Routine, dryRun: boolean) => {
      try {
        const started = await run.mutateAsync({ id: automation.id, dryRun })
        toast.success(dryRun ? "Dry run started — it will ask you for everything" : "Run started", {
          description: started.status === "skipped" ? (started.error ?? "Skipped") : undefined,
        })
      } catch (err) {
        reportError(err, "Couldn't start the run")
      }
    },
    [run]
  )
}

export function useToggle() {
  const update = useUpdateAutomation()
  return React.useCallback(
    (automation: Routine, enabled: boolean) =>
      update.mutate(
        { id: automation.id, patch: { enabled } },
        {
          onSuccess: () => toast.success(enabled ? "Automation resumed" : "Automation paused"),
          onError: (err) => reportError(err, "Couldn't update the automation"),
        }
      ),
    [update]
  )
}

/** Delete, asking first. The server removes the automation, its triggers and
    its runs; the threads its runs created are ordinary threads and stay. */
export function useRemove() {
  const del = useDeleteAutomation()
  const confirm = useConfirm()
  return React.useCallback(
    async (automation: Routine): Promise<boolean> => {
      if (
        !(await confirm({
          title: `Delete “${automation.name}”?`,
          description:
            automation.runsIn === "session"
              ? "The automation, its triggers and its run history go with it. The thread it ran in is untouched."
              : "The automation, its triggers and its whole run history go with it. The threads its runs created are untouched — they are ordinary threads and stay where they are.",
          destructive: true,
          confirmLabel: "Delete automation",
        }))
      )
        return false
      try {
        await del.mutateAsync(automation.id)
        toast.success("Automation deleted")
        return true
      } catch (err) {
        reportError(err, "Couldn't delete the automation")
        return false
      }
    },
    [confirm, del]
  )
}

/** How many kinds of tool this automation answers with `allow`. Zero means it
    asks a person for everything. */
export const grantsOf = (automation: Routine) =>
  Object.values(automation.autonomy.permissions).filter((s) => s === "allow").length

/** Now, refreshed every minute — enough for "in 3h" and "2m" to stay true. */
export function useMinuteTick(): number {
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

/** Open the new-automation form seeded from an existing one. */
export function useDuplicate(): (r: Routine) => void {
  const navigate = useNavigate()
  return React.useCallback(
    (r: Routine) => void navigate(newAutomationPath(), { state: { duplicateOf: r.id, returnTo: automationPath(r.id) } }),
    [navigate]
  )
}
