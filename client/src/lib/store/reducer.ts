import type * as acp from "@daedalus/acp"
import type {
  AttachmentRef,
  CallsVia,
  QueuedMessage,
  QuotaSnapshot,
  SessionUpdate,
  StagedConfig,
  ThreadRetry,
  TurnChanges,
  TurnTick,
  TpsStats,
  TurnGeneration,
  WireError,
} from "@daedalus/protocol"
import { sameRow } from "../settings"
import type { AskProfiles, SessionMeta } from "../settings"
import { unclaimed } from "../thread/carry"
import type { ConnPhase } from "../thread/phase"
import { mintItemId } from "./items"
import type { ErrorItem, PendingElicitation, PendingPermission, TextItem, ThreadItem } from "./items"
import { emptyThread } from "./thread"
import type { State, ThreadState } from "./thread"
import { applyMetaUpdate, settleTools } from "./session-update"
import { addTps } from "@daedalus/tps"
import { addUsage, pushUserMessage } from "./messages"

// ---- reducer ----

export type Action =
  /** One page of the sidebar's thread list (`GET /api/sessions/page`). `ids`
      are the *window* rows of this page — the ones `offset` advances by, and
      (on a `reset`) the only ones the list is allowed to drop; `total` is how
      many live threads the server holds behind them. `reset` replaces the
      window, an append extends it. */
  | { type: "session-page"; sessions: SessionMeta[]; ids: string[]; total: number; reset: boolean }
  /** Rows loaded outside the page — a thread asked for by id because a tab or a
      URL names it and it sits past the loaded window. Merged in and never a
      window row, so a later page cannot drop it. */
  | { type: "session-extra"; sessions: SessionMeta[] }
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
          | "suggestKinds"
          | "uiGroups"
          | "personaId"
          | "askProfiles"
          | "helperModels"
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
      suggestKinds?: string[]
      uiGroups?: string[]
      personaId?: string | null
      helperModels?: { role: string; model: string }[]
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
  /** Background work the agent launched is still running, or has finished.
      Absolute, from the `background` event and the `background` field of
      `caught_up`. */
  | { type: "background"; id: string; active: boolean }
  /** The thread's agent is on this tab of its project's browser
      (`browser_activity`). Live-only: never journaled, never replayed. */
  | { type: "browser-activity"; id: string; projectId: string; tabId: string }
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
  | {
      type: "update"
      id: string
      update: SessionUpdate
      allowUserChunks?: boolean
      sessionId?: string
      at?: number
      /** Where the merged run this update stands for ended, on a replay — the
          other end of `at` (see the `update` event in protocol.ts). */
      endAt?: number
      historyText?: string
      historyAttachments?: TextItem["attachments"]
    }
  /** `local` = this device typed it (see `TextItem.local`); the replay's own
      user bubbles and the ones a `turn_started` mints are not. */
  | {
      type: "user-message"
      id: string
      text: string
      turnId?: string
      local?: boolean
      sending?: boolean
      attachments?: TextItem["attachments"]
      /** The journal's stamp on a replayed turn; absent = now. */
      at?: number
    }
  | { type: "tag-user-turn"; id: string; turnId: string }
  | { type: "settle-user-message"; id: string }
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
      notInstalled?: ErrorItem["notInstalled"]
      severity?: ErrorItem["severity"]
      stopped?: boolean
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
  /** The create call was accepted: the row stops being a draft now, not after
      the list read that replaces it with the server's own. */
  | { type: "promote-draft"; id: string }
  | { type: "pin-session"; id: string; pinnedAt: number | null }
  | { type: "hide-session"; id: string; hiddenAt: number | null }
  | { type: "notify-session"; id: string; notify: boolean | null }
  | { type: "ask-profiles-session"; id: string; askProfiles: AskProfiles }
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
      callsVia?: CallsVia
    }
  | { type: "mode"; id: string; modeId: string }
  | { type: "config-options"; id: string; configOptions: acp.SessionConfigOption[] }
  | {
      type: "usage"
      id: string
      usage: acp.Usage
      turnId?: string
      durationMs?: number
      toolDurationMs?: number
      generation?: TurnGeneration
    }
  | {
      type: "turn-timing"
      id: string
      turnId: string
      durationMs?: number
      toolDurationMs?: number
      generation?: TurnGeneration
    }
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

function markWaiting(items: ThreadItem[], toolCallId: string | undefined, now: number): ThreadItem[] {
  if (!toolCallId) return items
  return items.map((i) =>
    i.kind === "tool" && i.id === toolCallId && i.waitingSince === undefined ? { ...i, waitingSince: now } : i
  )
}

function markAnswered(items: ThreadItem[], toolCallId: string | undefined, now: number): ThreadItem[] {
  if (!toolCallId) return items
  return items.map((i) =>
    i.kind === "tool" && i.id === toolCallId && i.waitingSince !== undefined
      ? { ...i, waitingSince: undefined, waitedMs: (i.waitedMs ?? 0) + Math.max(0, now - i.waitingSince) }
      : i
  )
}

/** One row per id, in first-seen order, with the *latest* reading winning. The
    store's session list is a union of pages and one-off loads, and the same
    thread can arrive in more than one of them (a pinned row that is also the
    first page's) — the freshest copy is the one to keep. */
function dedupeRows(rows: SessionMeta[]): SessionMeta[] {
  const order: string[] = []
  const last = new Map<string, SessionMeta>()
  for (const row of rows) {
    if (!last.has(row.id)) order.push(row.id)
    last.set(row.id, row)
  }
  return order.map((id) => last.get(id) as SessionMeta)
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "batch":
      return action.actions.reduce(reducer, state)
    case "session-page": {
      /* The list is a window now (the sidebar pages it), so a page either
         extends it or — on a `reset` — replaces the window the server just
         recounted. Identity is kept where the server's account of a row has not
         moved (`sameRow`), the same bargain the whole-list refresh made: every
         consumer of a row is a subscription, and the chat panel's reaction to a
         new row object is to *open the thread*. */
      const previous = new Map(state.sessions.map((session) => [session.id, session]))
      const incoming = action.sessions.map((next) => {
        const old = previous.get(next.id)
        return old && sameRow(old, next) ? old : next
      })
      if (action.reset) {
        /* A reset is the server's account of the window, so a row it no longer
           names is gone — purged, or trashed on another device. The rows the
           window never held stay: a draft, which no server list carries, and a
           row this device asked for by id (a pinned thread, an open tab), which
           is not a window row and so is nobody's to drop here. */
        const window = new Set(state.sessionWindow.ids)
        const kept = state.sessions.filter((session) => !window.has(session.id))
        return {
          ...state,
          sessions: dedupeRows([...kept, ...incoming]),
          sessionWindow: { ids: action.ids, total: action.total },
        }
      }
      return {
        ...state,
        sessions: dedupeRows([...state.sessions, ...incoming]),
        sessionWindow: { ids: [...state.sessionWindow.ids, ...action.ids], total: action.total },
      }
    }
    case "session-extra": {
      const previous = new Map(state.sessions.map((session) => [session.id, session]))
      const incoming = action.sessions.map((next) => {
        const old = previous.get(next.id)
        return old && sameRow(old, next) ? old : next
      })
      const merged = dedupeRows([...state.sessions, ...incoming])
      /* Conservative no-op, so an ensure that named rows already held does not
         wake every subscriber. */
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
                // Omitted by a server that predates the toggle — same bargain.
                ...(action.suggestKinds === undefined ? {} : { suggestKinds: action.suggestKinds }),
                ...(action.uiGroups === undefined ? {} : { uiGroups: action.uiGroups }),
                ...(action.personaId === undefined ? {} : { personaId: action.personaId }),
                ...(action.helperModels === undefined ? {} : { helperModels: action.helperModels }),
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
             ids are the agent's own, and the helper models name ids in the old
             profile's catalog, so they go with the config choices. */
          const rescoped =
            action.next.agentId !== undefined || action.next.profileId !== undefined
          return {
            ...s,
            ...(rescoped ? { configChoices: undefined, modeId: undefined, helperModels: undefined } : null),
            ...action.next,
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
            action.sessionId,
            action.at,
            action.historyText,
            action.historyAttachments,
            action.endAt
          ),
        },
      }
    case "user-message":
      return withThread(state, action.id, {
        items: pushUserMessage(
          thread(state, action.id).items,
          action.text,
          action.at ?? Date.now(),
          action.turnId,
          action.local,
          action.attachments,
          action.sending
        ),
      })
    case "tag-user-turn": {
      const items = thread(state, action.id).items
      /* The server reply acknowledges the newest optimistic bubble this device
         sent. Older untagged local rows may have survived a reconnect while a
         previous reply was in flight. */
      let index = -1
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.kind === "user" && !item.turnId && item.local) {
          index = i
          break
        }
      }
      if (index < 0) return state
      return withThread(state, action.id, {
        items: items.map((item, i) =>
          i === index && item.kind === "user" ? { ...item, turnId: action.turnId, sending: false } : item
        ),
      })
    }
    case "settle-user-message": {
      const items = thread(state, action.id).items
      let index = -1
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.kind === "user" && !item.turnId && item.local && item.sending) {
          index = i
          break
        }
      }
      if (index < 0) return state
      return withThread(state, action.id, {
        items: items.map((item, i) => i === index && item.kind === "user" ? { ...item, sending: false } : item),
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
          notInstalled: action.notInstalled,
          severity: action.severity,
          stopped: action.stopped,
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
    case "promote-draft":
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.id === action.id ? { ...s, draft: false } : s)),
      }
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
    case "hide-session":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, hiddenAt: action.hiddenAt } : s
        ),
      }
    case "notify-session":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, notify: action.notify } : s
        ),
      }
    case "ask-profiles-session":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, askProfiles: action.askProfiles } : s
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
        callsVia: action.callsVia ?? thread(state, action.id).callsVia,
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
    case "background": {
      const t = thread(state, action.id)
      /* No-op when unchanged: the event is only sent on a transition, but a
         `caught_up` says it every attach. */
      return t.background === action.active ? state : withThread(state, action.id, { background: action.active })
    }
    case "browser-activity":
      return withThread(state, action.id, {
        browserTab: { projectId: action.projectId, tabId: action.tabId, at: Date.now() },
      })
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
        ...(action.turnId
          ? {
              tps: addTps(current.tps, {
                outputTokens: action.usage.outputTokens,
                durationMs: action.durationMs,
                toolDurationMs: action.toolDurationMs,
                generation: action.generation,
              }),
            }
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
        ...(action.generation
          ? { turnGeneration: { ...current.turnGeneration, [action.turnId]: action.generation } }
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
