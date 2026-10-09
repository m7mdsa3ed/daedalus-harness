/**
 * Side-effectful operations: REST calls + ACP thread lifecycle.
 *
 * This file is the barrel and the composition, nothing else. The ~1400-line
 * `useActions` body it used to hold is split by what each group is *about*,
 * under `lib/actions/`:
 *
 * | file | what went there |
 * | --- | --- |
 * | `actions/core.ts` | the thread registry, `recordError`, `known`/`requireLive`, `createSession`, `refreshSessions`, `reconnectThread` and the network watch — plus `bootstrap`, `loadQuota` and `createSchedule`, each a thin skin over one of them |
 * | `actions/config.ts` | `ConfigPatch`, `describeConfig`, the coalescing buffer, and every settings pick: profile, model, effort, follow-ups, the staged change, the agent's own mode and config options |
 * | `actions/draft.ts` | a thread before it exists: `startThreadIn` (the one "new thread" front door), `newDraftThread`, `configureDraft`, `chooseDraftConfigOption`, `learnAgentOptions` |
 * | `actions/history.ts` | paging the transcript backwards: `loadEarlier`, `prefetchEarlier`, `loadUntilTurn` |
 * | `actions/send.ts` | `send`, the server-side queue, pause/resume, `compact`, a workflow run's hold, and `stop` — one file, because three of CLAUDE.md's rules are only readable with them side by side |
 * | `actions/lifecycle.ts` | rename, delete, restore, purge, rewind, fork |
 *
 * A barrel, not an `actions/index.ts`: two candidates for `@/lib/actions` is an
 * ambiguity nobody wants to debug.
 *
 * **None of those groups is a hook.** The whole object is still built inside
 * the one `React.useMemo` below, so the hook sequence is unchanged and every
 * returned callback keeps exactly the identity it had — the memo's deps are
 * still `[settings, dispatch, getState]`, and a group that memoized itself
 * would be N memo boundaries where there was one, each a chance for its deps
 * to drift out of step with this one's.
 */

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { ServerSettings } from "./settings"
import { useCatalogReader } from "./queries/catalog"
import { useDispatch, useStoreHandle } from "./store"
import { createCore, sessionActions } from "./actions/core"
import { configActions } from "./actions/config"
import { draftActions } from "./actions/draft"
import { historyActions } from "./actions/history"
import { sendActions } from "./actions/send"
import { lifecycleActions } from "./actions/lifecycle"
import { linkActions } from "./actions/links"

export type { ConfigPatch } from "./actions/config"
export { describeConfig } from "./actions/config"
export type { LinkKey } from "./actions/links"

/** Side-effectful operations: REST calls + ACP thread lifecycle. */
export function useActions(settings: ServerSettings) {
  /* No subscription: every read below happens inside a callback, long after
     the render that a subscription would have been for. On the wide hook this
     hook re-rendered its caller — `Connected`, and so the whole shell — on
     every streamed token of every thread, to rebuild a memo whose deps had not
     moved. `getState` reads the same last-committed state the ref used to. */
  const dispatch = useDispatch()
  const { getState } = useStoreHandle()
  /* The query cache is read (not subscribed) inside callbacks, exactly like
     getState — a caller wants the last-committed rows, not a re-render. */
  const queryClient = useQueryClient()
  const catalog = useCatalogReader()

  return React.useMemo(() => {
    /* The registry and the network watch are the only two statements in here
       that *do* anything; both are `createCore`'s, in the order they were in.
       Everything else is a closure being made. */
    const core = createCore({ settings, dispatch, getState, queryClient, catalog })
    /* Built before the send group, which takes its `flushThreadConfig`: a pick
       made a moment before Enter has to be on the wire before the message it
       was made for. */
    const config = configActions(core)

    return {
      ...sessionActions(core),
      ...draftActions(core),
      ...historyActions(core),
      ...sendActions(core, config),
      ...config,
      ...linkActions(core),
      ...lifecycleActions(core),
    }
  }, [settings, dispatch, getState])
}

export type Actions = ReturnType<typeof useActions>
