import type * as acp from "@daedalus/acp"
import type {
  AttachmentRef,
  QueuedMessage,
  QuotaSnapshot,
  SessionUpdate,
  StagedConfig,
  ThreadRetry,
  TurnChanges,
  TurnTick,
  TpsStats,
  WireError,
} from "@daedalus/protocol"
import { sameRow } from "../settings"
import type { SessionMeta } from "../settings"
import { unclaimed } from "../thread/carry"
import type { ConnPhase } from "../thread/phase"
import { mintItemId } from "./items"
import type { PendingElicitation, PendingPermission, TextItem, ThreadItem } from "./items"
import { emptyThread } from "./thread"
import type { State, ThreadState } from "./thread"
import { applyMetaUpdate, settleTools } from "./session-update"
import { addTps, addUsage, pushUserMessage } from "./messages"

// ---- reducer ----

export type Action =
  | { type: "bootstrap"; sessions: SessionMeta[] }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "draft-session"; session: SessionMeta }
  | { type: "drop-draft-session"; id: string }
  | {
      type: "configure-draft"
      id: string
      next: Partial<
        Pick<
          SessionMeta,
          | "projectId"
          | "profileId"
          | "agentId"
          | "model"
          | "effort"
          | "modeId"
          | "personaId"
          | "suggestFollowups"
          | "uiBlocks"
          | "mcpServerIds"
          | "skillIds"
          | "commandIds"
          | "isolate"
        >
      >
    }
  | { type: "draft-config-option"; id: string; configId: string; value: string | boolean }
  /** A live profile/model/effort change, from this device or another. Patches
      the thread's row in place: the change did not restart anything, so there
      is no reload to carry it and no draft semantics to respect. */
  | {
      type: "spawn-config"
      id: string
      profileId: string
      model: string
      effort: string
      personaId?: string
      suggestFollowups?: boolean
      uiBlocks?: boolean
    }
  /** This device's own optimism about a config change, or the end of it.
      `patch: null` clears; anything else **merges**, because the picks are
      buffered one row at a time (model, then effort) and coalesced into one
      request — see `ThreadState.pendingConfig`. */
  | { type: "pending-config"; id: string; patch: StagedConfig | null }
  /** The server's staged change, absolute — from `staged_config` or the
      `staged` field of `caught_up`. */
  | { type: "staged-config"; id: string; config: StagedConfig | null }
  /** The thread's context occupancy as the *server* holds it — from `caught_up`
      and from the end of a re-fold. Absolute, and deliberately the last word
      over the `usage_update`s the replay folds: the window may carry none, and
      a `load_earlier` page carries older ones. Null = never reported. */
  | { type: "thread-context"; id: string; context: acp.UsageUpdate | null }
  | { type: "thread-tps"; id: string; tps: TpsStats | null }
  | { type: "thread-reset"; id: string; thread: ThreadState }
  | { type: "turn-active"; id: string; active: boolean; settle?: boolean }
  | { type: "paused"; id: string; paused: boolean; reason?: "user" | "error"; error?: WireError }
  /** The turn is retrying, or has stopped (`retry: null`). Absolute, from the
      `retry` event and the `retry` field of `caught_up`. */
  | { type: "retry"; id: string; retry: ThreadRetry | null }
  /** How the turn that just ended went, onto the *session* row rather than the
      thread: it is what a list draws about a thread nothing is looking at, and
      the server records the same verdict on its own row. `error` is the
      failure's headline, or null for a turn that ended cleanly or was
      cancelled — both of which clear whatever the turn before left. */
  | { type: "turn-verdict"; id: string; error: string | null }
  /** Windowing/archive bookkeeping, all of it absolute — set from `attached`
      and from the end of a re-fold, never accumulated. */
  | {
      type: "thread-window"
      id: string
      archived?: boolean
      earlier?: number
      loadingEarlier?: boolean
    }
  /** The journal's whole turn list, from `attached` — see `ThreadState.turns`.
      Absolute, never accumulated: a fresh attach replaces, a resume sends
      nothing and leaves it alone. */
  | { type: "thread-turns"; id: string; turns: TurnTick[] }
  /** The connection moved. One writer, one action — see `ThreadState.phase`. */
  | { type: "thread-phase"; id: string; phase: ConnPhase }
  /** Put back the rows a replaced transcript took with it — this device's own
      unacknowledged message and its own error rows. See lib/thread/carry.ts. */
  | { type: "thread-carry"; id: string; items: ThreadItem[] }
  /** `sessionId` names a subagent's session when the update is a child's —
      see the `update` event in protocol.ts. Absent = the thread's own. */
  | { type: "update"; id: string; update: SessionUpdate; allowUserChunks?: boolean; sessionId?: string }
  /** `local` = this device typed it (see `TextItem.local`); the replay's own
      user bubbles and the ones a `turn_started` mints are not. */
  | {
      type: "user-message"
      id: string
      text: string
      turnId?: string
      local?: boolean
      attachments?: TextItem["attachments"]
    }
  | { type: "tag-user-turn"; id: string; turnId: string }
  /** Take back an optimistic user bubble: the server queued the words instead
      of sending them, and the queue row is where they show now. */
  | { type: "drop-user-message"; id: string }
  /** The whole queue, absolute. */
  | { type: "queue"; id: string; items: QueuedMessage[] }
  | { type: "notice"; id: string; text: string; config?: boolean }
  | {
      type: "error"
      id: string
      title: string
      reason?: string
      detail?: string
      retryText?: string
      retryAttachments?: AttachmentRef[]
      settle?: boolean
      /** Written by this client rather than replayed from a journal — see
          `ErrorItem.local`. */
      local?: boolean
    }
  | { type: "dismiss-error"; id: string; itemId: string }
  | {
      type: "permission"
      id: string
      requestId: string
      permission: PendingPermission | null
    }
  | {
      type: "elicitation"
      id: string
      requestId: string
      elicitation: PendingElicitation | null
    }
  | { type: "session-title"; id: string; title: string }
  | { type: "agent-session-title"; id: string; title: string }
  | { type: "rename-session"; id: string; title: string }
  | { type: "pin-session"; id: string; pinnedAt: number | null }
  /** Absolute state, with one hole: an event may carry modes and leave the
      options out, which means "unchanged" and not "none". The reducer is where
      that is resolved, because during a batched replay the caller cannot read
      the current value — it has not been committed yet. */
  | {
      type: "session-config"
      id: string
      modes: acp.SessionModeState | null
      configOptions?: acp.SessionConfigOption[]
      /** Same hole, same rule: absent means unchanged. */
      promptCapabilities?: acp.PromptCapabilities
      canPause?: boolean
      canCompact?: boolean
    }
  | { type: "mode"; id: string; modeId: string }
  | { type: "config-options"; id: string; configOptions: acp.SessionConfigOption[] }
  | { type: "usage"; id: string; usage: acp.Usage; turnId?: string; durationMs?: number; toolDurationMs?: number }
  | { type: "turn-timing"; id: string; turnId: string; durationMs?: number; toolDurationMs?: number }
  | { type: "ttft"; id: string; ms: number }
  | { type: "turn-changes"; id: string; turn: TurnChanges }
  | { type: "turn-changes-all"; id: string; turns: TurnChanges[] }
  | { type: "quota"; id: string; quota: QuotaSnapshot }
  /** A run of actions folded into one commit. The replay is the only thing
      that sends it: rebuilding a long thread is a few thousand of the actions
      above, and dispatching them one at a time is a few thousand renders of a
      transcript nobody has seen yet. Folding costs the same reducer work and
      one render. It carries no semantics of its own — whatever is inside means
      exactly what it means on its own. */
  | { type: "batch"; actions: Action[] }

function thread(state: State, id: string): ThreadState {
  return state.threads[id] ?? emptyThread
}

function withThread(state: State, id: string, patch: Partial<ThreadState>): State {
  return { ...state, threads: { ...state.threads, [id]: { ...thread(state, id), ...patch } } }
}

/** One queue entry per requestId: a repeat of the same ask — a re-attach
    replaying the server's pending set — replaces its row in place rather than
    queuing a second card, and an answer, ours or a peer's, removes exactly that
    one and leaves the rest in arrival order. */
function upsertAsk<T extends { requestId: string }>(
  list: T[],
  requestId: string,
  next: T | null,
): T[] {
  if (!next) return list.filter((ask) => ask.requestId !== requestId)
  const at = list.findIndex((ask) => ask.requestId === requestId)
  if (at === -1) return [...list, next]
  const replaced = list.slice()
  replaced[at] = next
  return replaced
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "batch":
      return action.actions.reduce(reducer, state)
    case "bootstrap":
      return { ...state, sessions: action.sessions }
    case "sessions": {
      /* The server's list is authoritative for every thread it knows about —
         but a draft is precisely one it has not been told about yet, so this
         merges rather than replaces. Replacing would make a new thread vanish
         under the user the moment any refresh landed. A draft whose id the
         server now reports has just been created: the server's row wins and the
         draft marker goes with it. */
      const known = new Set(action.sessions.map((session) => session.id))
      const drafts = state.sessions.filter((session) => session.draft && !known.has(session.id))
      /* Keep the object a row already had when the server's account of it has
         not moved (`sameRow`). Every consumer of a row is a subscription, and
         the most consequential of them is the chat panel, whose reaction to a
         new row object is to *open the thread* — so replacing the list wholesale
         turned every list refresh into an open, and an open landing inside
         another open is two peers on one session. Identity is the cheap half of
         fixing that; the other half is that opening stops keying on the row at
         all (see lib/thread/). */
      const previous = new Map(state.sessions.map((session) => [session.id, session]))
      const sessions = action.sessions.map((next) => {
        const old = previous.get(next.id)
        return old && sameRow(old, next) ? old : next
      })
      const merged = [...drafts, ...sessions]
      /* And when nothing moved at all, hand back the same *state* object, so
         the store's subscribers are not woken to be told so. Conservative on
         purpose: a false negative here costs one array allocation and the
         renders this used to cost unconditionally. */
      const unchanged =
        merged.length === state.sessions.length &&
        merged.every((session, i) => session === state.sessions[i])
      return unchanged ? state : { ...state, sessions: merged }
    }
    case "spawn-config":
      return {
        ...state,
        sessions: state.sessions.map((session) =>
          session.id === action.id
            ? {
                ...session,
                profileId: action.profileId,
                model: action.model,
                effort: action.effort,
                // Omitted by a server that predates personas — leave whatever
                // the row already carries rather than blanking it.
                ...(action.personaId === undefined ? {} : { personaId: action.personaId }),
                // Omitted by a server that predates the toggle — same bargain.
                ...(action.suggestFollowups === undefined ? {} : { suggestFollowups: action.suggestFollowups }),
                ...(action.uiBlocks === undefined ? {} : { uiBlocks: action.uiBlocks }),
              }
            : session
        ),
      }
    case "draft-session":
      return state.sessions.some((session) => session.id === action.session.id)
        ? state
        : { ...state, sessions: [action.session, ...state.sessions] }
    case "drop-draft-session":
      return {
        ...state,
        sessions: state.sessions.filter((s) => !(s.id === action.id && s.draft)),
      }
    /* Only while it is still a draft: once the thread exists, its agent owns
       the model and the settings menu talks ACP instead. */
    case "configure-draft":
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== action.id || !s.draft) return s
          /* A different agent or profile is a different set of settings, so the
             picks made against the old one are meaningless — carrying them over
             would replay a config id the new agent has never heard of. The mode
             ids are the agent's own, so they go with the config choices. */
          const rescoped =
            action.next.agentId !== undefined || action.next.profileId !== undefined
          return {
            ...s,
            ...action.next,
            ...(rescoped ? { configChoices: undefined, modeId: undefined } : null),
          }
        }),
      }
    case "pending-config":
      return withThread(state, action.id, {
        pendingConfig: action.patch
          ? { ...(thread(state, action.id).pendingConfig ?? {}), ...action.patch }
          : null,
      })
    case "staged-config":
      return withThread(state, action.id, { stagedConfig: action.config })
    case "thread-context":
      return withThread(state, action.id, { context: action.context })
    case "thread-tps":
      return withThread(state, action.id, { tps: action.tps })
    case "draft-config-option":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id && s.draft
            ? { ...s, configChoices: { ...s.configChoices, [action.configId]: action.value } }
            : s
        ),
      }
    case "thread-reset": {
      /* A replay buffers this reset until `caught_up`, while the socket can
         become live before that batch commits. Keep the phase the connection
         reducer has since written rather than restoring the stale phase that
         was captured when the replay began. */
      const phase = thread(state, action.id).phase
      return {
        ...state,
        threads: { ...state.threads, [action.id]: { ...action.thread, phase } },
      }
    }
    case "thread-window":
      return withThread(state, action.id, {
        ...(action.archived !== undefined ? { archived: action.archived } : {}),
        ...(action.earlier !== undefined ? { earlier: action.earlier } : {}),
        ...(action.loadingEarlier !== undefined ? { loadingEarlier: action.loadingEarlier } : {}),
      })
    case "thread-turns":
      return withThread(state, action.id, { turns: action.turns })
    case "thread-phase":
      return withThread(state, action.id, { phase: action.phase })
    case "thread-carry": {
      const items = thread(state, action.id).items
      /* Appended, and last, which is where they were: an unacknowledged bubble
         is always the newest thing in the thread, and a failure this client
         recorded is newer than everything the journal holds. */
      const missing = unclaimed(action.items, items)
      return missing.length === 0
        ? state
        : withThread(state, action.id, { items: [...items, ...missing] })
    }
    case "turn-active": {
      const next = withThread(state, action.id, {
        turnActive: action.active,
        liveUsage: null,
        ...(action.active || action.settle === false
          ? null
          : { items: settleTools(thread(state, action.id).items) }),
      })
      /* A turn is the activity the lists order by, and the server has just
         recorded one — but only for the thread it happened in, and the next
         `refreshSessions` is minutes away. Stamping it here is what moves a
         thread picked up after a week to the top of Recents as it is being
         used, rather than after the next refresh. The server's own value wins
         whenever that list lands.

         Only a turn *starting*: `turn_ended` is replayed, and stamping on it
         would make merely opening an old thread promote it to the top of
         Recents — reading is not activity, which is the same rule the server
         keeps by journaling nothing on attach. */
      if (!action.active) return next
      return {
        ...next,
        sessions: next.sessions.map((s) =>
          /* The turn beginning also clears the last one's failure, exactly as
             the server does on `turn_started`: a thread being worked on again
             must not still be drawn as the one that failed an hour ago. */
          s.id === action.id ? { ...s, lastActivityAt: Date.now(), lastTurnError: null } : s
        ),
      }
    }
    case "turn-verdict":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, lastTurnError: action.error } : s
        ),
      }
    case "update":
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.id]: applyMetaUpdate(
            thread(state, action.id),
            action.update,
            action.allowUserChunks,
            action.sessionId
          ),
        },
      }
    case "user-message":
      return withThread(state, action.id, {
        items: pushUserMessage(
          thread(state, action.id).items,
          action.text,
          Date.now(),
          action.turnId,
          action.local,
          action.attachments
        ),
      })
    case "tag-user-turn": {
      const items = thread(state, action.id).items
      /* The bubble this device drew and is now being told the turn id of —
         `local`, or a load replay's own untagged bubbles would be tagged
         instead, oldest first, leaving the real one untagged forever. */
      const index = items.findIndex((item) => item.kind === "user" && !item.turnId && item.local)
      if (index < 0) return state
      return withThread(state, action.id, {
        items: items.map((item, i) => i === index && item.kind === "user" ? { ...item, turnId: action.turnId } : item),
      })
    }
    case "drop-user-message": {
      const items = thread(state, action.id).items
      // The same untagged bubble `tag-user-turn` would have stamped — the
      // last one, since an optimistic message is always the newest thing.
      let index = -1
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.kind === "user" && !item.turnId && item.local) {
          index = i
          break
        }
      }
      if (index < 0) return state
      return withThread(state, action.id, { items: items.filter((_, i) => i !== index) })
    }
    case "queue":
      return withThread(state, action.id, { queue: action.items })
    case "notice": {
      // An identical rule twice in a row is one interruption, and the
      // transcript should say so once — but distinct consecutive rules stay
      // distinct, so rapid mid-turn mode/model/effort changes each draw a line.
      const items = thread(state, action.id).items
      const last = items[items.length - 1]
      if (last?.kind === "notice" && last.text === action.text) return state
      return withThread(state, action.id, {
        items: [
          ...items,
          {
            kind: "notice",
            id: mintItemId("notice"),
            text: action.text,
            at: Date.now(),
            ...(action.config ? { config: true as const } : {}),
          },
        ],
      })
    }
    case "error": {
      const items = thread(state, action.id).items
      const last = items[items.length - 1]
      // The same failure can arrive more than once — a reconnect loop repeats
      // itself on every attempt, and a replay restates a turn the live socket
      // already reported. Same failure, one row; whichever arrival knows the
      // prompt text donates Retry.
      if (last?.kind === "error" && last.title === action.title && last.reason === action.reason) {
        if (!action.retryText || last.retryText) return state
        return withThread(state, action.id, {
          items: [
            ...items.slice(0, -1),
            { ...last, retryText: action.retryText, retryAttachments: action.retryAttachments },
          ],
        })
      }
      const withRow: ThreadItem[] = [
        ...items,
        {
          kind: "error",
          id: mintItemId("error"),
          title: action.title,
          reason: action.reason,
          detail: action.detail,
          retryText: action.retryText,
          retryAttachments: action.retryAttachments,
          local: action.local,
          at: Date.now(),
        },
      ]
      return withThread(state, action.id, {
        // A prompt that died mid-turn leaves tool calls spinning forever — but
        // only settle when the agent is what failed. `settle: false` is a
        // failure of *this device's connection*, which says nothing about the
        // work: see the note on `settleTools`.
        items: action.settle === false ? withRow : settleTools(withRow),
      })
    }
    case "dismiss-error":
      return withThread(state, action.id, {
        items: thread(state, action.id).items.filter((i) => i.id !== action.itemId),
      })
    case "permission":
      return withThread(state, action.id, {
        permissions: upsertAsk(
          thread(state, action.id).permissions,
          action.requestId,
          action.permission
        ),
      })
    case "elicitation":
      return withThread(state, action.id, {
        elicitations: upsertAsk(
          thread(state, action.id).elicitations,
          action.requestId,
          action.elicitation
        ),
      })
    case "session-title":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id && s.title === "New thread" ? { ...s, title: action.title } : s
        ),
      }
    case "agent-session-title":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id && s.title !== "New thread" ? { ...s, title: action.title } : s
        ),
      }
    /* The sniff above yields to a name that was chosen; this one is that name,
       so it replaces whatever the title was. */
    case "rename-session":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, title: action.title } : s
        ),
      }
    /* The pin is the server's row; this is the same answer drawn before the
       list is read back, exactly as a rename is. */
    case "pin-session":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, pinnedAt: action.pinnedAt } : s
        ),
      }
    case "session-config":
      return withThread(state, action.id, {
        modes: action.modes,
        configOptions: action.configOptions ?? thread(state, action.id).configOptions,
        promptCapabilities:
          action.promptCapabilities ?? thread(state, action.id).promptCapabilities,
        canPause: action.canPause ?? thread(state, action.id).canPause,
        canCompact: action.canCompact ?? thread(state, action.id).canCompact,
      })
    case "paused":
      return withThread(state, action.id, {
        paused: action.paused,
        /* Absolute: a release clears the reason with the hold, so a card can
           never outlive the state that drew it. */
        pausedReason: action.paused ? action.reason ?? "user" : null,
        pausedError: action.paused ? action.error ?? null : null,
      })
    case "retry":
      return withThread(state, action.id, { retry: action.retry })
    case "mode": {
      const t = thread(state, action.id)
      return t.modes
        ? withThread(state, action.id, { modes: { ...t.modes, currentModeId: action.modeId } })
        : state
    }
    case "config-options":
      return withThread(state, action.id, { configOptions: action.configOptions })
    case "usage": {
      const current = thread(state, action.id)
      return withThread(state, action.id, {
        usage: addUsage(current.usage, action.usage),
        /* One journaled `turn_ended` supplies one usage reading, so replay
           cannot double-count either the thread total or the turn footer. */
        ...(action.turnId ? { turnUsage: { ...current.turnUsage, [action.turnId]: action.usage } } : null),
        ...(action.turnId && action.durationMs !== undefined
          ? { tps: addTps(current.tps, action.usage, action.durationMs, action.toolDurationMs) }
          : null),
      })
    }
    case "turn-timing": {
      const current = thread(state, action.id)
      return withThread(state, action.id, {
        ...(action.durationMs !== undefined
          ? { turnDuration: { ...current.turnDuration, [action.turnId]: action.durationMs } }
          : null),
        ...(action.toolDurationMs !== undefined
          ? { turnToolDuration: { ...current.turnToolDuration, [action.turnId]: action.toolDurationMs } }
          : null),
      })
    }
    case "ttft":
      return withThread(state, action.id, { ttftMs: action.ms })
    case "turn-changes": {
      const current = thread(state, action.id)
      return withThread(state, action.id, {
        turnChanges: { ...current.turnChanges, [action.turn.turnId]: action.turn },
      })
    }
    /* The seed on open. Merged over, not replaced: a live nudge that landed
       while the GET was in flight is newer than the list it beat. */
    case "turn-changes-all": {
      const turnChanges = { ...thread(state, action.id).turnChanges }
      for (const turn of action.turns) if (!turnChanges[turn.turnId]?.ended) turnChanges[turn.turnId] = turn
      return withThread(state, action.id, { turnChanges })
    }
    /* Absolute, like the queue: the server sends the whole reading, never a
       delta, so there is nothing to merge. */
    case "quota":
      return withThread(state, action.id, { quota: action.quota })
    default:
      return state
  }
}
