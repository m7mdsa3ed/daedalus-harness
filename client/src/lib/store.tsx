/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import type {
  AgentDef,
  JournalEntry,
  McpServerDef,
  Profile,
  Project,
  SessionMeta,
  SkillDef,
} from "./settings"

// ---- thread item model ----

export interface TextItem {
  kind: "user" | "agent" | "thought"
  id: string
  text: string
}

export interface ToolItem {
  kind: "tool"
  id: string
  title: string
  status: string
  toolKind?: string
  /** Whatever the agent passed the tool — the only thing that identifies the call. */
  rawInput?: unknown
  content: acp.ToolCallContent[]
  locations: acp.ToolCallLocation[]
  /** Epoch ms the call appeared; drives the live elapsed counter. */
  startedAt: number
}

export interface PlanItem {
  kind: "plan"
  id: "plan"
  entries: acp.PlanEntry[]
}

export type ThreadItem = TextItem | ToolItem | PlanItem

export interface PendingPermission {
  request: acp.RequestPermissionRequest
  resolve: (response: acp.RequestPermissionResponse) => void
}

export interface ThreadState {
  items: ThreadItem[]
  status: "idle" | "connecting" | "connected" | "closed"
  turnActive: boolean
  permission: PendingPermission | null
  /** Permission-mode state (e.g. default / acceptEdits / plan) from the agent. */
  modes: acp.SessionModeState | null
  /** Agent config options (model, thinking level, …). */
  configOptions: acp.SessionConfigOption[]
  /** Cumulative token usage from the last completed turn. */
  usage: acp.Usage | null
  /** Context window occupancy from usage_update. */
  context: acp.UsageUpdate | null
  /** Time to first update of the last turn, ms. */
  ttftMs: number | null
}

export interface State {
  profiles: Profile[]
  projects: Project[]
  mcpServers: McpServerDef[]
  skills: SkillDef[]
  agents: AgentDef[]
  sessions: SessionMeta[]
  // Which thread is open and which screen is showing live in the URL — see lib/router.
  threads: Record<string, ThreadState>
}

export const emptyThread: ThreadState = {
  items: [],
  status: "idle",
  turnActive: false,
  permission: null,
  modes: null,
  configOptions: [],
  usage: null,
  context: null,
  ttftMs: null,
}

// ---- update application (shared by live updates and journal rebuild) ----

function appendText(items: ThreadItem[], kind: TextItem["kind"], text: string): ThreadItem[] {
  const last = items[items.length - 1]
  if (last && last.kind === kind) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...items, { kind, id: `${kind}-${items.length}`, text }]
}

export function applySessionUpdate(
  items: ThreadItem[],
  update: acp.SessionUpdate,
  allowUserChunks = false
): ThreadItem[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text") return items
      const kind = update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought"
      return appendText(items, kind, update.content.text)
    }
    case "user_message_chunk":
      // Live prompts push user messages locally, so the agent echo is skipped —
      // EXCEPT during a session/load replay, where chunks are the only source.
      if (allowUserChunks && update.content.type === "text") {
        return appendText(items, "user", update.content.text)
      }
      return items
    case "tool_call": {
      const item: ToolItem = {
        kind: "tool",
        id: update.toolCallId,
        title: update.title,
        status: update.status ?? "pending",
        toolKind: update.kind ?? undefined,
        rawInput: update.rawInput,
        content: update.content ?? [],
        locations: update.locations ?? [],
        startedAt: Date.now(),
      }
      if (items.some((i) => i.kind === "tool" && i.id === item.id)) {
        return items.map((i) => (i.kind === "tool" && i.id === item.id ? item : i))
      }
      return [...items, item]
    }
    case "tool_call_update":
      return items.map((i) => {
        if (i.kind !== "tool" || i.id !== update.toolCallId) return i
        return {
          ...i,
          title: update.title ?? i.title,
          status: update.status ?? i.status,
          toolKind: update.kind ?? i.toolKind,
          rawInput: update.rawInput ?? i.rawInput,
          content: update.content ?? i.content,
          locations: update.locations ?? i.locations,
        }
      })
    case "plan": {
      const plan: PlanItem = { kind: "plan", id: "plan", entries: update.entries }
      return items.some((i) => i.kind === "plan")
        ? items.map((i) => (i.kind === "plan" ? plan : i))
        : [...items, plan]
    }
    default:
      return items
  }
}

/** Session-level (non-transcript) updates applied to ThreadState. */
function applyMetaUpdate(
  thread: ThreadState,
  update: acp.SessionUpdate,
  allowUserChunks = false
): ThreadState {
  switch (update.sessionUpdate) {
    case "current_mode_update":
      return thread.modes
        ? { ...thread, modes: { ...thread.modes, currentModeId: update.currentModeId } }
        : thread
    case "config_option_update":
      return { ...thread, configOptions: update.configOptions }
    case "usage_update":
      return { ...thread, context: update }
    default:
      return { ...thread, items: applySessionUpdate(thread.items, update, allowUserChunks) }
  }
}

/** A turn can end with tool calls still in flight (cancel, agent crash) — no
    further update will ever arrive for them, so settle them at turn end instead
    of leaving a spinner running forever. */
function settleTools(items: ThreadItem[]): ThreadItem[] {
  return items.map((item) =>
    item.kind === "tool" && (item.status === "pending" || item.status === "in_progress")
      ? { ...item, status: "failed" }
      : item
  )
}

export function pushUserMessage(items: ThreadItem[], text: string): ThreadItem[] {
  return [...items, { kind: "user", id: `user-${items.length}`, text }]
}

/** Rebuild a thread from the server's frame journal after a reconnect. */
export function rebuildThread(entries: JournalEntry[]): ThreadState {
  let thread: ThreadState = { ...emptyThread }
  for (const entry of entries) {
    try {
      const msg = JSON.parse(entry.line)
      if (entry.d === "c" && msg.method === "session/prompt") {
        const text = ((msg.params?.prompt ?? []) as acp.ContentBlock[])
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
        if (text) thread = { ...thread, items: pushUserMessage(thread.items, text) }
      } else if (entry.d === "a" && msg.method === "session/update" && msg.params?.update) {
        // User chunks enabled: after a respawn the journal starts with a
        // session/load replay, where they are the only source of user messages.
        thread = applyMetaUpdate(thread, msg.params.update, true)
      } else if (entry.d === "a" && msg.result?.sessionId) {
        // session/new response: initial modes + config options
        thread = {
          ...thread,
          modes: msg.result.modes ?? thread.modes,
          configOptions: msg.result.configOptions ?? thread.configOptions,
        }
      } else if (entry.d === "a" && msg.method === "_daedalus/turn_ended") {
        // Server-synthesized turn end — carries usage even when the prompt's
        // requesting connection died mid-turn.
        thread = {
          ...thread,
          usage: msg.params?.usage ?? thread.usage,
          items: settleTools(thread.items),
        }
      } else if (entry.d === "a" && msg.result?.stopReason && msg.result?.usage) {
        thread = { ...thread, usage: msg.result.usage }
      }
    } catch {
      // non-JSON frame — ignore
    }
  }
  // A replayed user message can coexist with its sniffed session/prompt twin —
  // collapse consecutive identical user items.
  const items = thread.items.filter((item, i) => {
    const prev = thread.items[i - 1]
    return !(item.kind === "user" && prev?.kind === "user" && prev.text === item.text)
  })
  return { ...thread, items }
}

// ---- reducer ----

export type Action =
  | {
      type: "bootstrap"
      profiles: Profile[]
      projects: Project[]
      mcpServers: McpServerDef[]
      skills: SkillDef[]
      agents: AgentDef[]
      sessions: SessionMeta[]
    }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "profiles"; profiles: Profile[] }
  | { type: "projects"; projects: Project[] }
  | { type: "mcp-servers"; mcpServers: McpServerDef[] }
  | { type: "skills"; skills: SkillDef[] }
  | { type: "thread-reset"; id: string; thread: ThreadState }
  | { type: "thread-status"; id: string; status: ThreadState["status"] }
  | { type: "turn-active"; id: string; active: boolean }
  | { type: "update"; id: string; update: acp.SessionUpdate; allowUserChunks?: boolean }
  | { type: "user-message"; id: string; text: string }
  | { type: "permission"; id: string; permission: PendingPermission | null }
  | { type: "session-title"; id: string; title: string }
  | { type: "session-config"; id: string; modes: acp.SessionModeState | null; configOptions: acp.SessionConfigOption[] }
  | { type: "mode"; id: string; modeId: string }
  | { type: "config-options"; id: string; configOptions: acp.SessionConfigOption[] }
  | { type: "usage"; id: string; usage: acp.Usage }
  | { type: "ttft"; id: string; ms: number }

function thread(state: State, id: string): ThreadState {
  return state.threads[id] ?? emptyThread
}

function withThread(state: State, id: string, patch: Partial<ThreadState>): State {
  return { ...state, threads: { ...state.threads, [id]: { ...thread(state, id), ...patch } } }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "bootstrap":
      return {
        ...state,
        profiles: action.profiles,
        projects: action.projects,
        mcpServers: action.mcpServers,
        skills: action.skills,
        agents: action.agents,
        sessions: action.sessions,
      }
    case "sessions":
      return { ...state, sessions: action.sessions }
    case "profiles":
      return { ...state, profiles: action.profiles }
    case "projects":
      return { ...state, projects: action.projects }
    case "mcp-servers":
      return { ...state, mcpServers: action.mcpServers }
    case "skills":
      return { ...state, skills: action.skills }
    case "thread-reset":
      return { ...state, threads: { ...state.threads, [action.id]: action.thread } }
    case "thread-status":
      return withThread(state, action.id, { status: action.status })
    case "turn-active":
      return withThread(state, action.id, {
        turnActive: action.active,
        ...(action.active ? null : { items: settleTools(thread(state, action.id).items) }),
      })
    case "update":
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.id]: applyMetaUpdate(thread(state, action.id), action.update, action.allowUserChunks),
        },
      }
    case "user-message":
      return withThread(state, action.id, {
        items: pushUserMessage(thread(state, action.id).items, action.text),
      })
    case "permission":
      return withThread(state, action.id, { permission: action.permission })
    case "session-title":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id && s.title === "New thread" ? { ...s, title: action.title } : s
        ),
      }
    case "session-config":
      return withThread(state, action.id, { modes: action.modes, configOptions: action.configOptions })
    case "mode": {
      const t = thread(state, action.id)
      return t.modes
        ? withThread(state, action.id, { modes: { ...t.modes, currentModeId: action.modeId } })
        : state
    }
    case "config-options":
      return withThread(state, action.id, { configOptions: action.configOptions })
    case "usage":
      return withThread(state, action.id, { usage: action.usage })
    case "ttft":
      return withThread(state, action.id, { ttftMs: action.ms })
    default:
      return state
  }
}

export const initialState: State = {
  profiles: [],
  projects: [],
  mcpServers: [],
  skills: [],
  agents: [],
  sessions: [],
  threads: {},
}

// ---- context ----

export const StoreContext = React.createContext<{
  state: State
  dispatch: React.Dispatch<Action>
}>({ state: initialState, dispatch: () => {} })

export function useStore() {
  return React.useContext(StoreContext)
}
