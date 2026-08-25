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

/** Side-effectful operations: REST calls + ACP thread lifecycle. */
export function useActions(settings: ServerSettings) {
  const { state, dispatch } = useStore()
  const stateRef = React.useRef(state)
  stateRef.current = state

  return React.useMemo(() => {
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
      onStatus: (status) => dispatch({ type: "thread-status", id, status }),
      onTurnActive: (active) => dispatch({ type: "turn-active", id, active }),
      onSessionConfig: (modes, configOptions) =>
        dispatch({ type: "session-config", id, modes, configOptions }),
      onTtft: (ms) => dispatch({ type: "ttft", id, ms: Math.round(ms) }),
      onTurnEnded: (usage, stopReason) => {
        dispatch({ type: "turn-active", id, active: false })
        if (usage) dispatch({ type: "usage", id, usage })
        if (stopReason) {
          dispatch({ type: "can-continue", id, canContinue: stopReason === "cancelled" })
        }
      },
    })

    /** Project -> the MCP server definitions it links to (dangling ids drop out). */
    const mcpFor = (project: Project) =>
      stateRef.current.mcpServers.filter((s) => project.mcpServerIds.includes(s.id))

    const refreshSessions = async () => {
      const sessions = await api<SessionMeta[]>(settings, "/api/sessions")
      dispatch({ type: "sessions", sessions })
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

      /** Connect (or reattach to) a thread; the caller navigates to its route. */
      async openThread(meta: SessionMeta) {
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
      },

      /** Resume a cancelled turn. Sends a prompt (ACP has no turn-resume), but
          the user neither types it nor sees it in the transcript. */
      async continueTurn(sessionId: string) {
        const thread = liveThreads.get(sessionId)
        if (!thread) throw new Error("thread not connected")
        dispatch({ type: "can-continue", id: sessionId, canContinue: false })
        const response = await thread.prompt("continue", true)
        if (response?.usage) dispatch({ type: "usage", id: sessionId, usage: response.usage })
        if (response) {
          dispatch({
            type: "can-continue",
            id: sessionId,
            canContinue: response.stopReason === "cancelled",
          })
        }
      },

      async send(sessionId: string, text: string) {
        const thread = liveThreads.get(sessionId)
        if (!thread) throw new Error("thread not connected")
        dispatch({ type: "user-message", id: sessionId, text })
        dispatch({ type: "session-title", id: sessionId, title: text.slice(0, 60) })
        const response = await thread.prompt(text)
        if (response?.usage) dispatch({ type: "usage", id: sessionId, usage: response.usage })
        // A cancelled turn is resumable — surface the Continue button.
        if (response) {
          dispatch({
            type: "can-continue",
            id: sessionId,
            canContinue: response.stopReason === "cancelled",
          })
        }
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
