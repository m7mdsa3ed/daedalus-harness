/* eslint-disable react-refresh/only-export-components */
/**
 * The reducer half of the app's state — what the *socket* writes; everything a
 * *route* answers is TanStack Query (`lib/queries/`). See CLAUDE.md.
 *
 * The implementation lives in `lib/store/`, split along the seams the one file
 * already had. This is a barrel and deliberately NOT a directory
 * `index.tsx`: two candidates for the specifier `@/lib/store` is an ambiguity
 * nobody wants to debug. The path is load-bearing — every consumer imports
 * from here, and the export list below is the whole public surface.
 *
 *   `store/items.ts`          the thread item model (TextItem … AsyncTaskItem,
 *                             the ThreadItem union, the two pending asks) and
 *                             the module-counter id mint every item is named by.
 *   `store/thread.ts`         ThreadState and State, `emptyThread`, and the two
 *                             readings of a thread — `configView`,
 *                             `threadIsEmpty`.
 *   `store/session-update.ts` the ACP `session/update` fold: `applySessionUpdate`
 *                             (one protocol frame → thread items), its
 *                             session-level counterpart `applyMetaUpdate`, the
 *                             step-usage mark and `settleTools`.
 *   `store/messages.ts`       `pushUserMessage` and the `turn_ended` usage fold
 *                             `addUsage`.
 *   `store/reducer.ts`        the `Action` union and `reducer`.
 *   `store/provider.tsx`      `initialState`, the external store — context,
 *                             `StoreProvider` — and the hooks that read it.
 */

export type {
  TextItem,
  ToolItem,
  SubagentItem,
  PlanItem,
  ErrorItem,
  CompactionItem,
  AutonomyItem,
  AsyncTaskItem,
  ThreadItem,
  PendingPermission,
  PendingElicitation,
} from "./store/items"

export type { ThreadState, State } from "./store/thread"
export { emptyThread, configView, threadIsEmpty } from "./store/thread"

export { applySessionUpdate } from "./store/session-update"

export { pushUserMessage, addUsage } from "./store/messages"

export type { Action } from "./store/reducer"
export { reducer } from "./store/reducer"

export type { StoreHandle } from "./store/provider"
export {
  initialState,
  DispatchContext,
  StoreProvider,
  useStoreHandle,
  useStoreSelect,
  useThread,
  useSessionMeta,
  useLiveTurnActive,
  useDispatch,
} from "./store/provider"
