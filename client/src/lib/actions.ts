import * as React from "react"
import type * as acp from "@daedalus/acp"
import type { AttachmentRef } from "@daedalus/protocol"
import { useQueryClient } from "@tanstack/react-query"
import { reportError } from "./errors"
import { uuid } from "./uuid"
import {
  alreadyAsked,
  loadAgentOptions,
  markAsked,
  optionKey,
  saveProbedOptions,
  type AgentOptionSet,
} from "./agent-options"
import { pruneDrafts } from "./drafts"
import { prunePastes } from "./pastes"
import { pruneDraftAttachments } from "./draft-attachments"
import { defaultToolPicks, loadThreadDefaults } from "./thread-defaults"
import { prunePins } from "./pins"
import {
  api,
  profileAgentIds,
  type AgentDef,
  type McpServerDef,
  type Persona,
  type Profile,
  type Project,
  type ScheduledMessage,
  type ServerSettings,
  type SessionMeta,
  type SkillDef,
  type CommandDef,
} from "./settings"
import { scheduledKey } from "./queries/keys"
import { useCatalogReader } from "./queries/catalog"
import type { ScheduleInput } from "./queries/routines"
import { fetchQuota, planReadable } from "./quota"
import { emptyThread, useDispatch, useStoreHandle, type Action } from "./store"
import { threadRegistry } from "./thread/registry"
import type { ThreadConnection } from "./thread/connection"
import { recordThreadError } from "./thread/record-error"
import {
  serverReachable,
  startHealthPoll,
  watchNetwork,
} from "./thread/network-watch"

const postJson = <T,>(settings: ServerSettings, path: string, body: unknown): Promise<T> =>
  api<T>(settings, path, { method: "POST", body: JSON.stringify(body) })

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

    /**
     * Change a thread's profile, model or effort — and let the server say what
     * that costs.
     *
     * All three are placed by the agent's env at spawn, and all three used to
     * mean the same thing here: kill the process, spawn another, put the
     * conversation back. They do not any more. The endpoint and the credential
     * live behind the harness's own gateway URL, which names the *thread*, and
     * the model is either the agent's own selector or another rewrite on the
     * same wire — so the common case is one request that changes nothing
     * anybody can see. See CLAUDE.md.
     *
     * Which case it is cannot be known from here: it depends on the agent, on
     * whether the thread is behind the shim at all, and on whether the running
     * process will take the model. So the route decides and answers `live`, and
     * only the falsy answer does the reconnect dance — a live change arrives
     * back as a `spawn_config` event on the socket that is already open, on
     * this device and on every other.
     */
    const changeThreadConfig = async (
      meta: SessionMeta,
      next: { profileId?: string; model?: string; effort?: string; personaId?: string },
      context: string
    ) => {
      let live = false
      try {
        const reply = await api<{ live: boolean }>(settings, `/api/sessions/${meta.id}/config`, {
          method: "POST",
          body: JSON.stringify({
            profileId: next.profileId ?? meta.profileId,
            agentId: meta.agentId,
            model: next.model ?? meta.model ?? undefined,
            effort: next.effort ?? meta.effort ?? undefined,
            /* Deliberately not `?? meta.personaId`: sending the current value
               back would be indistinguishable from asking for it, and the
               server reads a *changed* persona as "apply its effort too". Only
               a real pick travels. */
            personaId: next.personaId,
          }),
        })
        live = reply.live
      } catch (error) {
        recordError(meta.id, error, context)
        throw error
      }
      const listed = await refreshSessions()
      if (live) return
      /* The server fell back to a respawn, so the event log was cleared under
         this socket: the saved cursor is past its end and the thread has to be
         attached again from 0. `forgetJournal` drops the socket and the cursor
         with it, which is what makes the open below a clean rebuild. */
      const conn = threads.for(meta.id)
      conn.forgetJournal()
      try {
        /* Through the connection's own open chain, for the reason
           `createSession` is: the refresh above re-fires the panel's open, and
           two of them on one session are two peers folding the same events into
           the store. The row comes from what the refresh fetched because the
           respawn changed it — and for the reason `createSession` says: a
           `getState()` here would answer with the row as it was before the
           refresh landed. */
        const respawned = listed.find((session) => session.id === meta.id) ?? meta
        await conn.open(respawned)
      } catch (error) {
        // The old process is gone by now, so a failure here leaves a thread
        // that needs reviving — say that, in the thread.
        recordError(meta.id, error, context)
        throw error
      }
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
          /* How this thread should be worked on. Picked on the draft like the
             rest of this, and — unlike a started thread's — free: nothing is
             running yet, so there is no respawn to pay for. */
          personaId: meta.personaId || undefined,
          /* Settings picked on the draft, against the option set the agent last
             advertised. The server applies them the moment session/new answers,
             best-effort: a remembered option the agent no longer offers must not
             stop the message that created the thread. */
          configChoices: meta.configChoices,
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
      prunePins(ids)
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

      /**
       * Open a new thread without creating one. The id is minted here so the
       * route, the tab and the transcript all exist before anything touches the
       * network; the server is not told, and no agent process is spawned, until
       * the first message (see `send`). Synchronous on purpose — a new thread
       * should never be something you wait for.
       */
      newDraftThread(opts: {
        project: Project
        profile: Profile
        /** One of `profile.agents`; the profile's first when left out. */
        agentId?: string
        model?: string
        effort?: string
        /** Adopt this exact id instead of minting one — a reload that landed on
            a thread the server never heard of, which is what an unsent draft
            looks like from a fresh page. */
        id?: string
      }) {
        const { project, profile, model, effort } = opts
        const id = opts.id ?? uuid()
        /* The library picks come from the same remembered defaults the agent
           does — read here rather than by each caller, so a reload that
           re-adopts an unsent draft gets its MCP servers, skills and commands
           back along with its profile. */
        const defaults = loadThreadDefaults()
        const tools = defaultToolPicks(defaults)
        dispatch({
          type: "draft-session",
          session: {
            id,
            profileId: profile.id,
            projectId: project.id,
            agentId: opts.agentId ?? profileAgentIds(profile)[0] ?? "",
            model: model ?? "",
            effort: effort ?? "",
            /* Remembered like the tool picks, and read here for the same
               reason: a reload that re-adopts an unsent draft has to get back
               the way it was going to be worked on, not just its profile. */
            personaId: defaults.personaId ?? "",
            title: "New thread",
            createdAt: Date.now(),
            deletedAt: null,
            attached: false,
            exited: false,
            promptActive: false,
            cursor: 0,
            draft: true,
            ...tools,
          },
        })
        dispatch({ type: "thread-reset", id, thread: { ...emptyThread } })
        return id
      },

      /**
       * Find out what an agent can be configured with on a profile, once.
       *
       * The server answers by spawning one and killing it (see probe.ts), which
       * is the only way to ask — so this runs at most once per (profile, agent)
       * per page-load, and never when a live session has already told us. A
       * failure is silent on purpose: the menu falls back to saying the settings
       * appear once the thread starts, which is exactly what it said before.
       */
      async learnAgentOptions(profileId: string, agentId: string, projectId: string) {
        if (!agentId) return
        const key = optionKey(profileId, agentId)
        if (alreadyAsked(key) || loadAgentOptions(key).base.length > 0) return
        markAsked(key)
        try {
          const probed = await api<{
            configOptions: acp.SessionConfigOption[]
            byModel: AgentOptionSet["byModel"]
          }>(settings, `/api/profiles/${profileId}/options`, {
            method: "POST",
            body: JSON.stringify({ projectId, agentId }),
          })
          saveProbedOptions(key, {
            base: probed.configOptions ?? [],
            byModel: probed.byModel ?? {},
          })
        } catch (error) {
          console.warn(`Couldn't ask ${agentId} on ${profileId} what it supports`, error)
        }
      },

      /** Pick an agent setting on a thread that does not exist yet, against the
          option set that agent last advertised. Held until session/new can
          apply it — see `createSession`. */
      chooseDraftConfigOption(id: string, configId: string, value: string | boolean) {
        dispatch({ type: "draft-config-option", id, configId, value })
      },

      /** Retune a thread that does not exist yet. Model and effort are env at
          spawn, so until the process starts they are ours to change freely. */
      configureDraft(
        id: string,
        next: Partial<
          Pick<
            SessionMeta,
            | "projectId"
            | "profileId"
            | "agentId"
            | "model"
            | "effort"
            | "personaId"
            | "mcpServerIds"
            | "skillIds"
            | "commandIds"
          >
        >
      ) {
        dispatch({ type: "configure-draft", id, next })
      },

      /** Reattach to a thread whose socket was closed while the agent process is
          still alive — e.g. another device took it over (close code 4002).
          The same call as reviving: the open respawns only if `meta.exited`, and
          both clear the ladder first because both were asked for. */
      reconnectThread,

      reviveThread: reconnectThread,

      /**
       * Fetch the page of history above the transcript and fold it in.
       *
       * The socket owns the mechanics (it is the only thing holding the events
       * the re-fold needs); this only guards against stacking two pages and
       * marks the button busy while one is in flight.
       */
      async loadEarlier(sessionId: string) {
        const thread = known(sessionId)?.live
        if (!thread || getState().threads[sessionId]?.loadingEarlier) return
        dispatch({ type: "thread-window", id: sessionId, loadingEarlier: true })
        try {
          await thread.loadEarlier()
        } catch (error) {
          dispatch({ type: "thread-window", id: sessionId, loadingEarlier: false })
          reportError(error, "Couldn't load earlier messages")
        }
      },

      /**
       * The reader is approaching the top of the transcript: get the next page
       * of history over the wire now, so the click that asks for it pays only
       * the re-fold. Silent, idempotent and safe to call on every scroll — the
       * socket drops the ones it does not need.
       */
      prefetchEarlier(sessionId: string) {
        known(sessionId)?.live?.prefetchEarlier()
      },

      /**
       * Send a prompt. A failure here is recorded in the transcript — with the
       * text, so the row can offer Retry — and then rethrown, so the composer
       * can react too. Callers must not toast it a second time.
       */
      async send(
        sessionId: string,
        text: string,
        opts: {
          steer?: boolean
          /** What this message carries. The refs are already uploaded — the
              composer refuses to send while one is in flight — so this is a
              list of ids plus the names the optimistic bubble draws before the
              round trip. Unknown or foreign ids are dropped server-side rather
              than refused: a stale draft id must not fail a send whose text is
              fine. */
          attachments?: AttachmentRef[]
          /** Pin every attachment to the materialise-and-link branch. One
              caller: the error row's "Retry as file paths". */
          forceLink?: boolean
          /** Offered the words back when the send died before anything reached
              the server. The composer answers `true` when it has taken them —
              a persisted draft the user can edit, where the error row it would
              otherwise live on is `local` and dies with a reload. Callers with
              nowhere to put them (Retry, Continue, the palette) leave it unset
              and keep the row's Retry. */
          onUnsent?: () => boolean
        } = {}
      ) {
        const attachments = opts.attachments ?? []
        const attachmentIds = attachments.map((ref) => ref.id)
        /**
         * Record a failure whose message never left this device.
         *
         * The words end up in exactly one place, and whoever holds them is who
         * offers to send them again: the composer if it took them back, the
         * error row's Retry if it did not.
         */
        const recordUnsent = (error: unknown, context: string) => {
          const reclaimed = opts.onUnsent?.() === true
          recordError(
            sessionId,
            error,
            reclaimed ? `${context} — the text is back in the composer` : context,
            reclaimed ? undefined : { text, attachments }
          )
        }
        /* First message on a draft: show the message instantly, then create the
           thread on the server. A failure leaves the draft a draft and lands the
           text in a Retry row like any other send failure — and retrying re-runs
           this, which is correct: if the POST is what failed, the id is still
           free. */
        const draft = getState().sessions.find((s) => s.id === sessionId && s.draft)
        if (draft) {
          /* Show the message and connecting state instantly rather than waiting
             for the full server round-trip — the agent spawn, handshake and
             WebSocket replay can take seconds. On failure, clean up the
             optimistic state and record a Retry-able error. */
          dispatch({ type: "user-message", id: sessionId, text, local: true, attachments })
          /* Only when there are words to take it from: an image with no
             sentence is a real prompt, and the server's own title sniff skips
             an empty one too — a thread called "" is worse than "New thread". */
          if (text) dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
          dispatch({ type: "turn-active", id: sessionId, active: true })
          try {
            await createSession(draft)
          } catch (error) {
            threads.for(sessionId).markIdle()
            dispatch({ type: "drop-user-message", id: sessionId })
            dispatch({ type: "turn-active", id: sessionId, active: false })
            recordUnsent(error, "Couldn't start this thread")
            throw error
          }
          /* The optimistic bubble survives the attach on its own now: a
             non-resumed attach carries this device's own rows across the reset
             and puts them back with the replay (lib/thread/carry.ts). This used
             to be a re-dispatch guarded by a heuristic — "if no untagged user
             item is left, the reset must have eaten it" — which held for this
             one path and for nothing else, which is why an error row recorded
             just before an attach vanished with no restoration at all. */
        }
        const conn = threads.for(sessionId)
        /* Not "is there a socket" but "make there be one". Every reason there
           might not be — an open nobody has asked for yet, one half way
           through, a process that was retired, a ladder mid-backoff, a thread
           parked waiting for a server to come back — is something `ready` waits
           for or brings about. What still throws has a real reason (Trash, a
           deleted project, a server that refused to spawn) and says it.

           This replaces a bare read of a map that answered "This thread has no
           live connection to its agent — revive it and send again": a statement
           about this device's bookkeeping, dressed up as one about the thread,
           telling the user to press a button the client could press itself. */
        let thread
        try {
          thread = await conn.ready()
        } catch (error) {
          /* A draft lit its own indicator before the create above, and the
             prompt never went out — so take it back here, exactly as the
             prompt-failure branch below does. Left on, it spins forever on a
             thread that is not working on anything. */
          if (draft) dispatch({ type: "turn-active", id: sessionId, active: false })
          recordUnsent(error, "Couldn't send the message")
          throw error
        }
        /* Steering — a prompt sent while a turn is already running — is why this
           is read BEFORE the dispatch below. If this send fails, it may only
           take back the indicator it turned on itself: a steer that never
           reaches the agent leaves the turn it was aimed at still running, and
           clearing the indicator there loses it until a reload (the server is
           still `promptActive`, so `caught_up` puts it straight back — which is
           exactly the "refresh brings it back" shape of the bug). */
        const alreadyRunning = getState().threads[sessionId]?.turnActive ?? false
        /* A message typed into a running turn is QUEUED, not steered, unless
           asked otherwise. No bubble and no indicator here: the `queue` event
           draws the row, and when the turn ends the drained prompt comes back
           as a `turn_started` with no origin — so this device draws the bubble
           then, exactly like every other peer. If the turn ended before this
           server saw this, `queue_add` drains at once and the same holds. */
        if (!draft && alreadyRunning && !opts.steer) {
          try {
            await thread.queueAdd(text, attachmentIds)
          } catch (error) {
            recordUnsent(error, "Couldn't queue this message")
            throw error
          }
          return
        }
        /* A draft already dispatched its optimistic bubble and turn-active
           above — only emit them for threads that were already live. */
        if (!draft) {
          dispatch({ type: "user-message", id: sessionId, text, local: true, attachments })
          if (text) dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
        }
        /* This device is the one peer that does not get a `turn_started` — it
           already put the message on screen — so it lights its own indicator.
           `turn_ended` is what clears it, here and everywhere else.

           Re-asserted for a draft rather than skipped, even though it was lit
           before the create above: `ready` has just opened the thread, and a
           non-resumed attach replaces the transcript with `emptyThread`, whose
           `turnActive` is false. The bubble survives that (carry.ts) and this
           does not, so the first message of a new thread ran its whole turn with
           no working indicator at all. `caught_up` cannot cover it either — it
           only relights the indicator when the SERVER says `promptActive`, and
           the prompt below has not been sent yet. Idempotent, so the ordinary
           path pays nothing for it. */
        dispatch({ type: "turn-active", id: sessionId, active: true })
        try {
          /* Resolves when the server has dispatched the prompt, not when the
             turn ends: how the turn went reaches every device on the thread as
             `turn_ended`, and awaiting it here would report a failure twice. */
          const reply = await thread.prompt(text, {
            steer: opts.steer,
            attachmentIds,
            forceLink: opts.forceLink,
          })
          if ("queued" in reply) {
            /* The server was busy before this device knew — another peer or
               the scheduler started a turn. The words are on the queue row
               now, so the optimistic bubble comes back off. */
            dispatch({ type: "drop-user-message", id: sessionId })
            if (!alreadyRunning) dispatch({ type: "turn-active", id: sessionId, active: true })
            return
          }
          dispatch({ type: "tag-user-turn", id: sessionId, turnId: reply.turnId })
        } catch (error) {
          /* For a draft we set turn-active ourselves above, so clear it on
             failure — the prompt never reached the agent. For a non-draft
             where alreadyRunning was true, another turn is genuinely active
             and must not be disturbed. */
          if (!alreadyRunning || draft) dispatch({ type: "turn-active", id: sessionId, active: false })
          recordError(sessionId, error, "The agent couldn't answer this message", {
            text,
            attachments,
          })
          throw error
        }
      },

      /**
       * Change a thread's profile, model or effort — and let the server say
       * what that costs.
       *
       * All three are placed by the agent's env at spawn, and all three used to
       * mean the same thing here: kill the process, spawn another, put the
       * conversation back. They do not any more. The endpoint and the
       * credential live behind the harness's own gateway URL, which names the
       * *thread*, and the model is either the agent's own selector or another
       * rewrite on the same wire — so the common case is now one request that
       * changes nothing anybody can see. See CLAUDE.md.
       *
       * Which case it is, is not knowable from here: it depends on the agent,
       * on whether the thread is behind the shim, and on whether the running
       * process will take the model. So the route decides and answers `live`,
       * and only the falsy answer does the reconnect dance — a live change
       * arrives back as a `spawn_config` event on the socket that is already
       * open, on this device and every other.
       */
      changeThreadConfig,

      /**
       * Move a thread onto a different profile: different credentials, base URL
       * and model catalog.
       *
       * Model and effort are deliberately NOT carried over. They name a model in
       * the profile being left, which the profile being joined may not serve at
       * all, so the new profile's own default is the honest starting point —
       * and the server is what resolves "none" into it.
       */
      async changeProfile(meta: SessionMeta, profileId: string) {
        // Same agent, new provider: the menu only offers profiles that serve
        // this thread's agent, and the server refuses one that does not.
        await changeThreadConfig(
          meta,
          { profileId, model: "", effort: "" },
          "Couldn't move this thread to that profile"
        )
      },

      /** Change the model or reasoning effort of a thread whose profile carries
          its own model catalog. */
      async changeSpawnConfig(meta: SessionMeta, next: { model?: string; effort?: string }) {
        await changeThreadConfig(meta, next, "Couldn't change this thread's model")
      },

      /**
       * Change how this thread is worked on.
       *
       * Always a respawn — no runtime we ship will take a persona on a running
       * process — so `changeThreadConfig`'s `live: false` tail is the ordinary
       * path here rather than the fallback: the socket closes, the cursor is
       * dropped and the thread reattaches from 0 against the conversation
       * `session/load` has just restored. `""` is a real value and means no
       * persona; model and profile are left alone, because a persona says
       * nothing about either.
       */
      async changeThreadPersona(meta: SessionMeta, personaId: string) {
        await changeThreadConfig(
          meta,
          { personaId },
          "Couldn't change how this thread works"
        )
      },

      /* Mode and config changes are optimistic in the UI, so a rejection has to
         be loud — otherwise the control snaps back with no explanation. */
      async setMode(sessionId: string, modeId: string) {
        try {
          await known(sessionId)?.live?.setMode(modeId)
        } catch (error) {
          recordError(sessionId, error, "The agent rejected that mode")
          throw error
        }
        dispatch({ type: "mode", id: sessionId, modeId })
      },

      async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
        // Read the category first: the response replaces the whole option set,
        // and the category is what says whether this pick is also spawn state.
        const category = getState().threads[sessionId]?.configOptions.find(
          (option) => option.id === configId
        )?.category
        try {
          const configOptions = await known(sessionId)?.live?.setConfigOption(configId, value)
          if (configOptions) dispatch({ type: "config-options", id: sessionId, configOptions })
        } catch (error) {
          recordError(sessionId, error, `The agent rejected that ${configId} setting`)
          throw error
        }
        /* Model and effort are also process env: the server rebuilds them from
           the session record every time it revives a retired thread. It records
           the change itself now (it knows the option's category), so all that is
           left here is to re-read the list this thread's row appears in. */
        if (category === "model" || category === "thought_level") await refreshSessions()
      },

      // ---- the queue ----
      // Each answers with a `queue` event to every peer; a failure lands in
      // the thread like any other, with the text where there is one to retry.

      async queueUpdate(
        sessionId: string,
        itemId: string,
        text: string,
        /** Omitted leaves the item's attachments alone; an empty array clears
            them. */
        attachmentIds?: string[]
      ) {
        try {
          await requireLive(sessionId).queueUpdate(itemId, text, attachmentIds)
        } catch (error) {
          recordError(sessionId, error, "Couldn't edit the queued message", text)
          throw error
        }
      },

      async queueRemove(sessionId: string, itemId: string) {
        try {
          await requireLive(sessionId).queueRemove(itemId)
        } catch (error) {
          recordError(sessionId, error, "Couldn't remove the queued message")
          throw error
        }
      },

      async queueClear(sessionId: string) {
        try {
          await requireLive(sessionId).queueClear()
        } catch (error) {
          recordError(sessionId, error, "Couldn't clear the queue")
          throw error
        }
      },

      /** Interrupt the running turn and send the queue (or one item) in its
          place. No "interrupted" notice: `turn_ended` → `turn_started` says
          it, and the server does all three steps whether or not this tab
          stays open. */
      async queueSendNow(sessionId: string, itemId?: string) {
        try {
          await requireLive(sessionId).queueSendNow(itemId)
        } catch (error) {
          recordError(sessionId, error, "Couldn't send the queued message")
          throw error
        }
      },

      async queueSteer(sessionId: string, itemId: string) {
        try {
          await requireLive(sessionId).queueSteer(itemId)
        } catch (error) {
          recordError(sessionId, error, "Couldn't steer with the queued message")
          throw error
        }
      },

      async stop(sessionId: string) {
        await known(sessionId)?.live?.cancel()
        /* The agent writes its own "[Request interrupted by user]" turn, but
           only the session/load replay surfaces it — without this the rule (and
           the Continue button on it) would not appear until a reload. */
        dispatch({ type: "notice", id: sessionId, text: "Request interrupted by user" })
      },

      /** Name a thread by hand.
       *
       * A draft has no server row, so its name lives in the store until the
       * first message carries it into `POST /api/sessions` — which is why the
       * create call sends the title at all. For a started thread the server is
       * asked first and the store follows its answer, because the server is
       * what trims and caps it and a row saying something else is a list that
       * disagrees with the thread it names. */
      async renameThread(sessionId: string, title: string) {
        const next = title.trim()
        if (!next) return
        if (getState().sessions.find((s) => s.id === sessionId)?.draft) {
          dispatch({ type: "rename-session", id: sessionId, title: next })
          return
        }
        const { title: named } = await api<{ title: string }>(
          settings,
          `/api/sessions/${sessionId}`,
          { method: "PATCH", body: JSON.stringify({ title: next }) }
        )
        dispatch({ type: "rename-session", id: sessionId, title: named })
      },

      /** Reversible: the agent process dies, the thread moves to Trash.
          A draft has neither, and nothing to be restored from — closing it just
          forgets it. */
      async deleteThread(sessionId: string) {
        if (getState().sessions.find((s) => s.id === sessionId)?.draft) {
          dispatch({ type: "drop-draft-session", id: sessionId })
          return
        }
        threads.destroy(sessionId)
        await api(settings, `/api/sessions/${sessionId}`, { method: "DELETE" })
        await refreshSessions()
      },

      /** The same, for several at once — a project's list, where deleting the
          threads one row at a time is the operation nobody wants to perform
          twenty times. Sequential, because each DELETE stops a process, and one
          refresh at the end: the session list is the same read however many
          rows moved, and a refresh per thread would have them racing. A failure
          part way leaves the threads it already deleted deleted, which is what
          the caller's error report has to say. */
      async deleteThreads(sessionIds: string[]) {
        const drafts = new Set(
          getState()
            .sessions.filter((s) => s.draft)
            .map((s) => s.id)
        )
        try {
          for (const id of sessionIds) {
            if (drafts.has(id)) {
              dispatch({ type: "drop-draft-session", id })
              continue
            }
            threads.destroy(id)
            await api(settings, `/api/sessions/${id}`, { method: "DELETE" })
          }
        } finally {
          await refreshSessions()
        }
      },

      /** Back out of Trash. The thread returns process-less; opening it revives. */
      async restoreThread(sessionId: string) {
        await api(settings, `/api/sessions/${sessionId}/restore`, { method: "POST" })
        await refreshSessions()
      },

      /** The irreversible one — after this only the agent's own store has it. */
      async purgeThread(sessionId: string) {
        if (getState().sessions.find((s) => s.id === sessionId)?.draft) {
          dispatch({ type: "drop-draft-session", id: sessionId })
          return
        }
        threads.destroy(sessionId)
        await api(settings, `/api/sessions/${sessionId}?purge=1`, { method: "DELETE" })
        await refreshSessions()
      },
    }
  }, [settings, dispatch, getState])
}

export type Actions = ReturnType<typeof useActions>
