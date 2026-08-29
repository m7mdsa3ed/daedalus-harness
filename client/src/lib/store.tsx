/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
// Value import, but tools.ts imports only *types* from here — erased at build,
// so there is no runtime cycle.
import { applyTerminalMeta, parseTaskNotification, type TerminalState } from "./tools"
import type {
  AgentDef,
  CommandDef,
  McpServerDef,
  Profile,
  Project,
  ScheduledMessage,
  SessionMeta,
  SkillDef,
} from "./settings"

// ---- thread item model ----

export interface TextItem {
  /** `notice` = transcript rule (interrupts): agent-authored, nobody typed it. */
  kind: "user" | "agent" | "thought" | "notice"
  id: string
  text: string
  /** Epoch ms this client first saw the item. Absent on anything rebuilt from
      a session/load replay: the journal carries no clock, so a replayed item
      has no honest time to show and shows none rather than the reload's. */
  at?: number
}

export interface ToolItem {
  kind: "tool"
  id: string
  title: string
  status: string
  toolKind?: string
  /** Whatever the agent passed the tool — the only thing that identifies the call. */
  rawInput?: unknown
  /** Whatever the tool returned. ACP sends this alongside `content`, and for
      shell/read/search tools it is the payload worth rendering — `content` is
      often empty or a duplicate. */
  rawOutput?: unknown
  content: acp.ToolCallContent[]
  locations: acp.ToolCallLocation[]
  /** The updates' `_meta`, merged — vendor extensions ride here (Claude Code's
      `toolResponse` is how a background task discloses its transcript dir).
      Read only in lib/tools, where agent-specific shapes are quarantined. */
  meta?: Record<string, unknown>
  /** Bytes a runtime streamed through the terminal channel rather than
      through `content`. Codex announces every shell command as a terminal
      handle and sends the output as `_meta.terminal_output_delta` chunks, so
      this is accumulated here — `meta` is merged key-wise per update, which
      would keep only the last chunk. Read through `lib/tools`. */
  terminal?: TerminalState
  /** Epoch ms the call appeared; drives the live elapsed counter. */
  startedAt: number
  /** Wall-clock stamp, live only — see TextItem.at. */
  at?: number
}

/**
 * An agent's execution plan.
 *
 * ACP carries plans two ways and we accept both. The original `plan`
 * notification is always a list of entries and there is only ever one of them,
 * so it keeps the fixed id `"plan"`. The newer `plan_update` carries a `planId`
 * and one of three shapes — structured entries, raw markdown, or a URI pointing
 * at a file — which is why this is a union of optional fields rather than an
 * entry list: a markdown plan has no entries to show, and inventing some by
 * parsing its headings would be the client guessing at the agent's meaning.
 */
export interface PlanItem {
  kind: "plan"
  /** `"plan"` for the legacy channel, `plan:<planId>` for `plan_update` —
      several plans can be open at once on the newer one. */
  id: string
  /** Structured tasks: the `plan` channel, and `plan_update` type `items`. */
  entries: acp.PlanEntry[]
  /** A plan the agent wrote as prose (`plan_update` type `markdown`). */
  markdown?: string
  /** A plan that lives in a file (`plan_update` type `file`). */
  uri?: string
}

/**
 * A failure, in the transcript, where it happened. A toast is the wrong home
 * for these: a prompt that errored is part of what happened in this thread, and
 * the thing the user wants next — the exact text, sent again — is only knowable
 * here. `detail` is the agent's own account of it (JSON-RPC `data`, a stack, a
 * server body), shown folded away.
 */
export interface ErrorItem {
  kind: "error"
  id: string
  /** What the app was trying to do — "Couldn't send the message". */
  title: string
  /** Why it failed, in one line — "The agent hit an internal error". */
  reason?: string
  /** The unabridged cause: JSON-RPC `data`, a stack, a server body. Folded away. */
  detail?: string
  /** The prompt this failure killed. Present => the row offers Retry. */
  retryText?: string
  at?: number
}

/**
 * The agent compacted its own context: history replaced by a summary, in the
 * place in the transcript where it happened.
 *
 * This is an upsert keyed by `compactionId`, and the *first* update fixes its
 * position — later ones patch it where it already sits, which is why the id is
 * `compaction:<id>` and not a positional one. The summary arrives two ways and
 * both have to work: whole, on a `compaction_update` (replacement semantics —
 * an omitted `summary` leaves the stored one alone, `null` or `[]` clears it),
 * or streamed as `compaction_summary_chunk` blocks that append to it.
 */
export interface CompactionItem {
  kind: "compaction"
  /** `compaction:<compactionId>`. */
  id: string
  status: acp.CompactionStatus
  /** Content blocks, not text: a summary is an ACP ContentBlock list and the
      renderer already knows how to draw every variant. */
  summary: acp.ContentBlock[]
  /** Why it failed. Only ever set alongside `status: "failed"`. */
  error?: string
  at?: number
}

export type ThreadItem = TextItem | ToolItem | PlanItem | ErrorItem | CompactionItem

export interface PendingPermission {
  /** The server's id for the question, so an answer from another device can be
      matched exactly instead of guessed at from the tool call it belongs to. */
  requestId: string
  request: acp.RequestPermissionRequest
  resolve: (response: acp.RequestPermissionResponse) => void
}

/** An elicitation (AskUserQuestion form, MCP elicitation, URL flow) the agent
    is blocked on. Same lifecycle as PendingPermission: resolve answers the
    agent and clears the card. */
export interface PendingElicitation {
  requestId: string
  request: acp.CreateElicitationRequest
  resolve: (response: acp.CreateElicitationResponse) => void
}

export interface ThreadState {
  items: ThreadItem[]
  status: "idle" | "connecting" | "connected" | "closed"
  /** WebSocket close code/reason of the last close — drives the closed-state banner. */
  closeCode?: number
  closeReason?: string
  turnActive: boolean
  permission: PendingPermission | null
  elicitation: PendingElicitation | null
  /** Permission-mode state (e.g. default / acceptEdits / plan) from the agent. */
  modes: acp.SessionModeState | null
  /** Agent config options (model, thinking level, …). */
  configOptions: acp.SessionConfigOption[]
  /** Slash commands the agent advertises (available_commands_update). */
  availableCommands: acp.AvailableCommand[]
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
  commands: CommandDef[]
  agents: AgentDef[]
  sessions: SessionMeta[]
  /** Scheduled prompts on the server, one row per future/recurring delivery. */
  scheduled: ScheduledMessage[]
  // Which thread is open and which screen is showing live in the URL — see lib/router.
  threads: Record<string, ThreadState>
}

export const emptyThread: ThreadState = {
  items: [],
  status: "idle",
  closeCode: undefined,
  closeReason: undefined,
  turnActive: false,
  permission: null,
  elicitation: null,
  modes: null,
  configOptions: [],
  availableCommands: [],
  usage: null,
  context: null,
  ttftMs: null,
}

/**
 * A thread with nothing in it yet.
 *
 * Three things hang off this — the centred composer, the welcome block, and the
 * hero wash behind the whole pane — and they live in different components, so
 * they all ask here rather than each deciding for itself. A draft counts as
 * empty on sight: it has no connection to be waiting on, and nothing is ever
 * going to arrive until someone types.
 *
 * `connecting` outranks `draft`, and that ordering is the whole point of the
 * first message: `actions.send` flips the status before it POSTs, so the wash
 * goes and the composer docks the instant the message is sent rather than two
 * seconds later when the agent has finished spawning and the first item lands.
 * The transcript is not empty at that moment in any sense the user cares about
 * — the send happened — and leaving the hero up through the spawn read as the
 * message having gone nowhere.
 */
export function threadIsEmpty(thread: ThreadState, draft?: boolean): boolean {
  if (thread.items.length > 0) return false
  // Already on its way to a transcript, draft or not: that reads as loading.
  if (thread.status === "connecting") return false
  if (draft) return true
  // Not yet started at all.
  return thread.status !== "idle"
}

// ---- update application (shared by live updates and journal rebuild) ----

function appendText(
  items: ThreadItem[],
  kind: TextItem["kind"],
  text: string,
  at?: number
): ThreadItem[] {
  const last = items[items.length - 1]
  if (last && last.kind === kind) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...items, { kind, id: `${kind}-${items.length}`, text, at }]
}

/* Agents write a synthetic user turn when a prompt is cancelled, so the model
   can see why the assistant stopped mid-sentence. It is a genuine user-role
   message in the agent's own transcript — and it stays there, in the model's
   context, which is the point. But nobody typed it, so it reads as a rule
   across the transcript, not as a user bubble. The capture keeps the agent's
   own wording (plain vs "for tool use") as the rule's label.
   Anchored on the whole (trimmed) chunk: quoting the phrase inside a real
   message must still render as that message. Pattern mirrors claude-agent-sdk's. */
const SYNTHETIC_USER_RE = /^\[(Request interrupted by user[^\]]*)\]$/

const metaOf = (update: object): Record<string, unknown> | undefined =>
  (update as { _meta?: Record<string, unknown> | null })._meta ?? undefined

/* Each update's `_meta` carries only what changed alongside it: the launch
   update holds the one-shot `toolResponse`, while later ones repeat constants
   like `toolName` without it — so replacing wholesale would forget the launch
   record the moment the call completed. Merged one level deep, which is where
   vendors nest (`_meta.claudeCode.…`); deeper values replace. */
function mergeMeta(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!next) return prev
  if (!prev) return next
  const merged: Record<string, unknown> = { ...prev, ...next }
  for (const key of Object.keys(next)) {
    const a = prev[key]
    const b = next[key]
    if (
      a !== null && b !== null &&
      typeof a === "object" && typeof b === "object" &&
      !Array.isArray(a) && !Array.isArray(b)
    ) {
      merged[key] = { ...a, ...b }
    }
  }
  return merged
}

export function applySessionUpdate(
  items: ThreadItem[],
  update: acp.SessionUpdate,
  allowUserChunks = false
): ThreadItem[] {
  /* `allowUserChunks` is set only by the replay path, so it doubles as "this is
     history": replayed items get no timestamp rather than the reload's. */
  const at = allowUserChunks ? undefined : Date.now()
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text") return items
      const kind = update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought"
      return appendText(items, kind, update.content.text, at)
    }
    case "user_message_chunk": {
      if (update.content.type !== "text") return items
      /* A background task announcing that it finished. The runtime injects it
         as a user turn so the model reads it on its next turn, but nobody
         typed it and no local push mirrors it — so unlike an ordinary user
         chunk it has to pass through LIVE as well as on replay, and it must
         not render as a bubble of XML. `notice` is the existing home for an
         agent-authored transcript event; the renderer parses the block. */
      if (parseTaskNotification(update.content.text)) {
        const text = update.content.text.trim()
        /* Deduped across the whole transcript, not just against the previous
           item: a load replay can restate a turn the client already has (and
           has been observed restating one turn twice inside a single replay),
           with other items in between. The block carries the task's id, so
           identical text is the same completion — the way a repeated tool_call
           is the same call by its toolCallId. */
        if (items.some((item) => item.kind === "notice" && item.text === text)) return items
        return [...items, { kind: "notice", id: `notice-${items.length}`, text, at }]
      }
      // Live prompts push user messages locally, so the agent echo is skipped —
      // EXCEPT during a session/load replay, where chunks are the only source.
      if (!allowUserChunks) return items
      const synthetic = SYNTHETIC_USER_RE.exec(update.content.text.trim())
      // Not appendText: two interrupts in a row are two rules, never one
      // concatenated label.
      // Live cancels push their own notice from actions.stop() so the rule (and
      // its Continue button) appears immediately; on replay the agent's own
      // wording rebuilds the transcript and supersedes it.
      if (synthetic) {
        return [...items, { kind: "notice", id: `notice-${items.length}`, text: synthetic[1], at }]
      }
      return appendText(items, "user", update.content.text, at)
    }
    case "tool_call": {
      const item: ToolItem = {
        kind: "tool",
        id: update.toolCallId,
        title: update.title,
        status: update.status ?? "pending",
        toolKind: update.kind ?? undefined,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        content: update.content ?? [],
        locations: update.locations ?? [],
        meta: metaOf(update),
        terminal: applyTerminalMeta(undefined, metaOf(update)),
        startedAt: Date.now(),
        at,
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
          rawOutput: update.rawOutput ?? i.rawOutput,
          content: update.content ?? i.content,
          locations: update.locations ?? i.locations,
          meta: mergeMeta(i.meta, metaOf(update)),
          terminal: applyTerminalMeta(i.terminal, metaOf(update)),
        }
      })
    case "plan": {
      // The legacy channel: one plan per session, replaced wholesale each time.
      const plan: PlanItem = { kind: "plan", id: "plan", entries: update.entries }
      return items.some((i) => i.kind === "plan" && i.id === "plan")
        ? items.map((i) => (i.kind === "plan" && i.id === "plan" ? plan : i))
        : [...items, plan]
    }
    case "plan_update": {
      /* The newer channel. Each variant replaces that plan entirely — the spec
         is explicit that an update carries the whole thing, so there is nothing
         to merge. An unknown variant is dropped rather than rendered as an
         empty plan. */
      const content = update.plan
      const base = { kind: "plan" as const, id: `plan:${content.planId}`, entries: [] }
      const plan: PlanItem | null =
        content.type === "items"
          ? { ...base, entries: content.entries }
          : content.type === "markdown"
            ? { ...base, markdown: content.content }
            : content.type === "file"
              ? { ...base, uri: content.uri }
              : null
      if (!plan) return items
      return items.some((i) => i.kind === "plan" && i.id === plan.id)
        ? items.map((i) => (i.kind === "plan" && i.id === plan.id ? plan : i))
        : [...items, plan]
    }
    case "compaction_update": {
      /* Patch semantics, per field: an omitted `summary`/`error` leaves what is
         stored alone, `null` clears it, a value replaces it. `summary: []` is a
         value that happens to clear too. Conflating "absent" with "empty" here
         would wipe a streamed summary the moment the terminal update lands
         without one — which is exactly how agents send it. */
      const id = `compaction:${update.compactionId}`
      const existing = items.find(
        (i): i is CompactionItem => i.kind === "compaction" && i.id === id
      )
      const summary =
        update.summary === undefined ? (existing?.summary ?? []) : (update.summary ?? [])
      const error =
        update.error === undefined ? existing?.error : (update.error ?? undefined)
      const item: CompactionItem = {
        kind: "compaction",
        id,
        status: update.status,
        summary,
        error,
        at: existing?.at ?? at,
      }
      return existing
        ? items.map((i) => (i.kind === "compaction" && i.id === id ? item : i))
        : [...items, item]
    }
    case "compaction_summary_chunk": {
      /* Appends to a compaction already on screen. The spec has chunks arrive
         only between the `in_progress` update and the terminal one, so a chunk
         for an id we have never seen is a stray — dropped rather than made into
         a headless summary with no status to describe it. */
      const id = `compaction:${update.compactionId}`
      return items.map((i) =>
        i.kind === "compaction" && i.id === id
          ? { ...i, summary: [...i.summary, update.content] }
          : i
      )
    }
    case "plan_removed":
      // The agent abandoned this plan; leaving it on screen would describe work
      // nobody is doing any more.
      return items.filter((i) => !(i.kind === "plan" && i.id === `plan:${update.planId}`))
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
    case "available_commands_update":
      return { ...thread, availableCommands: update.availableCommands }
    case "usage_update":
      return { ...thread, context: update }
    default:
      return { ...thread, items: applySessionUpdate(thread.items, update, allowUserChunks) }
  }
}

/** A turn can end with tool calls still in flight (cancel, agent crash) — no
    further update will ever arrive for them, so settle them at turn end instead
    of leaving a spinner running forever. A compaction is the same bargain: its
    terminal update is owed by the same process that just stopped talking. */
function settleTools(items: ThreadItem[]): ThreadItem[] {
  return items.map((item) => {
    if (item.kind === "tool" && (item.status === "pending" || item.status === "in_progress")) {
      return { ...item, status: "failed" }
    }
    if (item.kind === "compaction" && item.status === "in_progress") {
      return { ...item, status: "failed" as acp.CompactionStatus }
    }
    return item
  })
}

export function pushUserMessage(items: ThreadItem[], text: string, at?: number): ThreadItem[] {
  return [...items, { kind: "user", id: `user-${items.length}`, text, at }]
}

/** null only when neither side reported the field — keeps optional stats hidden. */
const addOptional = (a: number | null | undefined, b: number | null | undefined) =>
  a == null && b == null ? null : (a ?? 0) + (b ?? 0)

/**
 * ACP's Usage doc-comments claim session totals, but agents send per-turn
 * numbers (observed: totalTokens falling between turns), so the running total
 * is ours to keep — and an average cache rate needs it. The `turn_ended` event
 * is the ONLY caller: it is the one place a turn's usage is reported, live and
 * on replay alike, so nothing can count the same turn twice.
 */
export function addUsage(prev: acp.Usage | null, next: acp.Usage): acp.Usage {
  if (!prev) return next
  return {
    totalTokens: prev.totalTokens + next.totalTokens,
    inputTokens: prev.inputTokens + next.inputTokens,
    outputTokens: prev.outputTokens + next.outputTokens,
    thoughtTokens: addOptional(prev.thoughtTokens, next.thoughtTokens),
    cachedReadTokens: addOptional(prev.cachedReadTokens, next.cachedReadTokens),
    cachedWriteTokens: addOptional(prev.cachedWriteTokens, next.cachedWriteTokens),
  }
}

// ---- reducer ----

export type Action =
  | {
      type: "bootstrap"
      profiles: Profile[]
      projects: Project[]
      mcpServers: McpServerDef[]
      skills: SkillDef[]
      commands: CommandDef[]
      agents: AgentDef[]
      sessions: SessionMeta[]
      scheduled?: ScheduledMessage[]
    }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "scheduled"; scheduled: ScheduledMessage[] }
  | { type: "draft-session"; session: SessionMeta }
  | { type: "drop-draft-session"; id: string }
  | {
      type: "configure-draft"
      id: string
      next: Partial<Pick<SessionMeta, "projectId" | "profileId" | "agentId" | "model" | "effort">>
    }
  | { type: "draft-config-option"; id: string; configId: string; value: string | boolean }
  | { type: "profiles"; profiles: Profile[] }
  | { type: "projects"; projects: Project[] }
  | { type: "mcp-servers"; mcpServers: McpServerDef[] }
  | { type: "skills"; skills: SkillDef[] }
  | { type: "commands"; commands: CommandDef[] }
  | { type: "thread-reset"; id: string; thread: ThreadState }
  | {
      type: "thread-status"
      id: string
      status: ThreadState["status"]
      closeCode?: number
      closeReason?: string
    }
  | { type: "turn-active"; id: string; active: boolean }
  | { type: "update"; id: string; update: acp.SessionUpdate; allowUserChunks?: boolean }
  | { type: "user-message"; id: string; text: string }
  | { type: "notice"; id: string; text: string }
  | { type: "error"; id: string; title: string; reason?: string; detail?: string; retryText?: string }
  | { type: "dismiss-error"; id: string; itemId: string }
  | { type: "permission"; id: string; permission: PendingPermission | null }
  | { type: "elicitation"; id: string; elicitation: PendingElicitation | null }
  | { type: "session-title"; id: string; title: string }
  /** Absolute state, with one hole: an event may carry modes and leave the
      options out, which means "unchanged" and not "none". The reducer is where
      that is resolved, because during a batched replay the caller cannot read
      the current value — it has not been committed yet. */
  | {
      type: "session-config"
      id: string
      modes: acp.SessionModeState | null
      configOptions?: acp.SessionConfigOption[]
    }
  | { type: "mode"; id: string; modeId: string }
  | { type: "config-options"; id: string; configOptions: acp.SessionConfigOption[] }
  | { type: "usage"; id: string; usage: acp.Usage }
  | { type: "ttft"; id: string; ms: number }
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

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "batch":
      return action.actions.reduce(reducer, state)
    case "bootstrap":
      return {
        ...state,
        profiles: action.profiles,
        projects: action.projects,
        mcpServers: action.mcpServers,
        skills: action.skills,
        commands: action.commands,
        agents: action.agents,
        sessions: action.sessions,
        scheduled: action.scheduled ?? state.scheduled,
      }
    case "scheduled":
      return { ...state, scheduled: action.scheduled }
    case "sessions": {
      /* The server's list is authoritative for every thread it knows about —
         but a draft is precisely one it has not been told about yet, so this
         merges rather than replaces. Replacing would make a new thread vanish
         under the user the moment any refresh landed. A draft whose id the
         server now reports has just been created: the server's row wins and the
         draft marker goes with it. */
      const known = new Set(action.sessions.map((session) => session.id))
      const drafts = state.sessions.filter((session) => session.draft && !known.has(session.id))
      return { ...state, sessions: [...drafts, ...action.sessions] }
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
             would replay a config id the new agent has never heard of. */
          const rescoped =
            action.next.agentId !== undefined || action.next.profileId !== undefined
          return { ...s, ...action.next, ...(rescoped ? { configChoices: undefined } : null) }
        }),
      }
    case "draft-config-option":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id && s.draft
            ? { ...s, configChoices: { ...s.configChoices, [action.configId]: action.value } }
            : s
        ),
      }
    case "profiles":
      return { ...state, profiles: action.profiles }
    case "projects":
      return { ...state, projects: action.projects }
    case "mcp-servers":
      return { ...state, mcpServers: action.mcpServers }
    case "skills":
      return { ...state, skills: action.skills }
    case "commands":
      return { ...state, commands: action.commands }
    case "thread-reset":
      return { ...state, threads: { ...state.threads, [action.id]: action.thread } }
    case "thread-status":
      // Only a close carries a code; clear it otherwise so a stale reason can't
      // leak into the banner of the next connection.
      return withThread(state, action.id, {
        status: action.status,
        closeCode: action.status === "closed" ? action.closeCode : undefined,
        closeReason: action.status === "closed" ? action.closeReason : undefined,
      })
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
        items: pushUserMessage(thread(state, action.id).items, action.text, Date.now()),
      })
    case "notice": {
      // Never two rules in a row: cancelling an already-cancelled turn is one
      // interruption, and the transcript should say so once.
      const items = thread(state, action.id).items
      if (items[items.length - 1]?.kind === "notice") return state
      return withThread(state, action.id, {
        items: [...items, { kind: "notice", id: `notice-${items.length}`, text: action.text, at: Date.now() }],
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
          items: [...items.slice(0, -1), { ...last, retryText: action.retryText }],
        })
      }
      return withThread(state, action.id, {
        // A prompt that died mid-turn leaves tool calls spinning forever.
        items: settleTools([
          ...items,
          {
            kind: "error",
            id: `error-${items.length}`,
            title: action.title,
            reason: action.reason,
            detail: action.detail,
            retryText: action.retryText,
            at: Date.now(),
          },
        ]),
      })
    }
    case "dismiss-error":
      return withThread(state, action.id, {
        items: thread(state, action.id).items.filter((i) => i.id !== action.itemId),
      })
    case "permission":
      return withThread(state, action.id, { permission: action.permission })
    case "elicitation":
      return withThread(state, action.id, { elicitation: action.elicitation })
    case "session-title":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id && s.title === "New thread" ? { ...s, title: action.title } : s
        ),
      }
    case "session-config":
      return withThread(state, action.id, {
        modes: action.modes,
        configOptions: action.configOptions ?? thread(state, action.id).configOptions,
      })
    case "mode": {
      const t = thread(state, action.id)
      return t.modes
        ? withThread(state, action.id, { modes: { ...t.modes, currentModeId: action.modeId } })
        : state
    }
    case "config-options":
      return withThread(state, action.id, { configOptions: action.configOptions })
    case "usage":
      return withThread(state, action.id, { usage: addUsage(thread(state, action.id).usage, action.usage) })
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
  commands: [],
  agents: [],
  sessions: [],
  scheduled: [],
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
