/* Running one of a project's helper commands, from wherever the button is.

   Two callers, one behaviour: the thread header's Run menu and the project
   page's menu and chips.
   Both ask the same question first when the helper says to, and both end in
   the same place — a terminal panel on the helper's own command — so the
   decision lives here rather than twice.

   The confirm is the app's own dialog, not a step inside a run surface: there
   is no run surface any more. A helper *is* a terminal now, and a terminal
   starts the instant it exists, so the only moment left to ask is before the
   route is called. */
import * as React from "react"

import { useConfirm } from "@/components/confirm-dialog"
import { openHelperTerminal } from "@/lib/workspace/open-terminal"
import type { Scope } from "@/lib/right-panel"
import type { HelperCommand } from "@/lib/settings"

export type RunHelper = (helper: HelperCommand, projectId: string) => Promise<boolean>

/**
 * @param scope the right panel the terminal opens in: a thread's, or a project
 *   page's. Resolves true when the terminal started.
 */
export function useRunHelper(scope: Scope): RunHelper {
  const confirm = useConfirm()
  return React.useCallback(
    async (helper, projectId) => {
      if (
        helper.confirm &&
        !(await confirm({
          title: `Run "${helper.name}"?`,
          /* The command itself, because that is the thing being agreed to —
             a name somebody chose months ago is not what will run. */
          description: helper.description
            ? `${helper.description}\n\n${helper.command}`
            : helper.command,
          confirmLabel: "Run",
        }))
      )
        return false
      return openHelperTerminal(scope, projectId, helper)
    },
    [confirm, scope]
  )
}
