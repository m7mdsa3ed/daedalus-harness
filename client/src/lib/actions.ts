import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import { AgentError, liveThreads, ThreadSocket, type ThreadCallbacks } from "./thread-socket"
import { describeError, markReported } from "./errors"
import { appendOutput } from "./workspace/output"
import { uuid } from "./uuid"
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
  type McpServerDef,
  type Profile,
  type Project,
  type ScheduledMessage,
  type ServerSettings,
  type SessionMeta,
  type SkillDef,
  type CommandDef,
} from "./settings"
import { emptyThread, useStore, type Action } from "./store"

const RECONNECT_MAX_ATTEMPTS = 5
const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 8000
const NON_RECONNECTABLE_CLOSE_CODES = new Set([4000, 4002, 4004])
const reconnectAttempts = new Map<string, number>()
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** The last journal cursor this client has folded into a thread's state, keyed
    by session id. On a reconnect to an *alive* process this is what lets us ask
    for the delta instead of rebuilding the transcript from zero — a full
    replay of a long thread is thousands of events the client already has in
    memory. Reset to 0 (pull it out) whenever the thread is respawned, since a
    respawn clears the server's journal. */
const journalCursors = new Map<string, number>()

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
    const recordError = (
      sessionId: string,
      err: unknown,
      context: string,
      retryText?: string,
      /* Where the row goes. Everything but the replay wants it committed now;
         the replay wants it in the same fold as the transcript it belongs to,
         or the error lands in a thread that is about to be reset out from
         under it. */
      emit: (action: Action) => void = dispatch,
    ) => {
      const info = describeError(err)
      console.error(`[${context}]`, err)
      // It has a home in the transcript now; the global net must not re-toast it
      // if a caller lets the rethrow escape.
      markReported(err)
      if (info.kind === "cancelled") return info
      emit({
        type: "error",
        id: sessionId,
        title: context,
        reason: info.title,
        detail: info.detail,
        retryText,
      })
      /* Also to the project's Output pane. Not instead of the transcript row —
         that stays where the user is looking — but a failure whose detail is a
         stack trace or a compiler's complaint is exactly what a workspace pane
         is for, and it is where a `file:line` becomes clickable. */
      const projectId = stateRef.current.sessions.find((s) => s.id === sessionId)?.projectId
      if (projectId)
        appendOutput(projectId, "agent", [info.title, info.detail].filter(Boolean).join("\n"))
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
      // Deleted mid-connection (another tab, another device): reconnecting is
      // not a thing that can succeed, so stop the backoff and say what happened
      // once, instead of retrying a revive the server must refuse.
      if (meta.deletedAt) {
        reconnectAttempts.delete(sessionId)
        dispatch({ type: "thread-status", id: sessionId, status: "closed" })
        dispatch({
          type: "error",
          id: sessionId,
          title: "This thread was deleted",
          reason: "It moved to Trash on this server — restore it to reopen it.",
        })
        return
      }
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

    /* `owner` is filled in by startThread the moment the socket exists — see the
       guard in onStatus. */
    const makeCallbacks = (id: string, owner: { thread?: ThreadSocket }): ThreadCallbacks => {
      /* The replay is a few thousand events, and dispatching each one commits a
         render of a transcript nobody has looked at yet — which is what made a
         long thread visibly rebuild itself line by line. So between `attached`
         and `caught_up` the actions go into a list instead, and the whole
         history lands as one `batch`. Nothing else changes: the callbacks below
         run in the same order on the same events, and a live socket (buffer
         null) still commits every action the moment it arrives.

         Two rules keep it honest. Everything thread-scoped goes through `send`,
         never `dispatch` — a stray direct dispatch would jump the queue and land
         before the `thread-reset` that is still sitting in the buffer. And any
         exit from the replay flushes: `caught_up` is the ordinary one, a socket
         that dies mid-replay is the other, and without the second the history
         would be dropped on the floor along with the close status. */
      let buffer: Action[] | null = null
      const send = (action: Action) => {
        if (buffer) buffer.push(action)
        else dispatch(action)
      }
      /* The one hot dispatch: an agent streams text as dozens of chunks a
         second, and each one is a full state update. Marking it a transition
         lets React treat it as interruptible — a burst of chunks coalesces into
         the frames the display can actually show instead of one render per
         token. Everything else stays urgent (a permission appearing, a status
         flip, a turn ending) and goes through `send`. */
      const sendStream = (action: Action) => {
        if (buffer) buffer.push(action)
        else React.startTransition(() => dispatch(action))
      }
      const flush = () => {
        const pending = buffer
        buffer = null
        if (pending?.length) dispatch({ type: "batch", actions: pending })
      }
      return {
        onUpdate: (update, historyReplay) =>
          sendStream({ type: "update", id, update, allowUserChunks: historyReplay }),
        /* The agent is blocked on this question until somebody answers it. The
           server holds its promise now, so `resolve` is a message rather than a
           callback: it names the request the server minted, which is also how a
           peer's answer is matched against this card. */
        onPermission: (requestId, request) => {
          notifyThreadEvent("permissionNeeded", id, titleOf(id), request.toolCall?.title ?? undefined)
          send({
            type: "permission",
            id,
            permission: {
              requestId,
              request,
              resolve: (response) => {
                send({ type: "permission", id, permission: null })
                owner.thread?.answerPermission(requestId, response)
              },
            },
          })
        },
        onElicitation: (requestId, request) => {
          notifyThreadEvent("questionAsked", id, titleOf(id), request.message)
          send({
            type: "elicitation",
            id,
            elicitation: {
              requestId,
              request,
              resolve: (response) => {
                send({ type: "elicitation", id, elicitation: null })
                owner.thread?.answerElicitation(requestId, response)
              },
            },
          })
        },
        /* Somebody else settled this question — another device answered it, or
           the agent's process died holding it. Either way the card is stale and
           the answer is no longer ours to give. */
        onRequestAnswered: (requestId) => {
          const thread = stateRef.current.threads[id]
          if (thread?.permission?.requestId === requestId) {
            send({ type: "permission", id, permission: null })
          }
          if (thread?.elicitation?.requestId === requestId) {
            send({ type: "elicitation", id, elicitation: null })
          }
        },
        onStatus: (status, closeInfo) => {
          /* A respawn or a reconnect installs a new socket for this same session
             id while the old one is still closing. The old instance's closing
             status is about a connection nobody is using — letting it through
             marks the live thread dead and, worse, books a reconnect against it. */
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
          send({
            type: "thread-status",
            id,
            status,
            closeCode: closeInfo?.code,
            closeReason: closeInfo?.reason,
          })
          /* A dead socket ends any turn it was carrying. The server does answer
             the prompts an exiting agent never will — but if the close beats the
             `turn_ended` to this tab, the working indicator would outlive the
             process and only a reload would clear it. */
          if (status === "closed") send({ type: "turn-active", id, active: false })
          /* Last, so the status and whatever history was already buffered commit
             together: a close during the replay is the one exit `caught_up`
             never gets to make. */
          if (status !== "connected") flush()
        },
        /* The session's whole settings state, from wherever it changed: the
           handshake, this device, or another one. It is absolute, so applying it
           twice is the same as applying it once. */
        onSessionConfig: (modes, modeId, configOptions) => {
          if (modes !== undefined || configOptions !== undefined) {
            /* Left out means unchanged, and the reducer is what resolves it:
               inside a batched replay this action is not committed yet, so
               reading the current value here would read the thread as it was
               before the replay began. */
            send({ type: "session-config", id, modes: modes ?? null, configOptions })
          } else if (modeId) {
            send({ type: "mode", id, modeId })
          }
          /* Remember what this profile's agent offers. A draft has no process to
             ask, so without this a new thread cannot show a single setting until
             it has already started — see lib/agent-options. */
          const profileId = stateRef.current.sessions.find((s) => s.id === id)?.profileId
          if (profileId && configOptions && configOptions.length > 0) {
            saveAgentOptions(profileId, configOptions)
          }
        },
        onTtft: (ms) => send({ type: "ttft", id, ms }),
        onTurnEnded: (usage, error, promptText, catchingUp) => {
          send({ type: "turn-active", id, active: false })
          if (usage) send({ type: "usage", id, usage })
          if (error) {
            // Recorded in the transcript either way — a failure that survived a
            // reload is still the answer to the message above it, and carries the
            // text so the row can offer Retry.
            const info = recordError(
              id,
              error,
              "The agent couldn't answer this message",
              promptText,
              send,
            )
            if (!catchingUp && info.kind !== "cancelled") {
              notifyThreadEvent("turnFailed", id, titleOf(id), info.title)
            }
          } else if (!catchingUp) {
            // Notifying on replay would re-announce every turn in the thread on
            // every reload — on a phone, as a push.
            notifyThreadEvent("turnFinished", id, titleOf(id))
          }
        },
        /* A turn began on words this device did not type — either another peer
           prompted, or this is the replay rebuilding the transcript. Only the
           first is live activity. */
        onTurnStarted: (text, catchingUp) => {
          send({ type: "user-message", id, text })
          send({ type: "session-title", id, title: text.slice(0, 60) })
          if (!catchingUp) send({ type: "turn-active", id, active: true })
        },
        // The replay is about to start. `from` is where it begins: 0 is a full
        // rebuild (the usual case, and the only one the server can tell apart
        // from "brand new"), anything else is a delta — a reconnect to a thread
        // this device already has most of in memory, so the transcript is kept
        // and only the gap is appended.
        onAttached: (from, historyLost) => {
          buffer = []
          const resuming = from > 0
          /* Keep what is on screen when resuming; replace it otherwise. A reset
             would throw away the transcript a delta is about to extend, and a
             delta appended onto a stale transcript would double-render whatever
             the server re-sends. `from === 0` therefore means "start over",
             matching the server's own clamp. The status is left to the socket's
             `onStatus` flow (connecting → connected) and only committed at
             `caught_up`; touching it here would race the connect() we are
             inside. */
          if (!resuming) {
            send({ type: "thread-reset", id, thread: { ...emptyThread, status: "connecting" } })
          }
          /* The agent would not reload this conversation, so the replay about
             to arrive is empty. Said here rather than left to look like a quiet
             thread — and through `send`, so it lands inside the same fold as
             the (empty) transcript it belongs to rather than ahead of the reset
             above. Repeated on every reattach because the server holds it for
             as long as the process that failed the load is the one running. */
          if (historyLost)
            recordError(
              id,
              new AgentError(historyLost.error),
              "Couldn't restore this thread's history",
              undefined,
              send
            )
        },
        // A turn may still be running server-side; `turn_ended` clears it.
        onCaughtUp: (cursor, promptActive) => {
          journalCursors.set(id, cursor)
          if (promptActive) send({ type: "turn-active", id, active: true })
          flush()
        },
        // A background task's journal grew server-side. Into the module store,
        // not the reducer: the events are keyed by transcript dir, not by
        // thread, and the panel reading them subscribes there (lib/task-events).
        onTaskEvent: (transcriptDir, event) => {
          appendTaskEvent(transcriptDir, event)
          /* Also to the project's Output pane, *as well as* the transcript's own
             task card rather than instead of it: the card is the shape of the
             work (which agent, how far along), and Output is the running text —
             where a `file:line` in a build's stderr becomes a clickable problem.
             Two readings of one stream, which is the same bargain the Problems
             filter makes. */
          const projectId = stateRef.current.sessions.find((s) => s.id === id)?.projectId
          const text = typeof event.message === "string" ? event.message : ""
          if (projectId && text.trim()) appendOutput(projectId, "task", text)
        },
      }
    }

    /* Swap the agent process and put the conversation back.
       The one move that needs this: profile, model and effort are all filled
       into the agent's env template at spawn (server/src/registry.ts), so they
       cannot be changed on a process that is already running. Callers decide
       what to send — what they leave out, the server rebuilds from the profile's
       own defaults.

       All of it happens server-side now, in one call: spawn, session/load, and
       putting back the mode and switches the restart reset. This used to be
       three round trips driven from here, which meant closing the tab halfway
       through left a half-restored thread. */
    const respawnThread = async (
      meta: SessionMeta,
      body: { profileId: string; model?: string; effort?: string },
      context: string
    ) => {
      try {
        liveThreads.get(meta.id)?.close()
        await api(settings, `/api/sessions/${meta.id}/respawn`, {
          method: "POST",
          body: JSON.stringify(body),
        })
        await refreshSessions()
        /* The respawn clears the server's journal, so the saved cursor is past
           its end. Drop it so the attach below is a clean `from: 0` rebuild
           instead of relying on the server's clamp. */
        journalCursors.delete(meta.id)
        // The event log was rebuilt by the load replay; attaching from 0 reads it.
        await startThread(meta.id)
      } catch (error) {
        // The old process is already gone at this point, so a failure here
        // leaves a thread that needs reviving — say that, in the thread.
        recordError(meta.id, error, context)
        throw error
      }
    }

    /** Bring a draft into existence: tell the server (which spawns the agent
        and handshakes), adopt its row, then attach. The id travelled from the
        client, so the route the user is already looking at needs no correction. */
    const createSession = async (meta: SessionMeta) => {
      const project = stateRef.current.projects.find((p) => p.id === meta.projectId)
      const profile = stateRef.current.profiles.find((p) => p.id === meta.profileId)
      if (!project) throw new Error("Choose a project for this thread before sending.")
      if (!profile) throw new Error("Choose a profile for this thread before sending.")
      /* Spawning the agent and handshaking takes a second or two, and until the
         socket opens there is no status at all — so the thread would sit there
         looking like nothing had happened to the message just sent. */
      dispatch({ type: "thread-status", id: meta.id, status: "connecting" })
      await api<{ id: string }>(settings, "/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          id: meta.id,
          profileId: profile.id,
          projectId: project.id,
          model: meta.model || undefined,
          effort: meta.effort || undefined,
          /* Settings picked on the draft, against the option set the agent last
             advertised. The server applies them the moment session/new answers,
             best-effort: a remembered option the agent no longer offers must not
             stop the message that created the thread. */
          configChoices: meta.configChoices,
        }),
      })
      // Swaps the draft row for the server's own — see the `sessions` reducer.
      await refreshSessions()
      await startThread(meta.id)
    }

    /** Open a socket, register it as the session's live one, and wait for the
        replay to finish. Every path that connects goes through here, so the
        ownership wiring the callbacks depend on exists in exactly one place. */
    const startThread = async (id: string, cursor = 0) => {
      const owner: { thread?: ThreadSocket } = {}
      const thread = new ThreadSocket(id, settings, makeCallbacks(id, owner))
      owner.thread = thread
      liveThreads.set(id, thread)
      await thread.connect({ cursor })
      return thread
    }

    /** The journal position to resume a reconnect from. 0 when this device has
        never folded this thread's journal (fresh connect or a page reload), or
        when the agent is about to be respawned — a respawn clears the journal,
        so a stale saved cursor would point past its end, which the server
        clamps back to 0 anyway. A value > 0 is the delta: "I already have this
        much; give me the rest." */
    const resumeCursor = (meta: SessionMeta): number => {
      if (meta.exited) return 0
      return journalCursors.get(meta.id) ?? 0
    }

    /* Hoisted rather than left as a method on the returned object, for the same
       reason `refreshSessions` is: `scheduleMessage` and `cancelSchedule` both
       have to re-read the list after they change it, and a bare call to a
       sibling method does not resolve — there is no `this` in scope here. */
    const refreshScheduled = async () => {
      const scheduled = await api<ScheduledMessage[]>(settings, "/api/scheduled")
      dispatch({ type: "scheduled", scheduled })
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
      // A thread whose project was deleted can never open. Saying nothing left
      // it stuck on the connecting skeleton forever.
      if (!stateRef.current.projects.some((p) => p.id === meta.projectId)) {
        throw new Error(
          "This thread's project no longer exists, so there is no working directory to run the agent in."
        )
      }

      // A deleted thread is exited with no way back through the revive path —
      // restore is what brings it around. Throwing here also stops the
      // reconnect backoff from re-POSTing a respawn the server must refuse,
      // which is where the old "session deleted" retry loop came from.
      if (meta.deletedAt) {
        throw new Error(
          "This thread is in Trash — restore it from the thread list to open it again."
        )
      }

      // No live process (idle-retired or the server restarted): revive it. The
      // server respawns, replays the conversation through session/load and puts
      // the settings back before it answers.
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
        /* Respawn cleared the server's journal; a saved cursor now points past
           its end. Dropping it makes the attach below a clean `from: 0` rebuild
           rather than leaning on the server's clamp. */
        journalCursors.delete(meta.id)
      }

      /* Attach from where this device last stopped, or the beginning of the log
         if it never filled this thread (or the journal was just cleared). The
         replay is bracketed (`attached` resets or extends, `caught_up` ends
         it), and it carries the same events the live socket sends — so there is
         no second parser here and no cursor to keep in step. A delta (`from >
         0`) keeps the transcript on screen and appends only the gap, which is
         what makes a reconnect to a long thread cheap. `caught_up` also carries
         whether a turn is still running, read server-side in the same tick as
         the log it follows: `meta.promptActive` is a snapshot from the last
         /api/sessions fetch, and stale-false loses the indicator while
         stale-true strands it. */
      await startThread(meta.id, resumeCursor(meta))
    }

    return {
      refreshSessions,

      async bootstrap() {
        const [profiles, projects, mcpServers, skills, commands, agents, sessions, scheduled] =
          await Promise.all([
            api<Profile[]>(settings, "/api/profiles"),
            api<Project[]>(settings, "/api/projects"),
            api<McpServerDef[]>(settings, "/api/mcp-servers"),
            api<SkillDef[]>(settings, "/api/skills"),
            api<CommandDef[]>(settings, "/api/commands"),
            api<AgentDef[]>(settings, "/api/agents"),
            api<SessionMeta[]>(settings, "/api/sessions"),
            api<ScheduledMessage[]>(settings, "/api/scheduled"),
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
          scheduled,
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

      refreshScheduled,

      /**
       * Schedule `text` to be sent to a thread's agent at `nextAt` (and again
       * every `everyMs`). The server owns delivery (scheduler.ts), so the
       * message goes out whether or not this tab is open — and a trashed thread
       * never receives it. For a draft thread, the draft is materialized first
       * (the server only schedules threads it knows), mirroring `send`.
       */
      async createSchedule(input: {
        sessionId: string
        text: string
        nextAt: number
        everyMs?: number | null
      }) {
        // A draft has no server row to schedule against — bring it into being
        // the way sending its first message would, then schedule the real one.
        const draft = stateRef.current.sessions.find(
          (s) => s.id === input.sessionId && s.draft
        )
        if (draft) {
          await createSession(draft)
        }
        await api<ScheduledMessage>(settings, "/api/scheduled", {
          method: "POST",
          body: JSON.stringify(input),
        })
        await refreshScheduled()
      },

      async cancelSchedule(id: string) {
        await api(settings, `/api/scheduled/${id}`, { method: "DELETE" })
        await refreshScheduled()
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
        const id = opts.id ?? uuid()
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
            /* `createSession` turns the status to `connecting` before it asks
               the server for anything, so a failure has to turn it back: it is
               what draws the "Spawning the agent…" line, and a shimmer that
               never resolves under the error row says the opposite of what the
               row says. Back to `idle` — the draft is still a draft, and the
               Retry on that row runs this again. */
            dispatch({ type: "thread-status", id: sessionId, status: "idle" })
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
        /* Steering — a prompt sent while a turn is already running — is why this
           is read BEFORE the dispatch below. If this send fails, it may only
           take back the indicator it turned on itself: a steer that never
           reaches the agent leaves the turn it was aimed at still running, and
           clearing the indicator there loses it until a reload (the server is
           still `promptActive`, so `caught_up` puts it straight back — which is
           exactly the "refresh brings it back" shape of the bug). */
        const alreadyRunning = stateRef.current.threads[sessionId]?.turnActive ?? false
        dispatch({ type: "user-message", id: sessionId, text })
        dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
        /* This device is the one peer that does not get a `turn_started` — it
           already put the message on screen — so it lights its own indicator.
           `turn_ended` is what clears it, here and everywhere else. */
        dispatch({ type: "turn-active", id: sessionId, active: true })
        try {
          /* Resolves when the server has dispatched the prompt, not when the
             turn ends: how the turn went reaches every device on the thread as
             `turn_ended`, and awaiting it here would report a failure twice. */
          await thread.prompt(text)
        } catch (error) {
          if (!alreadyRunning) dispatch({ type: "turn-active", id: sessionId, active: false })
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
        /* Model and effort are also process env: the server rebuilds them from
           the session record every time it revives a retired thread. It records
           the change itself now (it knows the option's category), so all that is
           left here is to re-read the list this thread's row appears in. */
        if (category === "model" || category === "thought_level") await refreshSessions()
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
