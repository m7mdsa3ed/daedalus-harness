import * as React from "react"
import { AcpThread, liveThreads, type ThreadCallbacks } from "./acp"
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
} from "./settings"
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
    const reconnectThread = async (sessionId: string) => {
      const sessions = await api<SessionMeta[]>(settings, "/api/sessions")
      dispatch({ type: "sessions", sessions })
      const meta = sessions.find((s) => s.id === sessionId)
      if (!meta) throw new Error("thread no longer exists on the server")
      await openThread(meta)
    }

    const scheduleReconnect = (sessionId: string) => {
      if (reconnectTimers.has(sessionId)) return
      const attempt = (reconnectAttempts.get(sessionId) ?? 0) + 1
      if (attempt > RECONNECT_MAX_ATTEMPTS) return

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
          void reconnectThread(sessionId).catch((error) => {
            console.warn(`Reconnecting thread ${sessionId} failed`, error)
            dispatch({ type: "thread-status", id: sessionId, status: "closed" })
            scheduleReconnect(sessionId)
          })
        }, delayMs),
      )
    }

    const makeCallbacks = (id: string): ThreadCallbacks => ({
      onUpdate: (notification, replaying) =>
        dispatch({ type: "update", id, update: notification.update, allowUserChunks: replaying }),
      onPermission: (request) =>
        new Promise((resolve) => {
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
      onStatus: (status, closeInfo) => {
        if (status === "connected") {
          reconnectAttempts.delete(id)
        } else if (
          status === "closed" &&
          !closeInfo?.clientInitiated &&
          !NON_RECONNECTABLE_CLOSE_CODES.has(closeInfo?.code ?? 0)
        ) {
          scheduleReconnect(id)
        }
        dispatch({ type: "thread-status", id, status })
      },
      onTurnActive: (active) => dispatch({ type: "turn-active", id, active }),
      onSessionConfig: (modes, configOptions) =>
        dispatch({ type: "session-config", id, modes, configOptions }),
      onTtft: (ms) => dispatch({ type: "ttft", id, ms: Math.round(ms) }),
      onTurnEnded: (usage) => {
        dispatch({ type: "turn-active", id, active: false })
        if (usage) dispatch({ type: "usage", id, usage })
      },
    })

    /** Project -> the MCP server definitions it links to (dangling ids drop out). */
    const mcpFor = (project: Project) =>
      stateRef.current.mcpServers.filter((s) => project.mcpServerIds.includes(s.id))

    const refreshSessions = async () => {
      const sessions = await api<SessionMeta[]>(settings, "/api/sessions")
      dispatch({ type: "sessions", sessions })
    }

    /** Connect (or reattach to) a thread; the caller navigates to its route. */
    const openThread = async (meta: SessionMeta) => {
      if (liveThreads.get(meta.id)?.connected) return
      const project = stateRef.current.projects.find((p) => p.id === meta.projectId)
      if (!project) return

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
        const thread = new AcpThread(meta.id, settings, makeCallbacks(meta.id))
        liveThreads.set(meta.id, thread)
        await thread.connect({
          fresh: false,
          load: true,
          project,
          mcpServers: mcpFor(project),
          cursor: 0,
          acpSessionId: meta.acpSessionId,
        })
        return
      }

      const journal = await api<{ cursor: number; entries: JournalEntry[] }>(
        settings,
        `/api/sessions/${meta.id}/journal`
      )
      dispatch({ type: "thread-reset", id: meta.id, thread: rebuildThread(journal.entries) })
      // A turn may still be running server-side; _daedalus/turn_ended clears this.
      if (meta.promptActive) dispatch({ type: "turn-active", id: meta.id, active: true })
      const thread = new AcpThread(meta.id, settings, makeCallbacks(meta.id))
      liveThreads.set(meta.id, thread)
      await thread.connect({
        fresh: false,
        project,
        mcpServers: mcpFor(project),
        cursor: journal.cursor,
        acpSessionId: meta.acpSessionId,
      })
    }

    return {
      refreshSessions,

      async bootstrap() {
        const [profiles, projects, mcpServers, skills, agents, sessions] = await Promise.all([
          api<Profile[]>(settings, "/api/profiles"),
          api<Project[]>(settings, "/api/projects"),
          api<McpServerDef[]>(settings, "/api/mcp-servers"),
          api<SkillDef[]>(settings, "/api/skills"),
          api<AgentDef[]>(settings, "/api/agents"),
          api<SessionMeta[]>(settings, "/api/sessions"),
        ])
        dispatch({ type: "bootstrap", profiles, projects, mcpServers, skills, agents, sessions })
        return { profiles, projects, agents, sessions }
      },

      async refreshProfiles() {
        const profiles = await api<Profile[]>(settings, "/api/profiles")
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

      async newThread(project: Project, profile: Profile, model?: string, effort?: string) {
        const { id } = await api<{ id: string }>(settings, "/api/sessions", {
          method: "POST",
          body: JSON.stringify({ profileId: profile.id, projectId: project.id, model, effort }),
        })
        const thread = new AcpThread(id, settings, makeCallbacks(id))
        liveThreads.set(id, thread)
        dispatch({ type: "thread-reset", id, thread: { ...emptyThread } })
        await refreshSessions()
        await thread.connect({ fresh: true, project, mcpServers: mcpFor(project) })
        return id
      },

      openThread,

      async reviveThread(sessionId: string) {
        reconnectAttempts.delete(sessionId)
        await reconnectThread(sessionId)
      },

      async send(sessionId: string, text: string) {
        const thread = liveThreads.get(sessionId)
        if (!thread) throw new Error("thread not connected")
        dispatch({ type: "user-message", id: sessionId, text })
        dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
        // The response's usage is dropped on purpose: `_daedalus/turn_ended`
        // reports the same turn, and usage now accumulates — counting both
        // would double it.
        await thread.prompt(text)
      },

      /**
       * Change profile/model/effort mid-session: the server swaps the agent
       * process (new env), then the conversation is restored via session/load.
       */
      async changeSession(
        meta: SessionMeta,
        next: { profileId?: string; model?: string; effort?: string }
      ) {
        const project = stateRef.current.projects.find((p) => p.id === meta.projectId)
        if (!project) throw new Error("unknown project")
        liveThreads.get(meta.id)?.close()
        await api(settings, `/api/sessions/${meta.id}/respawn`, {
          method: "POST",
          body: JSON.stringify({
            profileId: next.profileId ?? meta.profileId,
            model: next.model ?? meta.model ?? undefined,
            effort: next.effort ?? meta.effort ?? undefined,
          }),
        })
        await refreshSessions()
        // The journal was reset server-side; the load replay rebuilds the transcript.
        dispatch({ type: "thread-reset", id: meta.id, thread: { ...emptyThread } })
        const thread = new AcpThread(meta.id, settings, makeCallbacks(meta.id))
        liveThreads.set(meta.id, thread)
        await thread.connect({
          fresh: false,
          load: true,
          project,
          mcpServers: mcpFor(project),
          cursor: 0,
          acpSessionId: meta.acpSessionId,
        })
      },

      async setMode(sessionId: string, modeId: string) {
        await liveThreads.get(sessionId)?.setMode(modeId)
        dispatch({ type: "mode", id: sessionId, modeId })
      },

      async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
        const configOptions = await liveThreads.get(sessionId)?.setConfigOption(configId, value)
        if (configOptions) dispatch({ type: "config-options", id: sessionId, configOptions })
      },

      async stop(sessionId: string) {
        await liveThreads.get(sessionId)?.cancel()
      },

      async killThread(sessionId: string) {
        liveThreads.get(sessionId)?.close()
        liveThreads.delete(sessionId)
        await api(settings, `/api/sessions/${sessionId}`, { method: "DELETE" })
        await refreshSessions()
      },
    }
  }, [settings, dispatch])
}

export type Actions = ReturnType<typeof useActions>
