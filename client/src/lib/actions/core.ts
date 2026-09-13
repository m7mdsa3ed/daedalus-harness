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
import { loadLayout } from "../workspace/layout"
import { panelId } from "../workspace/panels"
import { api, profileSupports, type ServerSettings, type SessionMeta } from "../settings"
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
import {
  serverReachable,
  startHealthPoll,
  watchNetwork,
} from "../thread/network-watch"

export const postJson = <T,>(settings: ServerSettings, path: string, body: unknown): Promise<T> =>
  api<T>(settings, path, { method: "POST", body: JSON.stringify(body) })

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

  /** Bring a draft into existence: tell the server (which spawns the agent
      and handshakes), adopt its row, then attach. The id travelled from the
      client, so the route the user is already looking at needs no correction. */
  const createSession = async (meta: SessionMeta) => {
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
    await api<{ id: string }>(settings, "/api/sessions", {
      method: "POST",
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
        /* How this thread should be worked on. Picked on the draft like the
           rest of this, and — unlike a started thread's — free: nothing is
           running yet, so there is no respawn to pay for. */
        personaId: meta.personaId || undefined,
        /* Whether answers should close with follow-up suggestions. Picked on
           the draft like the persona, and free for the same reason. On
           unless the draft turned it off — `??` rather than `||`, so an
           explicit off survives the trip instead of reading as unset. */
        suggestFollowups: meta.suggestFollowups ?? true,
        /* Whether an answer may carry a drawn view. The same draft-picked,
           spawn-input bargain as the suggestions trailer: on unless the draft
           turned it off. */
        uiBlocks: meta.uiBlocks ?? true,
        /* The agent options as the draft showed them. The server applies them
           the moment session/new answers, best-effort and only where they
           differ from what it came up on: a remembered option the agent no
           longer offers must not stop the message that created the thread. */
        configChoices,
        /* The thread's own tool picks, on top of the project's and the
           profile's — the server links what still exists and spawns with
           the union. */
        mcpServerIds: meta.mcpServerIds ?? [],
        skillIds: meta.skillIds ?? [],
        commandIds: meta.commandIds ?? [],
        /* A draft renamed before it was ever sent to: the name travels with
           the create call, and the server's first-prompt sniff then leaves
           it alone. Left out when nobody has named it, so the sniff still
           titles the thread from what was typed. */
        title: meta.title && meta.title !== "New thread" ? meta.title : undefined,
      }),
    })
    // Swaps the draft row for the server's own — see the `sessions` reducer.
    const listed = await refreshSessions()
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
    await threads.for(meta.id).open(created)
  }

  /* Point the window-level watchers — `online`, `visibilitychange`, the
     shared health probe and the park poll — at this connection's registry.
     They outlive React and there is one of each per page, so the module
     installs them once and this only re-aims them; the last connection bound
     is the live one, which is the rule the module-level bound callbacks
     followed before. */
  watchNetwork({ settings, registry: threads })

  const refreshSessions = async () => {
    const sessions = await api<SessionMeta[]>(settings, "/api/sessions?deleted=1")
    // The server's list is the authority on what still exists, so this is the
    // one place that can tell a stale draft from a live one — except for
    // threads the server has never been told about. A draft thread is exactly
    // that, and pruning against the server alone would delete the half-written
    // message that has not been sent yet.
    const ids = [
      ...sessions.map((session) => session.id),
      ...getState().sessions.filter((s) => s.draft).map((s) => s.id),
    ]
    pruneDrafts(ids)
    prunePastes(ids)
    pruneDraftAttachments(ids)
    /* And the draft rows themselves: an id the server reports is a thread that
       has been sent (here or on another device), so its row stops being this
       device's to bring back. Drafts still unknown to the server stay. */
    pruneDraftSessions(
      settings.id,
      sessions.map((session) => session.id)
    )
    /* A connection leaks the same way the device-local stores do — a cursor,
       a backoff timer or a live socket for a thread the server no longer
       reports is never coming back on its own. Same authority, same sweep,
       and now one call per thread rather than six that could disagree about
       what forgetting one means. (A trashed thread is still in the list, so
       its socket is not torn down here; the deleted branch of a reconnect
       owns that.) */
    threads.sweep(new Set(ids))
    dispatch({ type: "sessions", sessions })
    /* Handed back, and this is not a convenience. `getState()` reads a ref the
       store writes in a *layout effect* (see `StoreProvider`), so it does not
       reflect the dispatch above until React has committed — and the caller's
       next line is a microtask, which runs before any commit. A caller that
       re-read the store here to find the row it had just created was therefore
       guaranteed to read the row as it was *before* the refresh. The list this
       returns is the same authority the dispatch carries, available now. */
    return sessions
  }

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
  const { settings, dispatch, getState, queryClient, catalog, createSession, refreshSessions } = core

  return {
    refreshSessions,

    /**
     * The sessions list, and only that: every catalog the boot used to read
     * alongside it is the query cache's now, fetched by the components that
     * draw it. Kept as an action because the session list is the reducer's
     * and because `Connected` needs one promise to gate the shell on.
     */
    async bootstrap() {
      const sessions = await api<SessionMeta[]>(settings, "/api/sessions?deleted=1")
      dispatch({ type: "bootstrap", sessions })
      /* ── Unsent threads come back with their tabs ──
         A draft has no server row, so the list above cannot carry it — and
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
