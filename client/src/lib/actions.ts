import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import { CreateElicitationRequest } from "@agentclientprotocol/sdk"
import { AcpThread, liveThreads, type ConnectOptions, type ThreadCallbacks } from "./acp"
import { describeError, markReported } from "./errors"
import {
  alreadyAsked,
  loadAgentOptions,
  markAsked,
  pruneAgentOptions,
  saveAgentOptions,
  saveProbedOptions,
  type AgentOptionSet,
} from "./agent-options"
import { pruneDrafts } from "./drafts"
import { appendTaskEvent } from "./task-events"
import { notifyThreadEvent } from "./notifications"
import { prunePins } from "./pins"
import { pruneViewOptions } from "./view-options"
import {
  api,
  type AgentDef,
  type JournalEntry,
  type McpServerDef,
  type Profile,
  type Project,
  type ServerSettings,
  type SessionMeta,
  type SkillDef,
  type CommandDef,
} from "./settings"
import { partitionSessionOptions } from "./session-options"
import { emptyThread, rebuildThread, useStore } from "./store"

const RECONNECT_MAX_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 8000
const NON_RECONNECTABLE_CLOSE_CODES = new Set([4000, 4002, 4004])
const reconnectAttempts = new Map<string, number>()
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Side-effectful operations: REST calls + ACP thread lifecycle. */
export function useActions(settings: ServerSettings) {
  const { state, dispatch } = useStore()
  const stateRef = React.useRef(state)
  stateRef.current = state

  return React.useMemo(() => {
    /* Failures that belong to a thread are recorded IN that thread, not in a
       toast: the transcript is where the user is looking, it survives the four
       seconds a toast lives, and it is the only place that can offer the one
       useful next step (send that prompt again). */
    const recordError = (sessionId: string, err: unknown, context: string, retryText?: string) => {
      const info = describeError(err)
      console.error(`[${context}]`, err)
      // It has a home in the transcript now; the global net must not re-toast it
      // if a caller lets the rethrow escape.
      markReported(err)
      if (info.kind === "cancelled") return info
      dispatch({
        type: "error",
        id: sessionId,
        title: context,
        reason: info.title,
        detail: info.detail,
        retryText,
      })
      return info
    }

    /** `silent` is the automatic-backoff path: a failed attempt is not worth a
        transcript row of its own — scheduleReconnect reports once, at give-up. */
    const reconnectThread = async (sessionId: string, silent = false) => {
      // User-initiated (or backoff-driven) reattach: drop any half-open socket so
      // openThread's `connected` short-circuit can't skip the reconnect.
      liveThreads.get(sessionId)?.close()
      const sessions = await api<SessionMeta[]>(settings, "/api/sessions")
      dispatch({ type: "sessions", sessions })
      const meta = sessions.find((s) => s.id === sessionId)
      if (!meta) throw new Error("This thread no longer exists on the server.")
      await (silent ? connectThread(meta) : openThread(meta))
    }

    const scheduleReconnect = (sessionId: string, lastError?: unknown) => {
      if (reconnectTimers.has(sessionId)) return
      const attempt = (reconnectAttempts.get(sessionId) ?? 0) + 1
      if (attempt > RECONNECT_MAX_ATTEMPTS) {
        // Giving up silently is how a thread ends up looking merely quiet.
        // Say so, in the thread, where the Revive button already lives.
        const info = lastError ? describeError(lastError) : undefined
        dispatch({
          type: "error",
          id: sessionId,
          title: `Lost the connection to this thread — ${RECONNECT_MAX_ATTEMPTS} reconnect attempts failed`,
          reason: info?.title ?? "The server or the agent process is no longer reachable.",
          detail: info?.detail,
        })
        return
      }

      reconnectAttempts.set(sessionId, attempt)
      dispatch({ type: "thread-status", id: sessionId, status: "connecting" })
      const delayMs = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
        RECONNECT_MAX_DELAY_MS,
      )
      reconnectTimers.set(
        sessionId,
        setTimeout(() => {
          reconnectTimers.delete(sessionId)
          void reconnectThread(sessionId, true).catch((error) => {
            console.warn(`Reconnecting thread ${sessionId} failed`, error)
            dispatch({ type: "thread-status", id: sessionId, status: "closed" })
            scheduleReconnect(sessionId, error)
          })
        }, delayMs),
      )
    }

    /** The thread's title, for a notification about it. */
    const titleOf = (id: string) =>
      stateRef.current.sessions.find((s) => s.id === id)?.title || "Untitled thread"

    /* `owner` is filled in by startThread the moment the thread exists — see the
       guard in onStatus. */
    const makeCallbacks = (id: string, owner: { thread?: AcpThread }): ThreadCallbacks => ({
      onUpdate: (notification, replaying) =>
        dispatch({ type: "update", id, update: notification.update, allowUserChunks: replaying }),
      onPermission: (request) =>
        new Promise((resolve) => {
          notifyThreadEvent("permissionNeeded", id, titleOf(id), request.toolCall?.title ?? undefined)
          dispatch({
            type: "permission",
            id,
            permission: {
              request,
              resolve: (response) => {
                dispatch({ type: "permission", id, permission: null })
                resolve(response)
              },
            },
          })
        }),
      onElicitation: (request) =>
        new Promise((resolve) => {
          notifyThreadEvent("questionAsked", id, titleOf(id), request.message)
          dispatch({
            type: "elicitation",
            id,
            elicitation: {
              request,
              resolve: (response) => {
                dispatch({ type: "elicitation", id, elicitation: null })
                resolve(response)
              },
            },
          })
        }),
      // A URL-mode elicitation finished on the far side of the browser tab it
      // opened in: the agent says so, and the accept is the whole answer.
      onElicitationComplete: (elicitationId) => {
        const pending = stateRef.current.threads[id]?.elicitation
        if (!pending) return
        const request = pending.request
        if (
          CreateElicitationRequest.isUrl(request) &&
          request.elicitationId !== elicitationId
        ) {
          return
        }
        pending.resolve({ action: "accept" })
      },
      onStatus: (status, closeInfo) => {
        /* A respawn or a reconnect installs a new AcpThread for this same
           session id while the old one's socket is still closing. The old
           instance's closing status is about a connection nobody is using —
           letting it through marks the live thread dead and, worse, books a
           reconnect against it. */
        if (owner.thread && liveThreads.get(id) !== owner.thread) return
        if (status === "connected") {
          reconnectAttempts.delete(id)
        } else if (
          status === "closed" &&
          !closeInfo?.clientInitiated &&
          !NON_RECONNECTABLE_CLOSE_CODES.has(closeInfo?.code ?? 0)
        ) {
          // The close frame's reason is the server's own account of what
          // happened ("agent exited (1)") — carry it into the give-up message.
          scheduleReconnect(
            id,
            closeInfo?.reason
              ? new Error(`${closeInfo.reason}${closeInfo.code ? ` (${closeInfo.code})` : ""}`)
              : undefined
          )
        }
        dispatch({
          type: "thread-status",
          id,
          status,
          closeCode: closeInfo?.code,
          closeReason: closeInfo?.reason,
        })
        /* A dead socket ends any turn it was carrying. The server answers the
           prompts an exiting agent will never answer (`failPendingRequests`)
           and closes the peers, but it does NOT synthesize `turn_ended` for
           them — so without this the working indicator outlives the process
           and only a reload clears it. */
        if (status === "closed") dispatch({ type: "turn-active", id, active: false })
      },
      onTurnActive: (active) => dispatch({ type: "turn-active", id, active }),
      onSessionConfig: (modes, configOptions) => {
        dispatch({ type: "session-config", id, modes, configOptions })
        /* Remember what this profile's agent offers. A draft has no process to
           ask, so without this a new thread cannot show a single setting until
           it has already started — see lib/agent-options. */
        const profileId = stateRef.current.sessions.find((s) => s.id === id)?.profileId
        if (profileId && configOptions.length > 0) saveAgentOptions(profileId, configOptions)
      },
      onTtft: (ms) => dispatch({ type: "ttft", id, ms: Math.round(ms) }),
      onTurnEnded: (usage, error) => {
        dispatch({ type: "turn-active", id, active: false })
        if (usage) dispatch({ type: "usage", id, usage })
        // The server fans this out to every peer, including the one whose
        // prompt just rejected — the reducer collapses the two into one row.
        if (error) {
          const info = recordError(id, error, "The agent couldn't answer this message")
          if (info.kind !== "cancelled") notifyThreadEvent("turnFailed", id, titleOf(id), info.title)
        } else {
          notifyThreadEvent("turnFinished", id, titleOf(id))
        }
      },
      // Another device on this thread prompted: show its message and light up
      // the turn indicator. _daedalus/turn_ended clears it for every peer.
      onPeerPrompt: (text) => {
        dispatch({ type: "user-message", id, text })
        dispatch({ type: "session-title", id, title: text.slice(0, 60) })
        dispatch({ type: "turn-active", id, active: true })
      },
      // Another device answered the permission request we are also showing.
      // Resolving with `cancelled` settles our own ACP handler; the server
      // drops the duplicate response, so the agent only ever sees the first.
      onPeerAnswered: (toolCallId) => {
        const thread = stateRef.current.threads[id]
        const permission = thread?.permission
        if (permission && (!toolCallId || permission.request.toolCall?.toolCallId === toolCallId)) {
          permission.resolve({ outcome: { outcome: "cancelled" } })
        }
        // An elicitation is the same race: another device submitted the form,
        // so this one's copy settles as cancelled and the server drops it.
        const elicitation = thread?.elicitation
        // Only a session-scoped elicitation names a tool call; a request-scoped
        // one has none, so it matches the bare "someone answered" frame only.
        const elicitationToolCallId =
          elicitation && "toolCallId" in elicitation.request
            ? elicitation.request.toolCallId
            : undefined
        if (elicitation && (!toolCallId || elicitationToolCallId === toolCallId)) {
          elicitation.resolve({ action: "cancel" })
        }
      },
      // Mode / config options are session-wide: mirror another device's change.
      onPeerSettings: (modeId, configOptions) => {
        if (modeId) dispatch({ type: "mode", id, modeId })
        if (configOptions) dispatch({ type: "config-options", id, configOptions })
      },
      // A background task's journal grew server-side. Into the module store,
      // not the reducer: the events are keyed by transcript dir, not by
      // thread, and the panel reading them subscribes there (lib/task-events).
      onTaskEvent: (transcriptDir, event) => appendTaskEvent(transcriptDir, event),
    })

    /** Project -> the MCP server definitions it links to (dangling ids drop out). */
    const mcpFor = (project: Project) =>
      stateRef.current.mcpServers.filter((s) => project.mcpServerIds.includes(s.id))

    /* Swap the agent process and put the conversation back through session/load.
       The one move that needs this: profile, model and effort are all filled
       into the agent's env template at spawn (server/src/registry.ts), so they
       cannot be changed on a process that is already running. Callers decide
       what to send — what they leave out, the server rebuilds from the profile's
       own defaults. */
    const respawnThread = async (
      meta: SessionMeta,
      body: { profileId: string; model?: string; effort?: string },
      context: string
    ) => {
      const project = stateRef.current.projects.find((p) => p.id === meta.projectId)
      if (!project) throw new Error("This thread's project no longer exists.")
      /* What must survive the restart. A profile is credentials and a model
         catalog — it says nothing about how you like to work, so the permission
         mode and every other agent switch have to come back exactly as they
         were. Only model and effort are the profile's to change, and they are
         excluded here precisely because they are what is being changed.
         Captured before the close, since the process that knows them is about
         to die. */
      const previous = stateRef.current.threads[meta.id]
      const modeIds = new Set(previous?.modes?.availableModes.map((m) => m.id) ?? [])
      const carried = partitionSessionOptions(previous?.configOptions ?? [], modeIds).rest
      const carriedMode = previous?.modes?.currentModeId
      try {
        liveThreads.get(meta.id)?.close()
        await api(settings, `/api/sessions/${meta.id}/respawn`, {
          method: "POST",
          body: JSON.stringify(body),
        })
        await refreshSessions()
        // The journal was reset server-side; the load replay rebuilds the transcript.
        dispatch({ type: "thread-reset", id: meta.id, thread: { ...emptyThread } })
        const thread = await startThread(meta.id, {
          fresh: false,
          load: true,
          project,
          mcpServers: mcpFor(project),
          cursor: 0,
          acpSessionId: meta.acpSessionId,
        })
        await restoreSettings(meta.id, thread, carriedMode, carried)
      } catch (error) {
        // The old process is already gone at this point, so a failure here
        // leaves a thread that needs reviving — say that, in the thread.
        recordError(meta.id, error, context)
        throw error
      }
    }

    /**
     * Put back the settings a restart reset.
     *
     * The fresh process starts on its own defaults, and `session/load` restores
     * the conversation but not how the user had the agent configured. Anything
     * the new session already agrees with is skipped, so this is usually no
     * calls at all.
     *
     * Best-effort throughout: an option the new profile's agent no longer
     * offers is a preference that no longer applies, not a failure worth
     * throwing a restored thread away over.
     */
    const restoreSettings = async (
      sessionId: string,
      thread: AcpThread,
      modeId: string | undefined,
      options: acp.SessionConfigOption[]
    ) => {
      const now = stateRef.current.threads[sessionId]
      if (modeId && now?.modes && now.modes.currentModeId !== modeId) {
        try {
          await thread.setMode(modeId)
          dispatch({ type: "mode", id: sessionId, modeId })
        } catch (error) {
          console.warn(`Couldn't restore mode ${modeId} after the restart`, error)
        }
      }
      for (const option of options) {
        const current = now?.configOptions.find((o) => o.id === option.id)
        if (!current || current.currentValue === option.currentValue) continue
        try {
          const configOptions = await thread.setConfigOption(option.id, option.currentValue)
          if (configOptions) dispatch({ type: "config-options", id: sessionId, configOptions })
        } catch (error) {
          console.warn(`Couldn't restore ${option.id} after the restart`, error)
        }
      }
    }

    /** Bring a draft into existence: tell the server (which spawns the agent),
        adopt its row, then handshake. The id travelled from the client, so the
        route the user is already looking at needs no correction. */
    const createSession = async (meta: SessionMeta) => {
      const project = stateRef.current.projects.find((p) => p.id === meta.projectId)
      const profile = stateRef.current.profiles.find((p) => p.id === meta.profileId)
      if (!project) throw new Error("Choose a project for this thread before sending.")
      if (!profile) throw new Error("Choose a profile for this thread before sending.")
      /* Spawning the agent and handshaking takes a second or two, and until
         `connect` runs there is no status at all — so the thread would sit
         there looking like nothing had happened to the message just sent. */
      dispatch({ type: "thread-status", id: meta.id, status: "connecting" })
      await api<{ id: string }>(settings, "/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          id: meta.id,
          profileId: profile.id,
          projectId: project.id,
          model: meta.model || undefined,
          effort: meta.effort || undefined,
        }),
      })
      // Swaps the draft row for the server's own — see the `sessions` reducer.
      await refreshSessions()
      const thread = await startThread(meta.id, {
        fresh: true,
        project,
        mcpServers: mcpFor(project),
      })
      /* Settings chosen on the draft, against the option set the agent last
         advertised. Now that session/new has answered there is something to
         apply them to. Best-effort on purpose: a remembered option the agent no
         longer offers must not stop the message that created the thread. */
      for (const [configId, value] of Object.entries(meta.configChoices ?? {})) {
        try {
          const configOptions = await thread.setConfigOption(configId, value)
          if (configOptions) dispatch({ type: "config-options", id: meta.id, configOptions })
        } catch (error) {
          console.warn(`The agent rejected the remembered ${configId} setting`, error)
        }
      }
    }

    /** Build a thread, register it as the session's live one, and connect it.
        Every path that opens a connection goes through here, so the ownership
        wiring the callbacks depend on exists in exactly one place. */
    const startThread = async (id: string, opts: ConnectOptions) => {
      const owner: { thread?: AcpThread } = {}
      const thread = new AcpThread(id, settings, makeCallbacks(id, owner))
      owner.thread = thread
      liveThreads.set(id, thread)
      await thread.connect(opts)
      return thread
    }

    const refreshSessions = async () => {
      const sessions = await api<SessionMeta[]>(settings, "/api/sessions")
      // The server's list is the authority on what still exists, so this is the
      // one place that can tell a stale draft from a live one — except for
      // threads the server has never been told about. A draft thread is exactly
      // that, and pruning against the server alone would delete the half-written
      // message that has not been sent yet.
      const ids = [
        ...sessions.map((session) => session.id),
        ...stateRef.current.sessions.filter((s) => s.draft).map((s) => s.id),
      ]
      pruneDrafts(ids)
      prunePins(ids)
      pruneViewOptions(ids)
      dispatch({ type: "sessions", sessions })
    }

    /* Model and reasoning effort are process env: the server rebuilds them from
       session.model/effort every time it revives a retired thread, and so does
       connectThread from `meta`. A change made over ACP never touches that
       record, so without this the thread comes back on the model the user
       switched away from. Pure bookkeeping — a failure here must not undo a
       change the agent has already accepted. */
    const syncSpawnState = async (
      sessionId: string,
      category: string | null | undefined,
      value: string | boolean
    ) => {
      const field = category === "model" ? "model" : category === "thought_level" ? "effort" : null
      if (!field || typeof value !== "string") return
      try {
        await api(settings, `/api/sessions/${sessionId}`, {
          method: "PATCH",
          body: JSON.stringify({ [field]: value }),
        })
        await refreshSessions()
      } catch (error) {
        console.warn(`Couldn't record the new ${field} on session ${sessionId}`, error)
      }
    }

    /** Connect (or reattach to) a thread; the caller navigates to its route.
        Every failure below lands in the thread itself before it propagates, so
        a caller that only logs still leaves the user something to read. */
    const openThread = async (meta: SessionMeta) => {
      try {
        await connectThread(meta)
      } catch (error) {
        recordError(meta.id, error, "Couldn't connect to this thread")
        throw error
      }
    }

    const connectThread = async (meta: SessionMeta) => {
      // A draft has no server session and no agent process — there is nothing to
      // connect to until the first message brings it into existence.
      if (meta.draft) return
      if (liveThreads.get(meta.id)?.connected) return
      const project = stateRef.current.projects.find((p) => p.id === meta.projectId)
      // A thread whose project was deleted can never open. Saying nothing left
      // it stuck on the connecting skeleton forever.
      if (!project) {
        throw new Error(
          "This thread's project no longer exists, so there is no working directory to run the agent in."
        )
      }

      // No live process (idle-retired or the server restarted): revive it —
      // respawn with the same profile/model, restore context via session/load.
      if (meta.exited) {
        await api(settings, `/api/sessions/${meta.id}/respawn`, {
          method: "POST",
          body: JSON.stringify({
            profileId: meta.profileId,
            model: meta.model || undefined,
            effort: meta.effort || undefined,
          }),
        })
        await refreshSessions()
        dispatch({ type: "thread-reset", id: meta.id, thread: { ...emptyThread } })
        await startThread(meta.id, {
          fresh: false,
          load: true,
          project,
          mcpServers: mcpFor(project),
          cursor: 0,
          acpSessionId: meta.acpSessionId,
        })
        return
      }

      const journal = await api<{ cursor: number; promptActive: boolean; entries: JournalEntry[] }>(
        settings,
        `/api/sessions/${meta.id}/journal`
      )
      dispatch({ type: "thread-reset", id: meta.id, thread: rebuildThread(journal.entries) })
      // A turn may still be running server-side; _daedalus/turn_ended clears this.
      // Read from the journal response, NOT from `meta`: state.sessions is only
      // refetched on bootstrap/mutations, so its promptActive is a stale snapshot —
      // stale-false loses the indicator, stale-true strands it forever.
      if (journal.promptActive) dispatch({ type: "turn-active", id: meta.id, active: true })
      await startThread(meta.id, {
        fresh: false,
        project,
        mcpServers: mcpFor(project),
        cursor: journal.cursor,
        acpSessionId: meta.acpSessionId,
        /* Hand the same answer to the connection: a turn that was already
           running is one this client cannot see the end of by watching its own
           requests, so only `_daedalus/turn_ended` may clear it. Steering such
           a turn is what used to lose the indicator. */
        turnActive: journal.promptActive,
      })
    }

    return {
      refreshSessions,

      async bootstrap() {
        const [profiles, projects, mcpServers, skills, commands, agents, sessions] =
          await Promise.all([
            api<Profile[]>(settings, "/api/profiles"),
            api<Project[]>(settings, "/api/projects"),
            api<McpServerDef[]>(settings, "/api/mcp-servers"),
            api<SkillDef[]>(settings, "/api/skills"),
            api<CommandDef[]>(settings, "/api/commands"),
            api<AgentDef[]>(settings, "/api/agents"),
            api<SessionMeta[]>(settings, "/api/sessions"),
          ])
        dispatch({
          type: "bootstrap",
          profiles,
          projects,
          mcpServers,
          skills,
          commands,
          agents,
          sessions,
        })
        return { profiles, projects, agents, sessions }
      },

      async refreshProfiles() {
        const profiles = await api<Profile[]>(settings, "/api/profiles")
        // A deleted profile's remembered option set is dead weight, and its id
        // will never be asked for again.
        pruneAgentOptions(profiles.map((profile) => profile.id))
        dispatch({ type: "profiles", profiles })
      },

      async refreshProjects() {
        const projects = await api<Project[]>(settings, "/api/projects")
        dispatch({ type: "projects", projects })
      },

      async refreshMcpServers() {
        const mcpServers = await api<McpServerDef[]>(settings, "/api/mcp-servers")
        dispatch({ type: "mcp-servers", mcpServers })
      },

      async refreshSkills() {
        const skills = await api<SkillDef[]>(settings, "/api/skills")
        dispatch({ type: "skills", skills })
      },

      async refreshCommands() {
        const commands = await api<CommandDef[]>(settings, "/api/commands")
        dispatch({ type: "commands", commands })
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
        model?: string
        effort?: string
        /** Adopt this exact id instead of minting one — a reload that landed on
            a thread the server never heard of, which is what an unsent draft
            looks like from a fresh page. */
        id?: string
      }) {
        const { project, profile, model, effort } = opts
        const id = opts.id ?? crypto.randomUUID()
        dispatch({
          type: "draft-session",
          session: {
            id,
            profileId: profile.id,
            projectId: project.id,
            agentId: profile.agentId,
            model: model ?? "",
            effort: effort ?? "",
            title: "New thread",
            createdAt: Date.now(),
            deletedAt: null,
            attached: false,
            exited: false,
            promptActive: false,
            cursor: 0,
            draft: true,
          },
        })
        dispatch({ type: "thread-reset", id, thread: { ...emptyThread } })
        return id
      },

      /**
       * Find out what a profile's agent can be configured with, once.
       *
       * The server answers by spawning one and killing it (see probe.ts), which
       * is the only way to ask — so this runs at most once per profile per
       * page-load, and never when a live session has already told us. A failure
       * is silent on purpose: the menu falls back to saying the settings appear
       * once the thread starts, which is exactly what it said before.
       */
      async learnAgentOptions(profileId: string, projectId: string) {
        if (alreadyAsked(profileId) || loadAgentOptions(profileId).base.length > 0) return
        markAsked(profileId)
        try {
          const probed = await api<{
            configOptions: acp.SessionConfigOption[]
            byModel: AgentOptionSet["byModel"]
          }>(settings, `/api/profiles/${profileId}/options`, {
            method: "POST",
            body: JSON.stringify({ projectId }),
          })
          saveProbedOptions(profileId, {
            base: probed.configOptions ?? [],
            byModel: probed.byModel ?? {},
          })
        } catch (error) {
          console.warn(`Couldn't ask ${profileId}'s agent what it supports`, error)
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
        next: Partial<Pick<SessionMeta, "projectId" | "profileId" | "agentId" | "model" | "effort">>
      ) {
        dispatch({ type: "configure-draft", id, next })
      },

      openThread,

      /** Reattach to a thread whose socket was closed while the agent process is
          still alive — e.g. another device took it over (close code 4002).
          Same code path as revive; openThread respawns only if `meta.exited`. */
      async reconnectThread(sessionId: string) {
        const timer = reconnectTimers.get(sessionId)
        if (timer) {
          clearTimeout(timer)
          reconnectTimers.delete(sessionId)
        }
        reconnectAttempts.delete(sessionId)
        await reconnectThread(sessionId)
      },

      async reviveThread(sessionId: string) {
        reconnectAttempts.delete(sessionId)
        await reconnectThread(sessionId)
      },

      /**
       * Send a prompt. A failure here is recorded in the transcript — with the
       * text, so the row can offer Retry — and then rethrown, so the composer
       * can react too. Callers must not toast it a second time.
       */
      async send(sessionId: string, text: string) {
        /* First message on a draft: this is the moment the thread becomes real.
           Create it, then connect, then prompt. A failure leaves the draft a
           draft and lands the text in a Retry row like any other send failure —
           and retrying re-runs this, which is correct: if the POST is what
           failed, the id is still free. */
        const draft = stateRef.current.sessions.find((s) => s.id === sessionId && s.draft)
        if (draft) {
          try {
            await createSession(draft)
          } catch (error) {
            recordError(sessionId, error, "Couldn't start this thread", text)
            throw error
          }
        }
        // Read AFTER creating: that is what registered the thread.
        const thread = liveThreads.get(sessionId)
        if (!thread) {
          const error = new Error(
            "This thread has no live connection to its agent — revive it and send again."
          )
          recordError(sessionId, error, "Couldn't send the message", text)
          throw error
        }
        dispatch({ type: "user-message", id: sessionId, text })
        dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
        try {
          // The response's usage is dropped on purpose: `_daedalus/turn_ended`
          // reports the same turn, and usage now accumulates — counting both
          // would double it.
          await thread.prompt(text)
        } catch (error) {
          recordError(sessionId, error, "The agent couldn't answer this message", text)
          throw error
        }
      },

      /**
       * Move a thread onto a different profile: different credentials, base URL
       * and model catalog, all of which are process env.
       *
       * Model and effort are deliberately NOT carried over. They name a model in
       * the profile being left, which the profile being joined may not serve at
       * all, so the new profile's own default is the honest starting point.
       */
      async changeProfile(meta: SessionMeta, profileId: string) {
        await respawnThread(meta, { profileId }, "Couldn't move this thread to that profile")
      },

      /**
       * Change the model or reasoning effort of a thread whose profile carries
       * its own model catalog.
       *
       * Those ids only reach the agent through its env, so this restarts the
       * process — unlike the ACP path in `setConfigOption`, which is one call to
       * a running agent. Which of the two a thread uses is the profile's answer:
       * a profile that lists models has overridden whatever the agent would have
       * advertised, and this is how those picks get applied. See CLAUDE.md.
       */
      async changeSpawnConfig(meta: SessionMeta, next: { model?: string; effort?: string }) {
        await respawnThread(
          meta,
          {
            profileId: meta.profileId,
            model: next.model ?? meta.model ?? undefined,
            effort: next.effort ?? meta.effort ?? undefined,
          },
          "Couldn't restart this thread's agent"
        )
      },

      /* Mode and config changes are optimistic in the UI, so a rejection has to
         be loud — otherwise the control snaps back with no explanation. */
      async setMode(sessionId: string, modeId: string) {
        try {
          await liveThreads.get(sessionId)?.setMode(modeId)
        } catch (error) {
          recordError(sessionId, error, "The agent rejected that mode")
          throw error
        }
        dispatch({ type: "mode", id: sessionId, modeId })
      },

      async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
        // Read the category first: the response replaces the whole option set,
        // and the category is what says whether this pick is also spawn state.
        const category = stateRef.current.threads[sessionId]?.configOptions.find(
          (option) => option.id === configId
        )?.category
        try {
          const configOptions = await liveThreads.get(sessionId)?.setConfigOption(configId, value)
          if (configOptions) dispatch({ type: "config-options", id: sessionId, configOptions })
        } catch (error) {
          recordError(sessionId, error, `The agent rejected that ${configId} setting`)
          throw error
        }
        await syncSpawnState(sessionId, category, value)
      },

      async stop(sessionId: string) {
        await liveThreads.get(sessionId)?.cancel()
        /* The agent writes its own "[Request interrupted by user]" turn, but
           only the session/load replay surfaces it — without this the rule (and
           the Continue button on it) would not appear until a reload. */
        dispatch({ type: "notice", id: sessionId, text: "Request interrupted by user" })
      },

      /** Reversible: the agent process dies, the thread moves to Trash.
          A draft has neither, and nothing to be restored from — closing it just
          forgets it. */
      async deleteThread(sessionId: string) {
        if (stateRef.current.sessions.find((s) => s.id === sessionId)?.draft) {
          dispatch({ type: "drop-draft-session", id: sessionId })
          return
        }
        liveThreads.get(sessionId)?.close()
        liveThreads.delete(sessionId)
        await api(settings, `/api/sessions/${sessionId}`, { method: "DELETE" })
        await refreshSessions()
      },

      /** Back out of Trash. The thread returns process-less; opening it revives. */
      async restoreThread(sessionId: string) {
        await api(settings, `/api/sessions/${sessionId}/restore`, { method: "POST" })
        await refreshSessions()
      },

      /** The irreversible one — after this only the agent's own store has it. */
      async purgeThread(sessionId: string) {
        if (stateRef.current.sessions.find((s) => s.id === sessionId)?.draft) {
          dispatch({ type: "drop-draft-session", id: sessionId })
          return
        }
        liveThreads.get(sessionId)?.close()
        liveThreads.delete(sessionId)
        await api(settings, `/api/sessions/${sessionId}?purge=1`, { method: "DELETE" })
        await refreshSessions()
      },
    }
  }, [settings, dispatch])
}

export type Actions = ReturnType<typeof useActions>
