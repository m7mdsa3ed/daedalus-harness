/* What the palette knows about the thread the URL points at: the row, the live
   transcript state, and the agent's own selectors. Shared because the root page
   prints the current value on a "Change model…" row and the model page lists
   what it can be changed to — two readings of one answer.

   These are the agent's live ACP settings, not the profile's catalog: an agent
   that advertises no model selector simply has no model page here, and the
   palette never invents one. */
import { useLocation } from "react-router"
import type * as acp from "@agentclientprotocol/sdk"

import { reportError } from "@/lib/errors"
import { flattenSelectOptions, partitionSessionOptions } from "@/lib/session-options"
import { currentThreadId } from "@/lib/router"
import { useStore, type ThreadState } from "@/lib/store"
import type { SessionMeta } from "@/lib/settings"
import type { Actions } from "@/lib/actions"

export interface ThreadTarget {
  sessionId: string | null
  meta: SessionMeta | null
  thread: ThreadState | undefined
  modes: NonNullable<ThreadState["modes"]> | null
  options: ReturnType<typeof partitionSessionOptions>
  modelChoices: ReturnType<typeof flattenSelectOptions>
  effortChoices: ReturnType<typeof flattenSelectOptions>
}

export function useThreadTarget(): ThreadTarget {
  const { state } = useStore()
  const location = useLocation()
  const sessionId = currentThreadId(location.pathname, location.search)
  const meta = state.sessions.find((session) => session.id === sessionId) ?? null
  const thread: ThreadState | undefined = sessionId ? state.threads[sessionId] : undefined
  const modes = thread?.modes && thread.modes.availableModes.length > 1 ? thread.modes : null
  const options = partitionSessionOptions(
    thread?.configOptions ?? [],
    new Set(thread?.modes?.availableModes.map((mode) => mode.id) ?? [])
  )
  return {
    sessionId,
    meta,
    thread,
    modes,
    options,
    modelChoices: options.model?.type === "select" ? flattenSelectOptions(options.model.options) : [],
    effortChoices:
      options.effort?.type === "select" ? flattenSelectOptions(options.effort.options) : [],
  }
}

/* Retuning is one ACP call to the running agent — nothing restarts, nothing is
   replayed, and it is safe in the middle of a turn. That is why there is no
   confirmation on it. */
export function retune(
  actions: Actions,
  sessionId: string | null,
  option: acp.SessionConfigOption | undefined,
  value: string
): void {
  if (!sessionId || !option) return
  actions
    .setConfigOption(sessionId, option.id, value)
    .catch((err) => reportError(err, `Couldn't change ${option.name}`))
}
