/* The plumbing every other action group is built on, plus the three actions
   that are about a session *row* rather than about a running thread.

   Split out of the one 1500-line `useActions` memo; see `lib/actions.ts` for
   the map of where each group went. Nothing here is a hook: the whole object
   is still built inside `useActions`'s single `React.useMemo`, so the hook
   sequence and every callback's identity are exactly what they were. */

import type { AttachmentRef } from "@daedalus/protocol"
import type { QueryClient } from "@tanstack/react-query"
import { pruneDrafts } from "../drafts"
import { prunePastes } from "../pastes"
import { pruneDraftAttachments } from "../draft-attachments"
import { loadDraftSessions, pruneDraftSessions } from "../draft-sessions"
import { loadLayout, savedThreadIds } from "../workspace/layout"
import { panelId } from "../workspace/panels"
import { api, profileSupports, type ServerSettings, type SessionMeta, type SessionPage } from "../settings"
import { knownAgentOptions, optionKey, shownOptions } from "../agent-options"
import { partitionSessionOptions } from "../session-options"
import { scheduledKey } from "../queries/keys"
import type { useCatalogReader } from "../queries/catalog"
import type { ScheduleInput } from "../queries/routines"
import { fetchQuota, planReadable } from "../quota"
import type { Action, StoreHandle } from "../store"
import { threadRegistry } from "../thread/registry"
import type { ThreadConnection } from "../thread/connection"
import { recordThreadError } from "../thread/record-error"
import { DEFAULT_SUGGEST_KINDS } from "../suggestions"
import { DEFAULT_UI_GROUPS } from "../openui/groups"
import {
  serverReachable,
  startHealthPoll,
  watchNetwork,
} from "../thread/network-watch"

export const postJson = <T,>(settings: ServerSettings, path: string, body: unknown): Promise<T> =>
  api<T>(settings, path, { method: "POST", body: JSON.stringify(body) })

/** Threads per page of the sidebar's list (`GET /api/sessions/page`). Big
    enough that the fold-shut folders and the flat tiers are all covered by the
    first read, small enough that a server holding thousands never answers with
    them all. */
const PAGE_SIZE = 40

/** One row per id, first reading in place. A page folds the window, the trash
    and the pins into one list, and the same thread can be in two of them. */
function dedupeById(rows: SessionMeta[]): SessionMeta[] {
  const seen = new Set<string>()
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
}

/** What `useActions` reads out of React, handed to every group as one object. */
export interface CoreDeps {
  settings: ServerSettings
  dispatch: (action: Action) => void
  getState: StoreHandle["getState"]
  queryClient: QueryClient
  catalog: ReturnType<typeof useCatalogReader>
}

export function createCore(deps: CoreDeps) {
  const { settings, dispatch, getState, catalog } = deps

  /**
   * Every thread this device holds a connection to.
   *
   * One object per thread, holding its socket, its journal cursor, its open
   * chain and its reconnect ladder — see lib/thread/registry.ts for what that
   * replaces. Everything below that used to reach into a module-level map
   * asks the registry for a connection instead, which is also the only thing
   * that can make one.
   *
   * One per page, not one per memo: the registry holds live sockets and has
   * to outlive React exactly as the maps it replaces did. This call re-points
   * the existing one at the rebuilt `dispatch`/`getState`/`settings` rather
   * than making a second.
   */
  const threads = threadRegistry({
    deps: {
      settings,
      dispatch,
      getState,
      projects: () => catalog.projects(),
      projectsLoaded: () => catalog.projectsLoaded(),
      refreshSessions: async () => {
        await refreshSessions()
      },
    },
    probe: serverReachable,
    onParked: startHealthPoll,
  })

  /* Failures that belong to a thread are recorded IN that thread, not in a
     toast: the transcript is where the user is looking, it survives the four
     seconds a toast lives, and it is the only place that can offer the one
     useful next step (send that prompt again). */
  const recordError = (
    sessionId: string,
    err: unknown,
    context: string,
    /* What sending this again would carry. A bare string is the prompt text;
       the object form adds the refs it went out with, which is what the row's
       "Retry as file paths" re-sends. `undefined` is a deliberate answer: the
       words are somewhere else (back in the composer), and one Retry button
       beside them would send the same message twice. */
    retry?: string | { text?: string; attachments?: AttachmentRef[] },
    emit: (action: Action) => void = dispatch,
    settle = true
  ) => {
    const carried = typeof retry === "string" ? { text: retry } : retry
    return recordThreadError(emit, sessionId, err, context, {
      retryText: carried?.text,
      retryAttachments: carried?.attachments,
      settle,
    })
  }

  /** The connection for a thread, only if this device already has one — for
      readers that must not bring one into existence by asking about it. */
  const known = (sessionId: string): ThreadConnection | undefined => threads.get(sessionId)

  /** The socket a queue command goes down. Same refusal `send` gives a thread
      with no connection: the words are recorded, not lost. Through `known`,
      so a command against a thread this device has never opened fails without
      leaving an inert connection behind to prove it. */
  const requireLive = (sessionId: string) => {
    const conn = known(sessionId)
    if (!conn) {
      throw new Error(
        "This thread has no live connection to its agent — revive it and send again."
      )
    }
    return conn.requireLive()
  }

  /** The create requests in flight, by thread — what "Cancel" on a long
      start aborts. */
  const starting = new Map<string, AbortController>()

  /** Give up waiting on a thread that is starting or reviving. Only the
      request is abandoned: the server finishes what it began, and the create
      is idempotent on the client's id, so sending again picks it up. */
  const cancelWait = (sessionId: string) => {
    starting.get(sessionId)?.abort()
    known(sessionId)?.cancelWait()
  }

  /** Bring a draft into existence: tell the server (which spawns the agent
      and handshakes), adopt its row, then attach. The id travelled from the
      client, so the route the user is already looking at needs no correction.

      `first` is the message that created it, and it rides the POST: the
      server starts the turn before answering, so the words are on the server
      the moment the thread is. They used to follow over a socket opened
      afterwards — a reload in that window lost a message the composer had
      already cleared. Answers the turn it started, or why it could not; a
      failure after the POST landed is not thrown, because the thread exists
      and its message went. */
  const createSession = async (
    meta: SessionMeta,
    first?: { text: string; attachmentIds: string[] },
    onAccepted?: () => void
  ): Promise<{ turnId?: string; promptError?: string }> => {
    /* The catalog is the query cache's now, read the same way `getState`
       is read here: inside the callback, last-committed, no subscription. */
    const project = catalog.projects().find((p) => p.id === meta.projectId)
    const profile = catalog.profiles().find((p) => p.id === meta.profileId)
    if (!project) throw new Error("Choose a project for this thread before sending.")
    if (!profile) throw new Error("Choose a profile for this thread before sending.")
    /* Spawning the agent and handshaking takes a second or two, and this is
       what says so: without it the thread sits there looking like nothing had
       happened to the message just sent. It is also what takes the composer's
       send button out of service for the duration, which is what stops a
       second Enter from POSTing the same session id again. */
    threads.for(meta.id).markStarting()
    /* What the draft menu *showed*, resolved through the same reader and the
       same sibling fallback as `DraftConfig`: the mode is its own pick, else
       the remembered `modes.currentModeId` the row fell back to, and every
       agent option (the agent-owned model and effort among them) is the
       remembered value with the picks laid over. Only the picks used to
       travel, so a value that was displayed but never clicked started the
       agent on its default. */
    const known = knownAgentOptions(
      optionKey(profile.id, meta.agentId),
      catalog
        .profiles()
        .filter((p) => p.id !== profile.id && profileSupports(p, meta.agentId))
        .map((p) => optionKey(p.id, meta.agentId))
    )
    const modeId = meta.modeId || known.modes?.currentModeId
    /* …minus the model and the effort. Those two travel as `model`/`effort`
       below — the draft picked them there — and sending them here as well
       means sending them twice, from two different memories: the pick, and
       whatever the remembered set (possibly a *sibling* profile's, borrowed
       above) was last on. The server applies this set after the spawn, so the
       second one won and the thread ran on a model nobody chose. `rest` is the
       same partition every menu draws these with. */
    const configChoices = Object.fromEntries(
      partitionSessionOptions(
        shownOptions(known, meta.configChoices, meta.model, meta.effort),
        new Set(known.modes?.availableModes.map((m) => m.id) ?? [])
      ).rest.map((o) => [o.id, o.currentValue])
    )
    const abort = new AbortController()
    starting.set(meta.id, abort)
    const reply = await api<{ id: string; turnId?: string; promptError?: string }>(settings, "/api/sessions", {
      method: "POST",
      signal: abort.signal,
      body: JSON.stringify({
        id: meta.id,
        profileId: profile.id,
        /* The thread is a (profile, agent) pair: the profile may serve several
           agents, and which one answers is the draft's own pick. */
        agentId: meta.agentId,
        projectId: project.id,
        model: meta.model || undefined,
        effort: meta.effort || undefined,
        /* The permission mode picked against the agent's remembered `modes` —
           applied by the server right after session/new, and replaced by the
           live thread's own mode state from then on. */
        modeId: modeId || undefined,
        /* Which closing blocks answers should carry. Picked on the draft, and
           free for the same reason. `??` rather than `||`, so an explicit empty
           set (everything off) survives the trip instead of reading as unset. */
        suggestKinds: meta.suggestKinds ?? [...DEFAULT_SUGGEST_KINDS],
        /* Which component groups the drawn-view lane teaches; empty is the lane
           off, unset is all of them (the server's own reading of an absent set). */
        uiGroups: meta.uiGroups ?? [...DEFAULT_UI_GROUPS],
        /* Which profile and model `ask_agent` uses per agent — free on the
           draft, and read by the server at ask time, never at spawn. */
        askProfiles: meta.askProfiles ?? {},
        /* The agent options as the draft showed them. The server applies them
           the moment session/new answers, best-effort and only where they
           differ from what it came up on: a remembered option the agent no
           longer offers must not stop the message that created the thread. */
        configChoices,
        /* The role→model helper map picked on the draft (docs/model-roles.md).
           A spawn input like `model`/`effort`: the server writes it on the row
           and ships it to the agent's env, never a post-handshake replay. */
        helperModels: meta.helperModels ?? [],
        /* The thread's own tool picks, on top of the project's and the
           profile's — the server links what still exists and spawns with
           the union. */
        mcpServerIds: meta.mcpServerIds ?? [],
        skillIds: meta.skillIds ?? [],
        commandIds: meta.commandIds ?? [],
        /* "Isolate in a git worktree": the server makes the checkout first and
           spawns the agent in it. */
        worktree: meta.isolate === true || undefined,
        /* An aside says which thread it was selected in and on what. */
        aside:
          meta.asideQuote && meta.forkedFromSessionId
            ? { of: meta.forkedFromSessionId, quote: meta.asideQuote }
            : undefined,
        /* A thread started on a board task: the server checks the card, briefs
           the agent and carries the harness MCP it needs. */
        taskId: meta.taskId ?? undefined,
        /* A draft renamed before it was ever sent to: the name travels with
           the create call, and the server's first-prompt sniff then leaves
           it alone. Left out when nobody has named it, so the sniff still
           titles the thread from what was typed. */
        title: meta.title && meta.title !== "New thread" ? meta.title : undefined,
        prompt: first,
      }),
    }).finally(() => starting.delete(meta.id))
    onAccepted?.()
    /* The bubble this device drew is the turn the server just journaled, and
       tagged it is no longer carried across an attach (carry.ts): the replay's
       own `turn_started` redraws it, so it is drawn once. Tagged HERE, before
       `refreshSessions` — that refresh swaps the row, which re-runs the chat
       panel's open effect, and an attach that lands while the bubble is still
       untagged carries it AND replays it: the message twice. */
    if (reply.turnId) dispatch({ type: "tag-user-turn", id: meta.id, turnId: reply.turnId })
    /* The thread exists now. Say so in the store at once — the list read below
       is a round trip, and until it lands the composer would keep drawing the
       draft's menu for a thread that is already running. */
    dispatch({ type: "promote-draft", id: meta.id })
    // Swaps the draft row for the server's own — see the `sessions` reducer.
    /* The POST landed: a failed refresh must not read as an unsent turn (a
       retry would duplicate the message). */
    const listed = await refreshSessions().catch(() => [] as SessionMeta[])
    /* Through the connection's own open chain: that refresh is what makes the
       chat panel re-run its open effect (the row it reads is a new object), so
       by the time this line is reached an open for this thread may already be
       in flight. On the chain it either waits for that one and finds it
       connected, or it is the one that connects.

       The row comes from what the refresh *fetched*, never from `getState()`.
       That read is a microtask after the dispatch and React has not committed
       yet, so it handed back the row as it was a moment ago — which for the
       thread that has just been created is still `draft: true`. `openNow`'s
       first guard is "a draft has nothing to connect to", so the open returned
       having done nothing, the phase stayed on `starting`, and the `ready()`
       below then reported the thread as stuck waiting for an agent that had in
       fact spawned, handshaked and was sitting there attached. The panel's own
       effect opened it a tick later, which is why the thread was live on the
       server while the composer said it could not be brought back online.

       The fallback drops the draft marker rather than reusing the row as-is:
       the server has answered 201, so whatever the store still says, this
       thread is not a draft any more. */
    const created =
      listed.find((session) => session.id === meta.id) ?? ({ ...meta, draft: false } as SessionMeta)
    if (!reply.turnId) {
      await threads.for(meta.id).open(created)
      return reply
    }
    try {
      /* `fresh`: nothing on the server is news to this device, so no HTTP read
         in front of the socket — the turn's answer arrives on a socket or not
         at all. */
      await threads.for(meta.id).open(created, { revive: true, fresh: true, seamless: true })
    } catch (error) {
      /* The thread exists and its turn is running — only this device is not
         watching it. Said in the thread; the next send's `ready` opens it. */
      threads.for(meta.id).markIdle()
      dispatch({ type: "turn-active", id: meta.id, active: false })
      recordError(meta.id, error, "Couldn't connect to this thread")
    }
    return reply
  }

  /* Point the window-level watchers — `online`, `visibilitychange`, the
     shared health probe and the park poll — at this connection's registry.
     They outlive React and there is one of each per page, so the module
     installs them once and this only re-aims them; the last connection bound
     is the live one, which is the rule the module-level bound callbacks
     followed before. */
  /**
   * Read one page of the thread list and fold it into the store.
   *
   * `reset` replaces the window (a boot or a refresh); otherwise the page
   * extends it (a scroll to the bottom). Either way the rows the sidebar draws
   * are the page itself plus the two sets a recent window can never carry — the
   * trash and every pinned thread — and the rows are handed back for the
   * callers that read a thread out of a refresh (`createSession`, the fork).
   */
  const fetchSessionPage = async (offset: number, limit: number, reset: boolean): Promise<SessionMeta[]> => {
    const page = await api<SessionPage>(settings, `/api/sessions/page?limit=${limit}&offset=${offset}`)
    const rows = dedupeById([...page.sessions, ...page.trashed, ...page.pinned, ...(page.children ?? [])])
    dispatch({
      type: "session-page",
      sessions: rows,
      ids: page.sessions.map((session) => session.id),
      total: page.total,
      reset,
    })
    return rows
  }

  /** The next page of the sidebar's list, if the server holds one. Called when
      the reader scrolls to the bottom of the sidebar — this is the "on demand"
      half; nothing above ever pulls the whole list into the store. */
  const loadMoreSessions = async (): Promise<void> => {
    const { ids, total } = getState().sessionWindow
    if (ids.length >= total) return
    await fetchSessionPage(ids.length, PAGE_SIZE, false)
  }

  /**
   * Load specific threads by id, whatever their age — a restored tab, the
   * thread a URL names, an open panel. The window is the sidebar's; a thread it
   * does not hold is not an error, it just has to be asked for by name.
   */
  const ensureSessionsLoaded = async (ids: readonly string[]): Promise<void> => {
    const have = new Set(getState().sessions.map((session) => session.id))
    const missing = [...new Set(ids)].filter((id) => id && !have.has(id))
    if (missing.length === 0) return
    const rows = await api<SessionMeta[]>(
      settings,
      `/api/sessions?ids=${missing.map(encodeURIComponent).join(",")}`
    )
    if (rows.length > 0) dispatch({ type: "session-extra", sessions: rows })
  }

  const refreshSessions = async () => {
    /* Refresh exactly what is loaded: the window, re-read from the top. Asking
       for the whole list here is the thing the paged route exists to avoid — a
       refresh is not a reason to pull every thread the server holds. The rows
       the window never held (open tabs, pins) are kept by the reducer's reset
       and re-counted below. */
    const state = getState()
    const loaded = Math.max(PAGE_SIZE, state.sessionWindow.ids.length)
    const sessions = await fetchSessionPage(0, loaded, true)
    // The server's list is the authority on what still exists, so this is the
    // one place that can tell a stale draft from a live one — except for
    // threads the server has never been told about. A draft thread is exactly
    // that, and pruning against the server alone would delete the half-written
    // message that has not been sent yet.
    const windowIds = new Set(state.sessionWindow.ids)
    const ids = [
      ...sessions.map((session) => session.id),
      // Rows the window never held — a draft, or a thread kept for a reason of
      // its own — are still threads this device may hold a socket for.
      ...state.sessions.filter((s) => s.draft || !windowIds.has(s.id)).map((s) => s.id),
    ]
    /* Composer sidecars and draft-session rows are scoped by window, so this
       refresh prunes only data owned by this workspace. */
    pruneDrafts(ids)
    prunePastes(ids)
    pruneDraftAttachments(ids)
    pruneDraftSessions(settings.id, ids)
    /* A connection leaks the same way the device-local stores do — a cursor,
       a backoff timer or a live socket for a thread the server no longer
       reports is never coming back on its own. Same authority, same sweep,
       and now one call per thread rather than six that could disagree about
       what forgetting one means. (A trashed thread is still in the list, so
       its socket is not torn down here; the deleted branch of a reconnect
       owns that.) */
    threads.sweep(new Set(ids))
    /* Handed back, and this is not a convenience. `getState()` reads a ref the
       store writes in a *layout effect* (see `StoreProvider`), so it does not
       reflect the dispatch above until React has committed — and the caller's
       next line is a microtask, which runs before any commit. A caller that
       re-read the store here to find the row it had just created was therefore
       guaranteed to read the row as it was *before* the refresh. The list this
       returns is the same authority the dispatch carries, available now. */
    return sessions
  }

  /* Point the window-level watchers — `online`, `visibilitychange`, the
     shared health probe and the park poll — at this connection's registry and
     session refresh action. */
  watchNetwork({ settings, registry: threads, refreshSessions })

  /** Reattach, reviving the agent if it is gone. The connection owns the
      guards, the chain and the ladder; this names the entry point the UI
      offers and leaves the failure in the thread before it propagates — a
      caller that only toasts still leaves something to read where the Revive
      button is. */
  const reconnectThread = async (sessionId: string) => {
    try {
      await threads.for(sessionId).revive(serverReachable)
    } catch (error) {
      recordError(sessionId, error, "Couldn't connect to this thread", undefined, dispatch, false)
      throw error
    }
  }

  return {
    ...deps,
    threads,
    recordError,
    known,
    requireLive,
    createSession,
    cancelWait,
    fetchSessionPage,
    loadMoreSessions,
    ensureSessionsLoaded,
    refreshSessions,
    reconnectThread,
  }
}

/** Everything the groups below share — `createCore`'s own product plus the
    React-owned readers it was built from. */
export type ActionsCore = ReturnType<typeof createCore>

/** The three actions that are about a session row rather than a live thread,
    kept beside `createSession`/`refreshSessions` because each is a thin skin
    over one of them. */
export function sessionActions(core: ActionsCore) {
  const {
    settings,
    dispatch,
    getState,
    queryClient,
    catalog,
    createSession,
    fetchSessionPage,
    ensureSessionsLoaded,
    refreshSessions,
  } = core

  return {
    refreshSessions,
    loadMoreSessions: core.loadMoreSessions,
    ensureSessionsLoaded: core.ensureSessionsLoaded,

    /**
     * The first page of the sessions list, and the tabs it has to cover: every
     * catalog the boot used to read alongside it is the query cache's now,
     * fetched by the components that draw it. Kept as an action because the
     * session list is the reducer's and because `Connected` needs one promise
     * to gate the shell on.
     */
    async bootstrap() {
      const sessions = await fetchSessionPage(0, PAGE_SIZE, true)
      /* ── Unsent threads come back with their tabs ──
         A draft has no server row, so the page above cannot carry it — and
         without it, boot's `prunePanels` closes every draft tab the saved dock
         layout restored, and the debounced layout save makes that permanent.
         The row is re-minted only for a draft the layout still names: a draft
         whose tab was closed stays closed, and one the server now reports is
         an ordinary thread and comes from the list. */
      const known = new Set(sessions.map((session) => session.id))
      const restored = new Set(Object.keys(loadLayout(settings.id)?.panels ?? {}))
      const kept = new Set<string>()
      for (const draft of loadDraftSessions(settings.id)) {
        if (known.has(draft.id)) continue
        if (!restored.has(panelId({ kind: "chat", sessionId: draft.id }))) continue
        dispatch({ type: "draft-session", session: draft })
        kept.add(draft.id)
      }
      /* A stored row with neither a server behind it nor a tab in front of it
         is one nobody can ever act on again — the console's own draft when the
         page was reloaded while it was up, most of all. The boot sweep is the
         only place that can see both answers at once, and an id the server
         reports has stopped being a draft at all. */
      pruneDraftSessions(settings.id, kept)
      /* ── The tabs the window has to cover ──
         The list is a page now, so a thread an older tab names may sit past it
         — and the dock's prune closes any chat panel whose session the store
         does not hold. Every thread a saved layout (any space, plus what was
         filed to one) still names is loaded, whatever its age, so the restore
         keeps every tab it had. A draft is not on the server; it came back
         through the loop above, and the id lookup simply answers nothing. */
      await ensureSessionsLoaded(savedThreadIds(settings.id))
      return { sessions }
    },

    /**
     * Read this thread's plan usage once, on demand.
     *
     * The socket sends one of these after every settled turn, so a thread that
     * has been worked in already has one; this is for the other case — a
     * thread just opened, or an archived one with no process at all, whose
     * stats popover someone expanded. It asks under the thread's *own*
     * profile, and only when that pair has a plan to read (`planReadable`):
     * the profile's own provider, or the machine's own login on an agent's
     * Default profile. A thread on a stored profile with neither has no plan
     * windows by construction, and the reading an agent probe would give back
     * is about a login that thread never spent — Settings › Usage is where
     * that answer lives.
     *
     * Failures are swallowed. The number is ambient, nobody asked a question
     * by opening a popover, and a missing `claude` binary would otherwise
     * raise a toast on every thread on the machine. Settings › Usage is where
     * the failure is reported, because there it is the answer.
     */
    async loadQuota(meta: SessionMeta) {
      /* Nothing to read means nothing to ask: asking anyway would spawn the
         agent's CLI probe for a card the composer will not draw. */
      const profile = catalog.profiles().find((p) => p.id === meta.profileId)
      const agent = catalog.agents().find((a) => a.id === meta.agentId)
      if (!planReadable(profile, agent)) return
      try {
        const quota = await fetchQuota(settings, meta.agentId, { profileId: meta.profileId })
        dispatch({ type: "quota", id: meta.id, quota })
      } catch {
        /* ambient */
      }
    },

    /**
     * For a draft thread, the draft is materialized first (the server only
     * schedules threads it knows), mirroring `send` — which is why this one
     * still lives here when every other schedule write moved to the query
     * hooks (lib/queries/routines.ts): it needs the reducer's draft, and
     * the reducer is the one slice that did not move. The invalidation is
     * the refresh.
     */
    async createSchedule(input: ScheduleInput) {
      // A draft has no server row to schedule against — bring it into being
      // the way sending its first message would, then schedule the real one.
      const draft = getState().sessions.find(
        (s) => s.id === input.sessionId && s.draft
      )
      if (draft) {
        await createSession(draft)
      }
      await postJson(settings, "/api/scheduled", input)
      await queryClient.invalidateQueries({ queryKey: scheduledKey(settings) })
    },

    /** Reattach to a thread whose socket was closed while the agent process is
        still alive — e.g. another device took it over (close code 4002).
        The same call as reviving: the open respawns only if `meta.exited`, and
        both clear the ladder first because both were asked for. */
    reconnectThread: core.reconnectThread,

    reviveThread: core.reconnectThread,
  }
}
