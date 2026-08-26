import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import { CreateElicitationRequest } from "@agentclientprotocol/sdk"
import { AcpThread, liveThreads, type ConnectOptions, type ThreadCallbacks } from "./acp"
import { describeError, markReported, reportError } from "./errors"
import { prunePmPrefs } from "./pm/prefs"
import { pruneTaskTemplates } from "./pm/task-templates"
import { rankForIndex, renormalize } from "./pm/rank"
import type {
  ActivityEntry,
  AutomationRule,
  AutomationTestResult,
  Board,
  BoardInput,
  BoardSummary,
  BulkOp,
  BulkReorder,
  Burndown,
  Column,
  ColumnInput,
  Comment,
  CommentInput,
  CommentPage,
  CustomFieldDef,
  CustomFieldInput,
  DashboardStats,
  DependencyGraph,
  FilterSpec,
  IssueType,
  IssueTypeInput,
  Label,
  LabelInput,
  Milestone,
  MilestoneInput,
  MoveOp,
  SavedView,
  SearchHit,
  Sprint,
  SprintInput,
  Task,
  TaskCreateInput,
  TaskPage,
  TaskPatch,
  VelocityEntry,
} from "./pm/types"
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

/* ── PM module ──
   Thin wrappers: one api() call, one dispatch. The board endpoints answer with
   the entity they wrote, so almost every mutation ends in `upsert-board` /
   `upsert-pm-task` rather than a refetch — the exceptions are the config
   sub-resources, where the board's own arrays are what changed. */

/** A list-endpoint board row as a `Board`. The list carries no config tables;
    the reducer's `upsert-board` keeps whatever a full fetch already loaded. */
const hydrate = (board: BoardSummary): Board => ({
  ...board,
  columns: [],
  labels: [],
  issueTypes: [],
  customFields: [],
  sprints: [],
  milestones: [],
})

/** One page is 500 tasks (the server's own default); a board is walked in pages
    up to this many. Past it the board is bigger than a client-side view can
    honestly render and the views window their slices anyway. */
const PM_TASK_PAGE = 500
const PM_TASK_CAP = 5000

/** Filters as the query string `GET .../tasks` parses (repeatable keys). */
function taskQuery(filter: FilterSpec | undefined, limit: number, offset: number): string {
  const params = new URLSearchParams()
  if (filter?.q) params.set("q", filter.q)
  for (const id of filter?.columnIds ?? []) params.append("column", id)
  for (const name of filter?.assignees ?? []) params.append("assignee", name)
  for (const id of filter?.labelIds ?? []) params.append("label", id)
  for (const id of filter?.typeIds ?? []) params.append("type", id)
  if (filter?.sprint !== undefined) params.set("sprint", filter.sprint)
  if (filter?.epicId !== undefined) params.set("epic", filter.epicId)
  if (filter?.parentId !== undefined) params.set("parent", filter.parentId)
  if (filter?.milestoneId !== undefined) params.set("milestone", filter.milestoneId)
  if (filter?.priorityGte !== undefined) params.set("priorityGte", String(filter.priorityGte))
  if (filter?.due) params.set("due", filter.due)
  if (filter?.archived) params.set("archived", "1")
  if (filter?.trashed) params.set("trashed", "1")
  params.set("limit", String(limit))
  params.set("offset", String(offset))
  return params.toString()
}

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
      })
    }

    /* PM: the three reads every mutation below leans on. Declared here rather
       than inline in the returned object so a wrapper can refresh what it
       changed without going through the caller. */

    const refreshBoards = async (shelf?: { archived?: boolean; templates?: boolean; trashed?: boolean }) => {
      const params = new URLSearchParams()
      if (shelf?.archived) params.set("archived", "1")
      if (shelf?.templates) params.set("templates", "1")
      if (shelf?.trashed) params.set("trashed", "1")
      const query = params.toString()
      const boards = await api<BoardSummary[]>(settings, `/api/boards${query ? `?${query}` : ""}`)
      /* Only the live shelf is the store's list. Archive/templates/trash are
         other shelves of the same cupboard — replacing `boards` with one of
         them would empty the sidebar for everyone looking at it. */
      if (!query) {
        dispatch({ type: "set-boards", boards: boards.map(hydrate) })
        prunePmPrefs(boards.map((board) => board.id))
        pruneTaskTemplates(boards.map((board) => board.id))
      }
      return boards
    }

    /** The whole board: row + columns/labels/types/fields/sprints/milestones. */
    const loadBoard = async (boardId: string) => {
      const board = await api<Board>(settings, `/api/boards/${boardId}`)
      dispatch({ type: "upsert-board", board })
      return board
    }

    /**
     * A board's tasks, once. Cached in `pmTasks` by board id and only refetched
     * on `force` — every view narrows the same loaded list client-side
     * (lib/pm/filtering), so switching view or typing in the filter bar is not
     * a round trip. `filter` is for the shelves the cache does not hold
     * (archive, trash): pass one and the result is returned, not cached.
     */
    const loadBoardTasks = async (
      boardId: string,
      opts: { force?: boolean; filter?: FilterSpec } = {}
    ) => {
      if (opts.filter) {
        const page = await api<TaskPage>(
          settings,
          `/api/boards/${boardId}/tasks?${taskQuery(opts.filter, PM_TASK_PAGE, 0)}`
        )
        return page.tasks
      }
      const cached = stateRef.current.pmTasks[boardId]
      if (cached && !opts.force) return cached
      const tasks: Task[] = []
      let total = Infinity
      while (tasks.length < Math.min(total, PM_TASK_CAP)) {
        const page = await api<TaskPage>(
          settings,
          `/api/boards/${boardId}/tasks?${taskQuery(undefined, PM_TASK_PAGE, tasks.length)}`
        )
        total = page.total
        tasks.push(...page.tasks)
        if (page.tasks.length === 0) break
      }
      dispatch({ type: "set-pm-tasks", boardId, tasks })
      return tasks
    }

    /** The board's cached task, for the optimistic paths below. */
    const cachedTask = (boardId: string, taskId: string) =>
      stateRef.current.pmTasks[boardId]?.find((task) => task.id === taskId)

    return {
      refreshSessions,

      async bootstrap() {
        const [profiles, projects, mcpServers, skills, commands, agents, sessions, boards] =
          await Promise.all([
            api<Profile[]>(settings, "/api/profiles"),
            api<Project[]>(settings, "/api/projects"),
            api<McpServerDef[]>(settings, "/api/mcp-servers"),
            api<SkillDef[]>(settings, "/api/skills"),
            api<CommandDef[]>(settings, "/api/commands"),
            api<AgentDef[]>(settings, "/api/agents"),
            api<SessionMeta[]>(settings, "/api/sessions"),
            /* Boards are one small row each and the sidebar, the palette and
               the hub all need the list; their tasks are the big payload and
               they are NOT loaded here — see loadBoardTasks. */
            api<BoardSummary[]>(settings, "/api/boards"),
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
          boards: boards.map(hydrate),
        })
        prunePmPrefs(boards.map((board) => board.id))
        pruneTaskTemplates(boards.map((board) => board.id))
        return { profiles, projects, agents, sessions, boards }
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

      // ---- PM: boards -------------------------------------------------------

      refreshBoards,
      loadBoard,

      async createBoard(input: BoardInput) {
        const board = await api<Board>(settings, "/api/boards", {
          method: "POST",
          body: JSON.stringify(input),
        })
        dispatch({ type: "upsert-board", board })
        return board
      },

      async updateBoard(boardId: string, patch: Partial<BoardInput>) {
        const board = await api<Board>(settings, `/api/boards/${boardId}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
        dispatch({ type: "upsert-board", board })
        return board
      },

      /** Archived boards leave the live list — they are a different shelf. */
      async archiveBoard(boardId: string, archived = true) {
        const board = await api<BoardSummary>(settings, `/api/boards/${boardId}/archive`, {
          method: "POST",
          body: JSON.stringify({ archived }),
        })
        await refreshBoards()
        return board
      },

      /** Trash by default (restorable); `purge` is the irreversible one —
          same contract as deleteThread. */
      async deleteBoard(boardId: string, opts: { purge?: boolean } = {}) {
        await api(settings, `/api/boards/${boardId}${opts.purge ? "?purge=1" : ""}`, {
          method: "DELETE",
        })
        dispatch({ type: "remove-board", boardId })
      },

      async restoreBoard(boardId: string) {
        const board = await api<BoardSummary>(settings, `/api/boards/${boardId}/restore`, {
          method: "POST",
        })
        await refreshBoards()
        return board
      },

      /** Copy a board — as a template, and optionally with its tasks. */
      async duplicateBoard(
        boardId: string,
        opts: { asTemplate?: boolean; withTasks?: boolean } = {}
      ) {
        const board = await api<Board>(settings, `/api/boards/${boardId}/duplicate`, {
          method: "POST",
          body: JSON.stringify(opts),
        })
        dispatch({ type: "upsert-board", board })
        return board
      },

      // ---- PM: tasks --------------------------------------------------------

      loadBoardTasks,

      async createTask(boardId: string, input: TaskCreateInput) {
        const task = await api<Task>(settings, `/api/boards/${boardId}/tasks`, {
          method: "POST",
          body: JSON.stringify(input),
        })
        dispatch({ type: "upsert-pm-task", boardId, task })
        return task
      },

      async patchTask(boardId: string, taskId: string, patch: TaskPatch) {
        const task = await api<Task>(settings, `/api/boards/${boardId}/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
        dispatch({ type: "upsert-pm-task", boardId, task })
        return task
      },

      /**
       * Kanban / backlog drop.
       *
       * The card is painted in its new lane before the request goes out — a
       * drag that snapped back for the length of a round trip would read as a
       * failed drop. The rank is computed the way the server computes it
       * (lib/pm/rank), the server's own answer replaces it, and a failure puts
       * the card back where it was and says so.
       */
      async moveTask(boardId: string, taskId: string, op: MoveOp) {
        const before = cachedTask(boardId, taskId)
        if (before) {
          const siblings = (stateRef.current.pmTasks[boardId] ?? [])
            .filter(
              (task) =>
                task.id !== taskId &&
                task.columnId === op.columnId &&
                task.deletedAt === null &&
                task.archivedAt === null
            )
            .map((task) => task.order)
            .sort((a, b) => a - b)
          const { order } = rankForIndex(siblings, op.index)
          dispatch({
            type: "upsert-pm-task",
            boardId,
            task: {
              ...before,
              columnId: op.columnId,
              order,
              sprintId: op.sprintId !== undefined ? op.sprintId : before.sprintId,
            },
          })
        }
        try {
          const task = await api<Task>(settings, `/api/boards/${boardId}/tasks/${taskId}/move`, {
            method: "POST",
            body: JSON.stringify(op),
          })
          dispatch({ type: "upsert-pm-task", boardId, task })
          return task
        } catch (error) {
          if (before) dispatch({ type: "upsert-pm-task", boardId, task: before })
          reportError(error, "Couldn't move the task")
          throw error
        }
      },

      /** Multi-select ops — one transaction server-side, one array back. */
      async bulkTasks(boardId: string, op: BulkOp) {
        const tasks = await api<Task[]>(settings, `/api/boards/${boardId}/tasks/bulk`, {
          method: "POST",
          body: JSON.stringify(op),
        })
        for (const task of tasks) dispatch({ type: "upsert-pm-task", boardId, task })
        return tasks
      },

      /** Rewrite one rank list (sorts, multi-drag). Optimistic the same way a
          move is: the local ranks are renormalized to `i * 1000`, which is
          exactly what the server writes. */
      async reorder(boardId: string, input: BulkReorder) {
        const before = stateRef.current.pmTasks[boardId]
        if (before && input.scope.kind !== "columns") {
          const { ranks } = renormalize(input.orderedIds)
          const column = input.scope.kind === "column"
          for (const task of before) {
            const rank = ranks[task.id]
            if (rank === undefined) continue
            dispatch({
              type: "upsert-pm-task",
              boardId,
              task: column ? { ...task, order: rank } : { ...task, backlogRank: rank },
            })
          }
        }
        try {
          await api(settings, `/api/boards/${boardId}/reorder`, {
            method: "POST",
            body: JSON.stringify(input),
          })
        } catch (error) {
          if (before) dispatch({ type: "set-pm-tasks", boardId, tasks: before })
          if (input.scope.kind === "columns") await loadBoard(boardId)
          reportError(error, "Couldn't reorder")
          throw error
        }
        if (input.scope.kind === "columns") await loadBoard(boardId)
      },

      /** Trash (restorable) unless `purge`, which forgets the task for good. */
      async deleteTask(boardId: string, taskId: string, opts: { purge?: boolean } = {}) {
        const task = await api<Task | { ok: true }>(
          settings,
          `/api/boards/${boardId}/tasks/${taskId}${opts.purge ? "?purge=1" : ""}`,
          { method: "DELETE" }
        )
        dispatch({ type: "remove-pm-task", boardId, taskId })
        return task
      },

      async restoreTask(boardId: string, taskId: string) {
        const task = await api<Task>(settings, `/api/boards/${boardId}/tasks/${taskId}/restore`, {
          method: "POST",
        })
        dispatch({ type: "upsert-pm-task", boardId, task })
        return task
      },

      /* Archiving hides a task from the live board, so the cached list drops
         it; unarchiving is fetched back into it. */
      async archiveTask(boardId: string, taskId: string) {
        const task = await api<Task>(settings, `/api/boards/${boardId}/tasks/${taskId}/archive`, {
          method: "POST",
        })
        dispatch({ type: "remove-pm-task", boardId, taskId })
        return task
      },

      async unarchiveTask(boardId: string, taskId: string) {
        const task = await api<Task>(settings, `/api/boards/${boardId}/tasks/${taskId}/unarchive`, {
          method: "POST",
        })
        dispatch({ type: "upsert-pm-task", boardId, task })
        return task
      },

      // ---- PM: comments, activity, dependencies -----------------------------
      /* None of these enter the store: they are paginated logs the task editor
         fetches when it opens and forgets when it closes (the journal rule). */

      async listComments(boardId: string, taskId: string, page: { limit?: number; offset?: number } = {}) {
        const params = new URLSearchParams()
        if (page.limit !== undefined) params.set("limit", String(page.limit))
        if (page.offset !== undefined) params.set("offset", String(page.offset))
        const query = params.toString()
        return api<CommentPage>(
          settings,
          `/api/boards/${boardId}/tasks/${taskId}/comments${query ? `?${query}` : ""}`
        )
      },

      async addComment(boardId: string, taskId: string, input: CommentInput) {
        return api<Comment>(settings, `/api/boards/${boardId}/tasks/${taskId}/comments`, {
          method: "POST",
          body: JSON.stringify(input),
        })
      },

      async deleteComment(boardId: string, taskId: string, commentId: string) {
        await api(settings, `/api/boards/${boardId}/tasks/${taskId}/comments/${commentId}`, {
          method: "DELETE",
        })
      },

      /** `after` is the last seq already seen — a replay is a range scan. */
      async listActivity(boardId: string, taskId: string, opts: { after?: number; limit?: number } = {}) {
        const params = new URLSearchParams()
        if (opts.after !== undefined) params.set("after", String(opts.after))
        if (opts.limit !== undefined) params.set("limit", String(opts.limit))
        const query = params.toString()
        return api<ActivityEntry[]>(
          settings,
          `/api/boards/${boardId}/tasks/${taskId}/activity${query ? `?${query}` : ""}`
        )
      },

      async loadDependencies(boardId: string) {
        return api<DependencyGraph>(settings, `/api/boards/${boardId}/dependencies`)
      },

      async addDependency(boardId: string, taskId: string, dependsOnId: string) {
        await api(settings, `/api/boards/${boardId}/tasks/${taskId}/dependencies`, {
          method: "POST",
          body: JSON.stringify({ dependsOnId }),
        })
      },

      async removeDependency(boardId: string, taskId: string, dependsOnId: string) {
        await api(settings, `/api/boards/${boardId}/tasks/${taskId}/dependencies/${dependsOnId}`, {
          method: "DELETE",
        })
      },

      // ---- PM: board config -------------------------------------------------
      /* The sub-resources answer with the row they wrote, but what changed from
         the board's point of view is one of its arrays — so each of these ends
         in a board refetch rather than trying to splice the array by hand. */

      async createColumn(boardId: string, input: ColumnInput) {
        const column = await api<Column>(settings, `/api/boards/${boardId}/columns`, {
          method: "POST",
          body: JSON.stringify(input),
        })
        await loadBoard(boardId)
        return column
      },

      async patchColumn(boardId: string, columnId: string, patch: Partial<ColumnInput>) {
        const column = await api<Column>(settings, `/api/boards/${boardId}/columns/${columnId}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
        await loadBoard(boardId)
        return column
      },

      /** `moveTasksTo` is required by the server: a column delete must never
          eat tasks. The moved tasks change column, so the cache is refetched. */
      async deleteColumn(boardId: string, columnId: string, moveTasksTo: string) {
        await api(
          settings,
          `/api/boards/${boardId}/columns/${columnId}?moveTasksTo=${encodeURIComponent(moveTasksTo)}`,
          { method: "DELETE" }
        )
        await loadBoard(boardId)
        await loadBoardTasks(boardId, { force: true })
      },

      async createLabel(boardId: string, input: LabelInput) {
        const label = await api<Label>(settings, `/api/boards/${boardId}/labels`, {
          method: "POST",
          body: JSON.stringify(input),
        })
        await loadBoard(boardId)
        return label
      },

      async patchLabel(boardId: string, labelId: string, patch: Partial<LabelInput>) {
        const label = await api<Label>(settings, `/api/boards/${boardId}/labels/${labelId}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
        await loadBoard(boardId)
        return label
      },

      /** The join rows cascade, so every task that wore this label changed. */
      async deleteLabel(boardId: string, labelId: string) {
        await api(settings, `/api/boards/${boardId}/labels/${labelId}`, { method: "DELETE" })
        await loadBoard(boardId)
        await loadBoardTasks(boardId, { force: true })
      },

      async createIssueType(boardId: string, input: IssueTypeInput) {
        const type = await api<IssueType>(settings, `/api/boards/${boardId}/issue-types`, {
          method: "POST",
          body: JSON.stringify(input),
        })
        await loadBoard(boardId)
        return type
      },

      async patchIssueType(boardId: string, typeId: string, patch: Partial<IssueTypeInput>) {
        const type = await api<IssueType>(settings, `/api/boards/${boardId}/issue-types/${typeId}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
        await loadBoard(boardId)
        return type
      },

      /** `typeId` is SET NULL on delete — the tasks that had it changed too. */
      async deleteIssueType(boardId: string, typeId: string) {
        await api(settings, `/api/boards/${boardId}/issue-types/${typeId}`, { method: "DELETE" })
        await loadBoard(boardId)
        await loadBoardTasks(boardId, { force: true })
      },

      async createCustomField(boardId: string, input: CustomFieldInput) {
        const field = await api<CustomFieldDef>(settings, `/api/boards/${boardId}/custom-fields`, {
          method: "POST",
          body: JSON.stringify(input),
        })
        await loadBoard(boardId)
        return field
      },

      async patchCustomField(boardId: string, fieldId: string, patch: Partial<CustomFieldInput>) {
        const field = await api<CustomFieldDef>(
          settings,
          `/api/boards/${boardId}/custom-fields/${fieldId}`,
          { method: "PATCH", body: JSON.stringify(patch) }
        )
        await loadBoard(boardId)
        return field
      },

      async deleteCustomField(boardId: string, fieldId: string) {
        await api(settings, `/api/boards/${boardId}/custom-fields/${fieldId}`, { method: "DELETE" })
        await loadBoard(boardId)
        await loadBoardTasks(boardId, { force: true })
      },

      // ---- PM: sprints ------------------------------------------------------
      /* Thin on purpose. A sprint change moves the board's `sprints` array AND,
         for /complete and DELETE, the tasks that were in it — but the callers
         (components/pm/settings/sprint-editor) already end every flow in one
         `refreshAfterSprintChange`, so refetching here as well would double
         every planning click. These return what the server wrote; the caller
         decides when the board is reloaded. */

      async createSprint(boardId: string, input: SprintInput) {
        return api<Sprint>(settings, `/api/boards/${boardId}/sprints`, {
          method: "POST",
          body: JSON.stringify(input),
        })
      },

      async patchSprint(boardId: string, sprintId: string, patch: Partial<SprintInput>) {
        return api<Sprint>(settings, `/api/boards/${boardId}/sprints/${sprintId}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
      },

      /** `sprintId` is SET NULL on the tasks — they fall back to the backlog. */
      async deleteSprint(boardId: string, sprintId: string) {
        await api(settings, `/api/boards/${boardId}/sprints/${sprintId}`, { method: "DELETE" })
      },

      /** planned → active. One active sprint per board; the server says no. */
      async startSprint(boardId: string, sprintId: string) {
        return api<Sprint>(settings, `/api/boards/${boardId}/sprints/${sprintId}/start`, {
          method: "POST",
        })
      },

      /** active → completed, freezing the velocity snapshot. `moveIncompleteTo`
          is another open sprint, or null for the backlog. */
      async completeSprint(
        boardId: string,
        sprintId: string,
        moveIncompleteTo: string | null = null
      ) {
        return api<Sprint>(settings, `/api/boards/${boardId}/sprints/${sprintId}/complete`, {
          method: "POST",
          body: JSON.stringify({ moveIncompleteTo }),
        })
      },

      // ---- PM: milestones ---------------------------------------------------
      /* Thin, exactly like the sprint block: a milestone change moves the
         board's `milestones` array and — for DELETE — the tasks that carried it
         (SET NULL), but the caller (components/pm/settings/milestone-editor)
         ends every flow in one `refreshAfterMilestoneChange`, so refetching
         here as well would double every click. */

      async createMilestone(boardId: string, input: MilestoneInput) {
        return api<Milestone>(settings, `/api/boards/${boardId}/milestones`, {
          method: "POST",
          body: JSON.stringify(input),
        })
      },

      async patchMilestone(
        boardId: string,
        milestoneId: string,
        patch: Partial<MilestoneInput>
      ) {
        return api<Milestone>(settings, `/api/boards/${boardId}/milestones/${milestoneId}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
      },

      /** `milestoneId` is SET NULL on the tasks that pointed at it. */
      async deleteMilestone(boardId: string, milestoneId: string) {
        await api(settings, `/api/boards/${boardId}/milestones/${milestoneId}`, {
          method: "DELETE",
        })
      },

      /** One reversible switch: `reached: false` un-reaches it. */
      async reachMilestone(boardId: string, milestoneId: string, reached = true) {
        return api<Milestone>(
          settings,
          `/api/boards/${boardId}/milestones/${milestoneId}/reach`,
          { method: "POST", body: JSON.stringify({ reached }) }
        )
      },

      // ---- PM: saved views + automations ------------------------------------
      /* Both are whole-read json columns on the board row, so PUT is an upsert
         keyed by the id in the path — create and rename are the same call —
         and what changed from the client's point of view is the board itself.
         Hence the `loadBoard` at the end of every mutation here, exactly like
         the config sub-resources above. */

      async putSavedView(boardId: string, view: SavedView) {
        const saved = await api<SavedView>(
          settings,
          `/api/boards/${boardId}/views/${encodeURIComponent(view.id)}`,
          {
            method: "PUT",
            body: JSON.stringify({ name: view.name, view: view.view, filter: view.filter }),
          }
        )
        await loadBoard(boardId)
        return saved
      },

      async deleteSavedView(boardId: string, viewId: string) {
        await api(settings, `/api/boards/${boardId}/views/${encodeURIComponent(viewId)}`, {
          method: "DELETE",
        })
        await loadBoard(boardId)
      },

      async putAutomation(boardId: string, rule: AutomationRule) {
        const saved = await api<AutomationRule>(
          settings,
          `/api/boards/${boardId}/automations/${encodeURIComponent(rule.id)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              name: rule.name,
              enabled: rule.enabled,
              when: rule.when,
              if: rule.if,
              then: rule.then,
            }),
          }
        )
        await loadBoard(boardId)
        return saved
      },

      async deleteAutomation(boardId: string, ruleId: string) {
        await api(settings, `/api/boards/${boardId}/automations/${encodeURIComponent(ruleId)}`, {
          method: "DELETE",
        })
        await loadBoard(boardId)
      },

      /** Dry run: the server synthesizes the mutation the rule watches for and
          reports what WOULD be patched. Nothing is written, so nothing here
          touches the store. */
      async testAutomation(boardId: string, rule: AutomationRule, taskId: string) {
        return api<AutomationTestResult>(settings, `/api/boards/${boardId}/automations/test`, {
          method: "POST",
          body: JSON.stringify({ rule, taskId }),
        })
      },

      // ---- PM: reports ------------------------------------------------------
      /* Aggregates, not rows: nothing here enters the store. A chart owns the
         one response it asked for and forgets it on unmount — the same contract
         comments and activity have. */

      async fetchBurndown(boardId: string, sprintId: string) {
        return api<Burndown>(
          settings,
          `/api/boards/${boardId}/reports/burndown?sprintId=${encodeURIComponent(sprintId)}`
        )
      },

      /** One entry per completed sprint, oldest first. */
      async fetchVelocity(boardId: string) {
        return api<VelocityEntry[]>(settings, `/api/boards/${boardId}/reports/velocity`)
      },

      async fetchDashboard(boardId: string) {
        return api<DashboardStats>(settings, `/api/boards/${boardId}/dashboard`)
      },

      /** Cross-board task search (⌘K). Nothing is cached — it is a lookup. */
      async searchTasks(q: string, limit = 20) {
        if (!q.trim()) return []
        return api<SearchHit[]>(
          settings,
          `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`
        )
      },
    }
  }, [settings, dispatch])
}

export type Actions = ReturnType<typeof useActions>

/**
 * Refetch the PM data when the tab comes back to the front.
 *
 * A board is shared by every client of the harness, and unlike a thread it has
 * no socket telling this one that something changed — so the moment the user
 * looks at the tab again is the honest moment to ask. Boards always; a board's
 * tasks only when one is open, which is the only list big enough to be worth
 * not refetching blind.
 */
export function usePmRefreshOnFocus(actions: Actions, boardId?: string): void {
  React.useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return
      actions.refreshBoards().catch((error) => console.warn("Couldn't refresh the boards", error))
      if (boardId) {
        actions
          .loadBoardTasks(boardId, { force: true })
          .catch((error) => console.warn(`Couldn't refresh board ${boardId}`, error))
      }
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [actions, boardId])
}
