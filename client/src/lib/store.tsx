/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import type * as acp from "@daedalus/acp"
import type {
  AsyncTaskState,
  AttachmentRef,
  QueuedMessage,
  QuotaSnapshot,
  SessionUpdate,
  SubagentState,
  TurnChanges,
  TurnTick,
  WireError,
  WorkflowProgressEntry,
} from "@daedalus/protocol"
// Value import, but tools.ts imports only *types* from here — erased at build,
// so there is no runtime cycle.
import {
  applyTerminalMeta,
  parentToolIdOf,
  parseTaskNotification,
  subagentItemId,
  toolNameOf,
  workflowInfoOf,
  type TerminalState,
  type WorkflowStepInfo,
} from "./tools"
import { sameRow } from "./settings"
import { unclaimed } from "./thread/carry"
import { IDLE_PHASE, isOpening, type ConnPhase } from "./thread/phase"
import type {
  AgentDef,
  CommandDef,
  McpServerDef,
  Persona,
  Profile,
  Project,
  Routine,
  RoutineRun,
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
  /** What this message carried, on a user bubble. References, never bytes —
      the chip fetches `/api/attachments/:id` (see `AttachmentRef`). Journaled
      on `turn_started`, so a replayed bubble draws the same chips a live one
      did. `inlineData` is the exception, and only for the *agent's* copy: a
      `session/load` replay hands back image blocks the harness has no row for
      (see `user_message_chunk` below). */
  attachments?: (AttachmentRef & { inlineData?: string; oversized?: boolean })[]
  /** Epoch ms this client first saw the item. Absent on anything rebuilt from
      a session/load replay: the journal carries no clock, so a replayed item
      has no honest time to show and shows none rather than the reload's. */
  at?: number
  /** Logical turn restore point, present on user messages. */
  turnId?: string
  /** This device typed this message — set only on the optimistic bubble
      `actions.send` draws, never on one rebuilt from the journal. What makes it
      survive an attach that replaces the transcript, exactly as `ErrorItem.local`
      does; and what tells it apart from the untagged bubbles a `session/load`
      replay produces, which carry no `turnId` either (they arrive as
      `user_message_chunk`s, and the harness's `turn_started` — the only thing
      that mints a `turnId` — is not part of what an agent replays). Without it
      every message of the conversation was read as one this device had just
      sent and not had acknowledged, so the next non-resumed attach carried the
      whole user side of the thread across the reset and put it back at the
      bottom. */
  local?: boolean
  /** The item this belongs to when it is a subagent's, not the thread's — see
      `SubagentItem`. */
  parentId?: string
}

export interface ToolItem {
  kind: "tool"
  id: string
  title: string
  /** The tool's own name, when the call was *announced* under one — OpenCode
      sends `websearch`, Codex `mcp.<server>.<tool>` — and a later update
      retitled it in prose (`Exa Web Search "…"`). `title` follows the updates,
      so the reader is told what the row is; this keeps what it *was*, which is
      what `lib/tools` matches on. Never overwritten by an update. */
  name?: string
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
  /** The item this call belongs to when a subagent made it: the Task that
      launched the subagent (Claude Code), or the `subagent:<sessionId>` item
      of the child session it ran in. Derived from vendor `_meta` through
      `lib/tools.parentToolIdOf`, or from the session id an update arrived on.
      The store stays FLAT — every item sits in `items` in arrival order, so the
      reducer, replay, `settleTools` and every consumer that walks the list are
      untouched — and nesting is a way of looking at it, built at view time by
      `lib/transcript-rows`. */
  parentId?: string
}

/**
 * A subagent's session, announced by the agent (the ACP subagent RFD's
 * `subagent_spawned`), or a child session a runtime names in `_meta` before
 * any tool call has claimed it. The row a child's work groups under when no
 * tool call launched it — Codex's children have no Task; the spawn IS the
 * announcement. Upserted by `subagent:<subagentSessionId>`, so the first
 * update fixes its place and the terminal `subagent_state_update` patches it
 * where it sits. `parentId` is set when the spawn arrived on another child's
 * session — that is how the RFD nests.
 */
export interface SubagentItem {
  kind: "subagent"
  /** `subagent:<sessionId>`. */
  id: string
  sessionId: string
  name: string
  /** What was delegated, in the agent's words — descriptive, not a prompt. */
  task: string
  /** `running` until the parent reports otherwise. */
  state: "running" | SubagentState
  capabilities: { cancel?: boolean; close?: boolean }
  /** Set when this session is a harness workflow step — the server stamps the
      spawn's `_meta.daedalus.workflow`, read by `lib/tools.workflowInfoOf`.
      What lets `transcript-rows` fold a run's steps into one `WorkflowGroup`. */
  workflow?: WorkflowStepInfo
  /** What this child's turns cost, accumulated — one `_daedalus/subagent_usage`
      per settled turn, so a step that took a repair turn adds up. Absent for a
      child whose runtime never reported any: an agent that does not meter is
      not an agent that spent nothing, so the difference is kept. */
  usage?: acp.Usage
  /** The child's own context occupancy, from its `usage_update`. Its window is
      not the thread's — a step is a whole separate session — which is exactly
      why it is stamped here rather than reaching `ThreadState`. */
  context?: acp.UsageUpdate
  /* ── Previewed, not streamed ──
     A step of a Claude Code dynamic workflow (see `nativeWorkflowRun` in
     transcript-rows) has no session and no rail: its agent runs inside the CLI,
     which reports what it was asked, what it answered and the tool it is on as
     three previews rather than as a transcript. An RFD child carries none of
     these — its prose IS its report, and it is already on its rail. */
  /** The brief this step was given, as far as the runtime previews it. */
  prompt?: string
  /** What it answered, or why it failed. */
  report?: string
  /** What it is doing right now — the newest tool call, in the runtime's words. */
  activity?: string
  /** Where this step's own history is, when it has one the harness can read:
      a native workflow agent writes `agent-<agentId>.jsonl` beside its run's
      journal on the server's disk, and that file is the only record of its
      steps. Fetched when the step is opened (`lib/agent-transcripts`). */
  transcript?: { dir: string; agentId: string }
  startedAt: number
  at?: number
  parentId?: string
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
  /** A subagent's own plan — see ToolItem.parentId. The id carries the owner
      too (`plan@<parentId>`), so a child's plan can never replace the thread's. */
  parentId?: string
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
  /** What that prompt carried, when it carried anything.
      Retry itself is a **text** path by construction (`turn_ended.promptText`),
      and quietly re-attaching bytes to a re-sent string is a second send the
      user did not compose — so this is not what Retry sends. It is what makes
      the row *say so* ("Retry (text only)"), because a plain Retry on a turn
      that had an image produces prose referring to a picture that is no longer
      there, which looks like a bug rather than a rule. It is also what the one
      exception reads: "Retry as file paths", for the failure the whole
      capability story exists around — a model whose catalog claims `image` and
      whose provider refuses it anyway. */
  retryAttachments?: AttachmentRef[]
  /** This client wrote this row; no journal will ever produce it. What makes it
      survive an attach that replaces the transcript — see lib/thread/carry.ts.
      Absent on the error a `turn_ended` carries, which the replay brings back
      on its own and which must therefore NOT be carried, or it shows twice. */
  local?: boolean
  at?: number
  /** Never set today — errors are the thread's — but every item carries the
      field so the row builder can read it without narrowing per kind. */
  parentId?: string
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
  /** A subagent's own compaction (an RFD child session has a context of its
      own to compact) — see ToolItem.parentId. */
  parentId?: string
}

/**
 * A question the harness answered for the user, from the journaled
 * `_daedalus/autonomy_answer` update.
 *
 * The live `permission`/`elicitation` pair is what draws a card and resolves it
 * under the reader's eyes, but neither event is journaled — so on a reload, or
 * for a run nobody watched, this row is the only thing that says the question
 * was ever asked. That is the whole point of it: a routine granted a standing
 * `allow` has to be readable after the fact, in the transcript of the run that
 * used it, next to the tool call it permitted.
 */
export interface AutonomyItem {
  kind: "autonomy"
  /** `autonomy:<toolCallId>` where there is one, else positional — a permission
      names the call it is about, an elicitation names nothing. */
  id: string
  /** Which choke point asked. */
  request: "permission" | "elicitation"
  /** The ACP tool kind the stance was keyed on; absent when the agent omitted
      it, which is the protocol saying nothing. */
  toolKind?: acp.ToolKind
  /** The agent's own title for the call, so the row reads as an act. */
  title?: string
  answer: "allow" | "deny" | "decline" | "cancel"
  /** True when nobody came and the ask-timeout fallback answered — the
      difference between "the run was allowed to do this" and "it gave up
      waiting", which is also what makes a run `blocked`. */
  timedOut: boolean
  at?: number
  /** A subagent's own auto-answer — see ToolItem.parentId. */
  parentId?: string
}

/**
 * Work an agent launched that outlives the turn that launched it, as the
 * adapter's AIR async-task lifecycle reports it (`AsyncTaskSpawned` in the
 * protocol). Today that means one thing: a Claude Code dynamic workflow.
 *
 * **One item for the whole run, not one per agent.** `progress` is the run's
 * live shape as the CLI resends it on every beat — a snapshot, not a log, so
 * it is *replaced* rather than accumulated. The steps a reader sees are
 * derived from it at view time (`nativeWorkflowRows` in transcript-rows),
 * exactly as nesting and tool-run grouping are: the store stays flat and holds
 * only what the socket wrote, and a run that is folded into a `WorkflowGroup`
 * is a way of looking at this item rather than a second copy of it.
 *
 * Kept out of the transcript's own row vocabulary on purpose — nothing renders
 * an `async-task` item directly, and `buildRows` drops the ones it did not
 * turn into a run (see there for the two reasons one would not be).
 */
export interface AsyncTaskItem {
  kind: "async-task"
  /** `async-task:<asyncTaskId>`. */
  id: string
  taskId: string
  /** The workflow's `meta.name` — the run's heading. */
  name: string
  taskType: string
  description: string
  state: AsyncTaskState
  summary?: string
  /** The tool call that launched it: the run's place in the transcript, and
      what lets the run row stand where the launch row would have. */
  toolCallId?: string
  /** The run's live shape, or empty when the adapter carries no
      `workflowProgress` (an unpatched claude-agent-acp — see `pnpm patch:acp`).
      Empty is why a run can exist here and still draw nothing. */
  progress: WorkflowProgressEntry[]
  /** The run's own totals, which the runtime reports whether or not the
      per-agent array comes through. */
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  startedAt: number
  at?: number
  parentId?: string
}

export type ThreadItem =
  | TextItem
  | ToolItem
  | PlanItem
  | ErrorItem
  | CompactionItem
  | SubagentItem
  | AutonomyItem
  | AsyncTaskItem

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
  /**
   * What this device's connection to the thread is doing — see
   * `lib/thread/phase.ts` for the vocabulary and for what it replaces.
   *
   * Written by exactly one function (`ThreadConnection.setPhase`) through the
   * one `thread-phase` action. That is the point: the four-value `status` it
   * replaces had two writers racing for it, which is how a thread in the
   * reconnect ladder came to read `closed` — composer locked, dead-thread
   * banner up — for the whole of a recovery that was going fine.
   */
  phase: ConnPhase
  turnActive: boolean
  /** The turn is held at a step boundary (`paused` event / `caught_up`).
      Independent of `turnActive`: a paused session with no turn open holds
      its next prompt at its first step, and the toggle has to say so. */
  paused: boolean
  /** Why it is held. `"user"` is the toggle. `"error"` is a turn that **failed
      and did not end** — a rate limit, a spent quota, a key that stopped
      working — waiting at its step boundary with every tool call it already
      made intact, for a model change and a Continue. So it is drawn as an open
      turn in a stopped state, never as an `ErrorRow`: nothing failed for good,
      and re-sending the prompt would be the wrong offer. */
  pausedReason: "user" | "error" | null
  /** The failure an `"error"` hold is waiting on, in the same shape a failed
      turn carries — so the held card folds its detail through `describeError`
      exactly as `ErrorRow` does. */
  pausedError: WireError | null
  /** Whether the runtime takes pause at all (`session_config.canPause`) —
      the harness's own agent; every other runtime has only Stop. */
  canPause: boolean
  permission: PendingPermission | null
  elicitation: PendingElicitation | null
  /** Messages waiting for the running turn to end, in order. The server's
      list, whole — every change arrives as the `queue` event, this device's
      own included (the ids are minted there). */
  queue: QueuedMessage[]
  /** Permission-mode state (e.g. default / acceptEdits / plan) from the agent. */
  modes: acp.SessionModeState | null
  /** Agent config options (model, thinking level, …). */
  configOptions: acp.SessionConfigOption[]
  /** What the *runtime* can carry in a prompt, from the `initialize`
      handshake — the agent's half of the attachment decision (`resolveDelivery`
      in @daedalus/delivery). Null until a session has said, which is the
      ordinary state of a draft: the composer falls back to what the option
      probe learned for the (profile, agent) pair. */
  promptCapabilities: acp.PromptCapabilities | null
  /** Slash commands the agent advertises (available_commands_update). */
  availableCommands: acp.AvailableCommand[]
  /** Cumulative token usage from the last completed turn. */
  usage: acp.Usage | null
  /** What each turn cost on its own, keyed by `turnId` — the same `turn_ended`
      the running total above is folded from, kept unsummed so a turn can say
      what it spent where it sits. Keyed rather than stamped onto the user item
      because the item exists before the turn has an id (the optimistic send
      tags it later, and a replay builds it from `turn_started`) and the usage
      arrives after everything else in the turn. Journaled, so it replays. */
  turnUsage: Record<string, acp.Usage>
  /** Server-measured wall clock per turn, ms, keyed by `turnId` — the same
      `turn_ended` the usage above is folded from. Kept beside it rather than
      inside it because `acp.Usage` is the SDK's shape and gains nothing by
      carrying harness timing. Journaled via the event, so it replays. */
  turnDuration: Record<string, number>
  /** Context window occupancy from usage_update. */
  context: acp.UsageUpdate | null
  /** What the model request that produced a step cost, keyed by item id — the
      per-step half of `turnUsage`, and derived rather than reported: see
      `markStepUsage`. Journaled like everything it is built from, so it
      replays. The whole reading is kept rather than just its figure: the
      step's own popover draws the window and the cost beside it, and what is
      dropped here cannot be recovered downstream. */
  stepUsage: Record<string, acp.UsageUpdate>
  /** The item the last `usage_update` was filed against — the cursor
      `markStepUsage` reads to tell one model request from the next. */
  usageMark: string | null
  /** Time to first update of the last turn, ms. */
  ttftMs: number | null
  /** What each turn did to the project's worktree, keyed by turn id — git's
      answer, not the transcript's (server turn-changes.ts). The socket's
      `turn_changes` nudges land here and `GET /api/sessions/:id/changes`
      seeds the lot on open; a thread whose project is not a repository has
      rows that say `unavailable`. */
  turnChanges: Record<string, TurnChanges>
  /** What is left of the subscription this thread's (profile, agent) pair
      spends — see lib/quota.ts. Null until a turn settles or the composer's
      stats popover asks for one: it is not part of the transcript, so nothing
      replays it and an archived thread simply has none. */
  quota: QuotaSnapshot | null
  /** No agent process behind this thread: what is on screen was served from the
      server's journal. The transcript is real and complete, but nothing can be
      sent until the thread is revived — which `actions.send` does on its own. */
  archived: boolean
  /** Steps (turns) older than the transcript, still on the server. > 0 only
      for a thread long enough to have been windowed; `actions.loadEarlier`
      fetches the next page of whole turns and re-folds. */
  earlier: number
  /** A `load_earlier` is in flight — the button says so and does not stack. */
  loadingEarlier: boolean
  /** The thread's whole table of contents from the journal — one entry per
      turn, oldest first, including the ones still withheld behind `earlier`.
      Set from `attached` (see `thread-turns`), so the turn rail draws every
      tick without paging history in. A resume carries none and leaves this
      alone; the reset on a fresh attach takes it back to empty first. */
  turns: TurnTick[]
}

export interface State {
  sessions: SessionMeta[]
  // Which thread is open and which screen is showing live in the URL — see lib/router.
  threads: Record<string, ThreadState>
}

export const emptyThread: ThreadState = {
  items: [],
  phase: IDLE_PHASE,
  turnActive: false,
  paused: false,
  pausedReason: null,
  pausedError: null,
  canPause: false,
  permission: null,
  elicitation: null,
  queue: [],
  modes: null,
  configOptions: [],
  promptCapabilities: null,
  availableCommands: [],
  usage: null,
  turnUsage: {},
  turnDuration: {},
  context: null,
  stepUsage: {},
  usageMark: null,
  ttftMs: null,
  turnChanges: {},
  quota: null,
  archived: false,
  earlier: 0,
  loadingEarlier: false,
  turns: [],
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
 * A thread that is *opening* outranks `draft`, and that ordering is the whole
 * point of the first message: the connection moves to `starting` before the
 * create POSTs, so the wash goes and the composer docks the instant the message
 * is sent rather than two seconds later when the agent has finished spawning and
 * the first item lands. The transcript is not empty at that moment in any sense
 * the user cares about — the send happened — and leaving the hero up through the
 * spawn read as the message having gone nowhere.
 */
export function threadIsEmpty(thread: ThreadState, draft?: boolean): boolean {
  if (thread.items.length > 0) return false
  // Already on its way to a transcript, draft or not: that reads as loading.
  if (isOpening(thread.phase)) return false
  if (draft) return true
  // Not yet started at all.
  return thread.phase.kind !== "idle"
}

// ---- update application (shared by live updates and journal rebuild) ----

/* Synthetic ids used to be positional (`${kind}-${items.length}`), which
   collides the moment an item is *removed* (`drop-user-message`,
   `dismiss-error`): the next mint reuses a length already spent, so two rows
   share a React key and a dismiss deletes both. A module counter never
   repeats. Replay determinism is unaffected: a replay or re-fold rebuilds
   `items` wholesale in one commit, and nothing matches a synthetic id across
   runs — tool calls keep the agent's own toolCallId, plans and compactions
   carry their protocol ids, and notices dedupe by text. */
let itemSeq = 0
const mintItemId = (kind: string): string => `${kind}-${++itemSeq}`

function appendText(
  items: ThreadItem[],
  kind: TextItem["kind"],
  text: string,
  at?: number,
  parentId?: string
): ThreadItem[] {
  const last = items[items.length - 1]
  /* Same kind AND same owner: a subagent's prose and the parent's resuming
     after it are two runs, not one. Without the second test the parent's next
     sentence was glued onto the child's last one — inside the child's rail. */
  if (last && last.kind === kind && last.parentId === parentId) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }]
  }
  return [...items, { kind, id: mintItemId(kind), text, at, parentId }]
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

/** Past this an inline image from a replay is described rather than held. */
const MAX_INLINE_HISTORY_IMAGE_BYTES = 256 * 1024

function pushHistoryImage(
  items: ThreadItem[],
  content: { data: string; mimeType: string },
  at?: number
): ThreadItem[] {
  // base64 is 4/3, near enough for a threshold.
  const size = Math.floor((content.data.length * 3) / 4)
  const oversized = size > MAX_INLINE_HISTORY_IMAGE_BYTES
  const ref = {
    // Not a harness id — nothing will ever fetch it. It exists so the chip has
    // a React key and so the shape matches every other attachment.
    id: `history:${items.length}:${size}`,
    name: oversized ? "large image (from history)" : "image",
    mimeType: content.mimeType,
    size,
    ...(oversized ? { oversized: true } : { inlineData: `data:${content.mimeType};base64,${content.data}` }),
  }
  /* Onto the user bubble this chunk belongs to, when one is already open: a
     runtime sends the prose and the picture as two chunks of one message. */
  const last = items[items.length - 1]
  if (last && last.kind === "user" && !last.parentId) {
    return [...items.slice(0, -1), { ...last, attachments: [...(last.attachments ?? []), ref] }]
  }
  return [...items, { kind: "user", id: mintItemId("user"), text: "", at, attachments: [ref] }]
}

export function applySessionUpdate(
  items: ThreadItem[],
  update: SessionUpdate,
  allowUserChunks = false,
  sessionId?: string
): ThreadItem[] {
  /* `allowUserChunks` is set only by the replay path, so it doubles as "this is
     history": replayed items get no timestamp rather than the reload's. */
  const at = allowUserChunks ? undefined : Date.now()
  /* Whose item this is. The vendor `_meta` naming a parent tool call (Claude
     Code's Task, or the child session OpenCode projects) wins even over an
     update that arrived on a subagent's session (the RFD: `sessionId` names
     the child): a workflow step's own Task tree arrives mirrored WITH the
     step's session id AND the Task attribution, and filing it under the step
     flattened the tree Claude Code's native transcript nests. The tool row the
     meta names travels on the same mirrored stream, so the head always exists.
     No meta, but a session — the child's item. Neither — the thread's own. */
  const owner =
    parentToolIdOf(metaOf(update)) ?? (sessionId ? subagentItemId(sessionId) : undefined)
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text") return items
      const kind = update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought"
      return appendText(items, kind, update.content.text, at, owner)
    }
    case "user_message_chunk": {
      /* An image the agent is replaying back at us. It reaches here only on a
         `session/load` (a live prompt's own attachments are drawn from
         `turn_started`'s refs), and dropping it — which is what this line did
         for every non-text block — is why a replayed prompt that carried a
         picture used to show the prose and silently lose it.

         There is no harness row behind this one: it is the agent's copy, so it
         becomes an attachment with an inline data URL instead of an id. And it
         is capped, because those updates are journaled and a history with
         twenty images would otherwise write twenty base64 blobs into
         `session_events`: over the cap the chip says "large image (from
         history)" rather than holding megabytes in the store. The journal cost
         is then bounded by the agent's own history rather than by anything the
         composer does. */
      if (update.content.type === "image" && !owner) {
        return pushHistoryImage(items, update.content, at)
      }
      if (update.content.type !== "text") return items
      /* A subagent's "user" turns are its tool results and the brief it was
         handed, echoed by the runtime for the model's benefit. Nobody typed
         them and the brief is already on the parent, so they are dropped
         rather than counted as prompts by everything that counts prompts. */
      if (owner) return items
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
        return [...items, { kind: "notice", id: mintItemId("notice"), text, at }]
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
        return [...items, { kind: "notice", id: mintItemId("notice"), text: synthetic[1], at }]
      }
      return appendText(items, "user", update.content.text, at)
    }
    case "tool_call": {
      const item: ToolItem = {
        kind: "tool",
        id: update.toolCallId,
        title: update.title,
        name: toolNameOf(update) ?? undefined,
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
      const existing = items.find((i): i is ToolItem => i.kind === "tool" && i.id === item.id)
      /* A re-announced call is replaced wholesale, bar one thing it may have
         learned since: who it belongs to. Claude Code's attribution is
         best-effort — a child's `tool_call` can go out before the runtime
         knows which Task it serves and be told on a later update — so an
         owner once learned is never forgotten. */
      item.parentId = owner ?? existing?.parentId
      item.name = item.name ?? existing?.name
      if (existing) {
        return items.map((i) => (i.kind === "tool" && i.id === item.id ? item : i))
      }
      return [...items, item]
    }
    case "tool_call_update":
      return items.map((i) => {
        if (i.kind !== "tool" || i.id !== update.toolCallId) return i
        const meta = mergeMeta(i.meta, metaOf(update))
        return {
          ...i,
          title: update.title ?? i.title,
          status: update.status ?? i.status,
          toolKind: update.kind ?? i.toolKind,
          rawInput: update.rawInput ?? i.rawInput,
          rawOutput: update.rawOutput ?? i.rawOutput,
          content: update.content ?? i.content,
          locations: update.locations ?? i.locations,
          meta,
          terminal: applyTerminalMeta(i.terminal, metaOf(update)),
          // From the MERGED meta: a later update that repeats `toolName`
          // without the parent must not lose an attribution already learned —
          // and the meta's tool parent outranks the session owner here for the
          // same reason it does in `owner` above.
          parentId: parentToolIdOf(meta) ?? owner ?? i.parentId,
        }
      })
    case "plan": {
      // The legacy channel: one plan per session, replaced wholesale each
      // time — per owner: a subagent's plan is its own, keyed apart so it can
      // never replace the thread's.
      const id = owner ? `plan@${owner}` : "plan"
      const plan: PlanItem = { kind: "plan", id, entries: update.entries, parentId: owner }
      return items.some((i) => i.kind === "plan" && i.id === id)
        ? items.map((i) => (i.kind === "plan" && i.id === id ? plan : i))
        : [...items, plan]
    }
    case "plan_update": {
      /* The newer channel. Each variant replaces that plan entirely — the spec
         is explicit that an update carries the whole thing, so there is nothing
         to merge. An unknown variant is dropped rather than rendered as an
         empty plan. */
      const content = update.plan
      const base = {
        kind: "plan" as const,
        id: owner ? `plan:${content.planId}@${owner}` : `plan:${content.planId}`,
        entries: [],
        parentId: owner,
      }
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
      const id = owner ? `compaction:${update.compactionId}@${owner}` : `compaction:${update.compactionId}`
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
        parentId: existing?.parentId ?? owner,
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
      const id = owner ? `compaction:${update.compactionId}@${owner}` : `compaction:${update.compactionId}`
      return items.map((i) =>
        i.kind === "compaction" && i.id === id
          ? { ...i, summary: [...i.summary, update.content] }
          : i
      )
    }
    case "plan_removed": {
      // The agent abandoned this plan; leaving it on screen would describe work
      // nobody is doing any more.
      const id = owner ? `plan:${update.planId}@${owner}` : `plan:${update.planId}`
      return items.filter((i) => !(i.kind === "plan" && i.id === id))
    }
    case "subagent_spawned": {
      /* The RFD's announcement. Sent on the parent's session — so `owner` here
         is the parent when the parent is itself a child, and undefined at the
         top — and it precedes every update of the child's, which is what lets
         the reducer file those under an item that already exists. Upsert:
         a `session/load` restates spawns it has already sent. */
      const id = subagentItemId(update.subagentSessionId)
      const existing = items.find((i): i is SubagentItem => i.kind === "subagent" && i.id === id)
      const item: SubagentItem = {
        kind: "subagent",
        id,
        sessionId: update.subagentSessionId,
        name: update.name,
        task: update.task,
        capabilities: update.capabilities ?? {},
        workflow: workflowInfoOf(metaOf(update)) ?? existing?.workflow,
        usage: existing?.usage,
        context: existing?.context,
        state: existing?.state ?? "running",
        startedAt: existing?.startedAt ?? Date.now(),
        at: existing?.at ?? at,
        parentId: owner ?? existing?.parentId,
      }
      return existing
        ? items.map((i) => (i.kind === "subagent" && i.id === id ? item : i))
        : [...items, item]
    }
    case "subagent_state_update": {
      const id = subagentItemId(update.subagentSessionId)
      return items.map((i) => (i.kind === "subagent" && i.id === id ? { ...i, state: update.state } : i))
    }
    /* ── Async background tasks ──
       A dynamic workflow, announced by the adapter's AIR lifecycle. Only a
       workflow is kept: a backgrounded shell command is already drawn as its
       own tool call, and a monitor is not work anyone asked for. Upsert,
       because `session/load` restates a spawn it has already sent.

       `showInTranscript` is deliberately NOT consulted, and it took a live run
       to learn why. The SDK sends `background_tasks_changed` — a level with no
       transcript policy on it — before `task_started`, which the adapter's own
       note calls unspecified but "in practice the level precedes them". Seeing
       the level first, the adapter marks the task a panel-only recovery and
       pins `showInTranscript` to false *forever*, because a late
       `skip_transcript: true` must not be able to retract a card it had
       already drawn. Sound for a task whose kind it does not yet know — and
       always wrong for this one: `local_workflow` is the Workflow tool and
       nothing else, so it is user work by definition, never the housekeeping
       (monitors, update watchers) that the flag exists to hide. Gating on it
       meant every native run was dropped here in silence. */
    case "async_task_spawned": {
      if (update.taskType !== "workflow") return items
      const id = `async-task:${update.asyncTaskId}`
      const existing = items.find((i): i is AsyncTaskItem => i.kind === "async-task" && i.id === id)
      const item: AsyncTaskItem = {
        kind: "async-task",
        id,
        taskId: update.asyncTaskId,
        name: update.name,
        taskType: update.taskType,
        description: update.description,
        state: existing?.state ?? "running",
        summary: existing?.summary,
        toolCallId: update.toolCallId ?? existing?.toolCallId,
        progress: existing?.progress ?? [],
        usage: existing?.usage,
        startedAt: existing?.startedAt ?? Date.now(),
        at: existing?.at ?? at,
        parentId: owner ?? existing?.parentId,
      }
      return existing
        ? items.map((i) => (i.kind === "async-task" && i.id === id ? item : i))
        : [...items, item]
    }
    /* A beat. `workflowProgress` is the run's whole shape restated, so it
       REPLACES what we held rather than appending to it — the runtime rewrites
       an agent's entry in place as it works, and accumulating would leave every
       agent on screen once per beat. A beat that carries none (an unpatched
       adapter) still moves the run's totals, so the array is only replaced when
       one actually arrived.

       A beat for a task we never took the spawn of is a stray — dropped rather
       than made into a headless run, the same rule `compaction_summary_chunk`
       follows. */
    case "async_task_progress": {
      const id = `async-task:${update.asyncTaskId}`
      return items.map((i) =>
        i.kind === "async-task" && i.id === id
          ? {
              ...i,
              description: update.description ?? i.description,
              summary: update.summary ?? i.summary,
              usage: update.usage ?? i.usage,
              toolCallId: i.toolCallId ?? update.toolCallId,
              progress: update.workflowProgress ?? i.progress,
            }
          : i
      )
    }
    case "async_task_state_update": {
      const id = `async-task:${update.asyncTaskId}`
      return items.map((i) =>
        i.kind === "async-task" && i.id === id
          ? {
              ...i,
              state: update.state,
              summary: update.summary ?? i.summary,
              /* The adapter mentions the launching call whenever it happens to
                 have one, which for some runs is only here, on the last frame. */
              toolCallId: i.toolCallId ?? update.toolCallId,
            }
          : i
      )
    }
    /* A workflow run held or released. The run has no item — it is folded at
       view time from its steps — so the hold is stamped onto every step that
       carries the run's id, and the card reads it off any of them. Journaled,
       so a replayed run stands where it stood. */
    case "_daedalus/workflow_state": {
      return items.map((i) =>
        i.kind === "subagent" && i.workflow?.runId === update.runId
          ? { ...i, workflow: { ...i.workflow, paused: update.paused } }
          : i
      )
    }
    /* What the step's turn cost, lifted off the child's own `turn_ended` by the
       workflow runner (see SubagentUsage in the protocol). One per settled
       turn, so it accumulates — `addUsage` is the same fold the thread's own
       total uses, and each event is journaled exactly once, so a replay cannot
       count a turn twice. */
    case "_daedalus/subagent_usage": {
      const id = subagentItemId(update.subagentSessionId)
      return items.map((i) =>
        i.kind === "subagent" && i.id === id ? { ...i, usage: addUsage(i.usage ?? null, update.usage) } : i
      )
    }
    /* The durable half of an auto-answered permission or elicitation. Appended
       rather than folded onto the tool row it names: the tool call may not have
       arrived yet (an agent asks before it acts) and, for an elicitation, there
       is no tool row at all. Its place in the transcript is where the question
       was answered, which is what a reader is looking for. */
    case "_daedalus/autonomy_answer": {
      const item: AutonomyItem = {
        kind: "autonomy",
        id: `autonomy:${update.toolCallId ?? `${update.kind}:${items.length}`}`,
        request: update.kind,
        ...(update.toolKind ? { toolKind: update.toolKind } : {}),
        ...(update.title ? { title: update.title } : {}),
        answer: update.answer.answer,
        timedOut: update.answer.timedOut,
        at: Date.now(),
        ...(owner ? { parentId: owner } : {}),
      }
      return [...items, item]
    }
    /* A child's context occupancy. Session-level for the thread — and dropped
       there — but a step IS a session, so on this side of the fence it is the
       one thing that says how full the worker's own window got. */
    case "usage_update": {
      if (!owner) return items
      return items.map((i) => (i.kind === "subagent" && i.id === owner ? { ...i, context: update } : i))
    }
    default:
      return items
  }
}

/**
 * What one step cost, out of the only mid-turn reading there is.
 *
 * ACP reports tokens once, on `turn_ended` — that is the turn's bill and it is
 * what the footer prints. Nothing in the protocol says what a *step* inside it
 * cost. But `usage_update` is not the running context total it sounds like:
 * both runtimes that send one fill `used` with the **last model request's** own
 * token count (claude-agent-acp from the assistant message's `message_start` /
 * `message_delta` usage, codex-acp from `tokenUsage.last`), which is exactly a
 * step's bill — the context that request carried plus what it wrote.
 *
 * So the reading is real and only its *owner* has to be inferred, which is what
 * the mark is for. A request reports twice: once when it opens, before it has
 * written anything, and once when it closes, by which time the steps it decided
 * on are in the transcript. The tail item is therefore unchanged for the first
 * and has moved for the second — so a reading at a tail that has not moved is
 * the next request opening and is dropped, and one at a tail that has is the
 * request closing, filed against the last thing it produced. One figure per
 * model request, on the step it ended with.
 *
 * Two deliberate limits. A tail is the last **top-level** item: a subagent's
 * own requests are not metered here (claude-agent-acp reports only the main
 * loop), so a reading that arrives while a rail is filling belongs to the Task
 * call that owns the rail, not to whatever row is deepest. And a runtime that
 * refines its reading a second time at the same tail is not read twice — the
 * later, larger figure is dropped rather than risk reading the next request's
 * opening as a refinement. The figure is drawn as approximate for both reasons.
 */
function markStepUsage(
  thread: ThreadState,
  update: acp.UsageUpdate
): Pick<ThreadState, "stepUsage" | "usageMark"> {
  const kept = { stepUsage: thread.stepUsage, usageMark: thread.usageMark }
  if (!(update.used > 0)) return kept
  let tail: ThreadItem | undefined
  for (let i = thread.items.length - 1; i >= 0; i--) {
    if (!thread.items[i].parentId) {
      tail = thread.items[i]
      break
    }
  }
  if (!tail || thread.usageMark === tail.id) return kept
  return { stepUsage: { ...thread.stepUsage, [tail.id]: update }, usageMark: tail.id }
}

/** Session-level (non-transcript) updates applied to ThreadState. */
function applyMetaUpdate(
  thread: ThreadState,
  update: SessionUpdate,
  allowUserChunks = false,
  sessionId?: string
): ThreadState {
  /* A subagent's session-level state is its own — its mode, its options, its
     context window. None of it describes the thread, so none of it reaches
     ThreadState; only its transcript does. */
  const sessionLevel =
    update.sessionUpdate === "current_mode_update" ||
    update.sessionUpdate === "config_option_update" ||
    update.sessionUpdate === "available_commands_update" ||
    update.sessionUpdate === "session_info_update"
  if (sessionId && sessionLevel) return thread
  /* The one session-level update a child still has somewhere to go: its
     context occupancy is not the thread's, but it IS the step's, and the step
     is an item. Everything else about a child's session dies here. */
  if (sessionId && update.sessionUpdate === "usage_update")
    return { ...thread, items: applySessionUpdate(thread.items, update, allowUserChunks, sessionId) }
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
      return { ...thread, context: update, ...markStepUsage(thread, update) }
    default:
      return { ...thread, items: applySessionUpdate(thread.items, update, allowUserChunks, sessionId) }
  }
}

/** A turn can end with tool calls still in flight (cancel, agent crash) — no
    further update will ever arrive for them, so settle them at turn end instead
    of leaving a spinner running forever. A compaction is the same bargain: its
    terminal update is owed by the same process that just stopped talking.
 *
 *  Which is exactly why **losing the socket is not a reason to run this**: the
 *  turn is the server's and it keeps going with nobody attached, so a phone
 *  backgrounded mid-run came back to a transcript full of failed tools and
 *  `disconnected` workflow steps that a reconnect immediately contradicted —
 *  the run had been fine the whole time. Callers that expect to come back and
 *  be corrected (a close that will reconnect, a parked reconnect ladder) pass
 *  `settle: false`; only an ending the *agent* reported settles. */
function settleTools(items: ThreadItem[]): ThreadItem[] {
  return items.map((item) => {
    if (item.kind === "tool" && (item.status === "pending" || item.status === "in_progress")) {
      return { ...item, status: "failed" }
    }
    if (item.kind === "compaction" && item.status === "in_progress") {
      return { ...item, status: "failed" as acp.CompactionStatus }
    }
    /* The RFD's own word for a child whose outcome the agent can no longer
       report: not failed, not cancelled — unknown. The turn ending is exactly
       that for any child still marked running. */
    if (item.kind === "subagent" && item.state === "running") {
      return { ...item, state: "disconnected" }
    }
    return item
  })
}

export function pushUserMessage(
  items: ThreadItem[],
  text: string,
  at?: number,
  turnId?: string,
  local?: boolean,
  attachments?: TextItem["attachments"]
): ThreadItem[] {
  return [
    ...items,
    {
      kind: "user",
      id: mintItemId("user"),
      text,
      at,
      turnId,
      local,
      ...(attachments?.length ? { attachments } : {}),
    },
  ]
}

/** null only when neither side reported the field — keeps optional stats hidden. */
const addOptional = (a: number | null | undefined, b: number | null | undefined) =>
  a == null && b == null ? null : (a ?? 0) + (b ?? 0)

/**
 * ACP's Usage doc-comments claim session totals, but agents send per-turn
 * numbers (observed: totalTokens falling between turns), so the running total
 * is ours to keep — and an average cache rate needs it.
 *
 * Both callers fold a `turn_ended`, and nothing else may: the thread's own, and
 * a workflow step's, which the runner lifts off the child's settled turn and
 * says again as `_daedalus/subagent_usage` (see the protocol). Each of those is
 * journaled exactly once per turn, live and on replay alike, so neither total
 * can count a turn twice.
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
  | { type: "bootstrap"; sessions: SessionMeta[] }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "draft-session"; session: SessionMeta }
  | { type: "drop-draft-session"; id: string }
  | {
      type: "configure-draft"
      id: string
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
    }
  | { type: "draft-config-option"; id: string; configId: string; value: string | boolean }
  /** A live profile/model/effort change, from this device or another. Patches
      the thread's row in place: the change did not restart anything, so there
      is no reload to carry it and no draft semantics to respect. */
  | {
      type: "spawn-config"
      id: string
      profileId: string
      model: string
      effort: string
      personaId?: string
      suggestFollowups?: boolean
    }
  | { type: "thread-reset"; id: string; thread: ThreadState }
  | { type: "turn-active"; id: string; active: boolean; settle?: boolean }
  | { type: "paused"; id: string; paused: boolean; reason?: "user" | "error"; error?: WireError }
  /** How the turn that just ended went, onto the *session* row rather than the
      thread: it is what a list draws about a thread nothing is looking at, and
      the server records the same verdict on its own row. `error` is the
      failure's headline, or null for a turn that ended cleanly or was
      cancelled — both of which clear whatever the turn before left. */
  | { type: "turn-verdict"; id: string; error: string | null }
  /** Windowing/archive bookkeeping, all of it absolute — set from `attached`
      and from the end of a re-fold, never accumulated. */
  | {
      type: "thread-window"
      id: string
      archived?: boolean
      earlier?: number
      loadingEarlier?: boolean
    }
  /** The journal's whole turn list, from `attached` — see `ThreadState.turns`.
      Absolute, never accumulated: a fresh attach replaces, a resume sends
      nothing and leaves it alone. */
  | { type: "thread-turns"; id: string; turns: TurnTick[] }
  /** The connection moved. One writer, one action — see `ThreadState.phase`. */
  | { type: "thread-phase"; id: string; phase: ConnPhase }
  /** Put back the rows a replaced transcript took with it — this device's own
      unacknowledged message and its own error rows. See lib/thread/carry.ts. */
  | { type: "thread-carry"; id: string; items: ThreadItem[] }
  /** `sessionId` names a subagent's session when the update is a child's —
      see the `update` event in protocol.ts. Absent = the thread's own. */
  | { type: "update"; id: string; update: SessionUpdate; allowUserChunks?: boolean; sessionId?: string }
  /** `local` = this device typed it (see `TextItem.local`); the replay's own
      user bubbles and the ones a `turn_started` mints are not. */
  | {
      type: "user-message"
      id: string
      text: string
      turnId?: string
      local?: boolean
      attachments?: TextItem["attachments"]
    }
  | { type: "tag-user-turn"; id: string; turnId: string }
  /** Take back an optimistic user bubble: the server queued the words instead
      of sending them, and the queue row is where they show now. */
  | { type: "drop-user-message"; id: string }
  /** The whole queue, absolute. */
  | { type: "queue"; id: string; items: QueuedMessage[] }
  | { type: "notice"; id: string; text: string }
  | {
      type: "error"
      id: string
      title: string
      reason?: string
      detail?: string
      retryText?: string
      retryAttachments?: AttachmentRef[]
      settle?: boolean
      /** Written by this client rather than replayed from a journal — see
          `ErrorItem.local`. */
      local?: boolean
    }
  | { type: "dismiss-error"; id: string; itemId: string }
  | { type: "permission"; id: string; permission: PendingPermission | null }
  | { type: "elicitation"; id: string; elicitation: PendingElicitation | null }
  | { type: "session-title"; id: string; title: string }
  | { type: "rename-session"; id: string; title: string }
  /** Absolute state, with one hole: an event may carry modes and leave the
      options out, which means "unchanged" and not "none". The reducer is where
      that is resolved, because during a batched replay the caller cannot read
      the current value — it has not been committed yet. */
  | {
      type: "session-config"
      id: string
      modes: acp.SessionModeState | null
      configOptions?: acp.SessionConfigOption[]
      /** Same hole, same rule: absent means unchanged. */
      promptCapabilities?: acp.PromptCapabilities
      canPause?: boolean
    }
  | { type: "mode"; id: string; modeId: string }
  | { type: "config-options"; id: string; configOptions: acp.SessionConfigOption[] }
  | { type: "usage"; id: string; usage: acp.Usage; turnId?: string; durationMs?: number }
  | { type: "ttft"; id: string; ms: number }
  | { type: "turn-changes"; id: string; turn: TurnChanges }
  | { type: "turn-changes-all"; id: string; turns: TurnChanges[] }
  | { type: "quota"; id: string; quota: QuotaSnapshot }
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
      return { ...state, sessions: action.sessions }
    case "sessions": {
      /* The server's list is authoritative for every thread it knows about —
         but a draft is precisely one it has not been told about yet, so this
         merges rather than replaces. Replacing would make a new thread vanish
         under the user the moment any refresh landed. A draft whose id the
         server now reports has just been created: the server's row wins and the
         draft marker goes with it. */
      const known = new Set(action.sessions.map((session) => session.id))
      const drafts = state.sessions.filter((session) => session.draft && !known.has(session.id))
      /* Keep the object a row already had when the server's account of it has
         not moved (`sameRow`). Every consumer of a row is a subscription, and
         the most consequential of them is the chat panel, whose reaction to a
         new row object is to *open the thread* — so replacing the list wholesale
         turned every list refresh into an open, and an open landing inside
         another open is two peers on one session. Identity is the cheap half of
         fixing that; the other half is that opening stops keying on the row at
         all (see lib/thread/). */
      const previous = new Map(state.sessions.map((session) => [session.id, session]))
      const sessions = action.sessions.map((next) => {
        const old = previous.get(next.id)
        return old && sameRow(old, next) ? old : next
      })
      const merged = [...drafts, ...sessions]
      /* And when nothing moved at all, hand back the same *state* object, so
         the store's subscribers are not woken to be told so. Conservative on
         purpose: a false negative here costs one array allocation and the
         renders this used to cost unconditionally. */
      const unchanged =
        merged.length === state.sessions.length &&
        merged.every((session, i) => session === state.sessions[i])
      return unchanged ? state : { ...state, sessions: merged }
    }
    case "spawn-config":
      return {
        ...state,
        sessions: state.sessions.map((session) =>
          session.id === action.id
            ? {
                ...session,
                profileId: action.profileId,
                model: action.model,
                effort: action.effort,
                // Omitted by a server that predates personas — leave whatever
                // the row already carries rather than blanking it.
                ...(action.personaId === undefined ? {} : { personaId: action.personaId }),
                // Omitted by a server that predates the toggle — same bargain.
                ...(action.suggestFollowups === undefined ? {} : { suggestFollowups: action.suggestFollowups }),
              }
            : session
        ),
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
             would replay a config id the new agent has never heard of. The mode
             ids are the agent's own, so they go with the config choices. */
          const rescoped =
            action.next.agentId !== undefined || action.next.profileId !== undefined
          return {
            ...s,
            ...action.next,
            ...(rescoped ? { configChoices: undefined, modeId: undefined } : null),
          }
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
    case "thread-reset":
      return { ...state, threads: { ...state.threads, [action.id]: action.thread } }
    case "thread-window":
      return withThread(state, action.id, {
        ...(action.archived !== undefined ? { archived: action.archived } : {}),
        ...(action.earlier !== undefined ? { earlier: action.earlier } : {}),
        ...(action.loadingEarlier !== undefined ? { loadingEarlier: action.loadingEarlier } : {}),
      })
    case "thread-turns":
      return withThread(state, action.id, { turns: action.turns })
    case "thread-phase":
      return withThread(state, action.id, { phase: action.phase })
    case "thread-carry": {
      const items = thread(state, action.id).items
      /* Appended, and last, which is where they were: an unacknowledged bubble
         is always the newest thing in the thread, and a failure this client
         recorded is newer than everything the journal holds. */
      const missing = unclaimed(action.items, items)
      return missing.length === 0
        ? state
        : withThread(state, action.id, { items: [...items, ...missing] })
    }
    case "turn-active": {
      const next = withThread(state, action.id, {
        turnActive: action.active,
        ...(action.active || action.settle === false
          ? null
          : { items: settleTools(thread(state, action.id).items) }),
      })
      /* A turn is the activity the lists order by, and the server has just
         recorded one — but only for the thread it happened in, and the next
         `refreshSessions` is minutes away. Stamping it here is what moves a
         thread picked up after a week to the top of Recents as it is being
         used, rather than after the next refresh. The server's own value wins
         whenever that list lands.

         Only a turn *starting*: `turn_ended` is replayed, and stamping on it
         would make merely opening an old thread promote it to the top of
         Recents — reading is not activity, which is the same rule the server
         keeps by journaling nothing on attach. */
      if (!action.active) return next
      return {
        ...next,
        sessions: next.sessions.map((s) =>
          /* The turn beginning also clears the last one's failure, exactly as
             the server does on `turn_started`: a thread being worked on again
             must not still be drawn as the one that failed an hour ago. */
          s.id === action.id ? { ...s, lastActivityAt: Date.now(), lastTurnError: null } : s
        ),
      }
    }
    case "turn-verdict":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, lastTurnError: action.error } : s
        ),
      }
    case "update":
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.id]: applyMetaUpdate(
            thread(state, action.id),
            action.update,
            action.allowUserChunks,
            action.sessionId
          ),
        },
      }
    case "user-message":
      return withThread(state, action.id, {
        items: pushUserMessage(
          thread(state, action.id).items,
          action.text,
          Date.now(),
          action.turnId,
          action.local,
          action.attachments
        ),
      })
    case "tag-user-turn": {
      const items = thread(state, action.id).items
      /* The bubble this device drew and is now being told the turn id of —
         `local`, or a load replay's own untagged bubbles would be tagged
         instead, oldest first, leaving the real one untagged forever. */
      const index = items.findIndex((item) => item.kind === "user" && !item.turnId && item.local)
      if (index < 0) return state
      return withThread(state, action.id, {
        items: items.map((item, i) => i === index && item.kind === "user" ? { ...item, turnId: action.turnId } : item),
      })
    }
    case "drop-user-message": {
      const items = thread(state, action.id).items
      // The same untagged bubble `tag-user-turn` would have stamped — the
      // last one, since an optimistic message is always the newest thing.
      let index = -1
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.kind === "user" && !item.turnId && item.local) {
          index = i
          break
        }
      }
      if (index < 0) return state
      return withThread(state, action.id, { items: items.filter((_, i) => i !== index) })
    }
    case "queue":
      return withThread(state, action.id, { queue: action.items })
    case "notice": {
      // An identical rule twice in a row is one interruption, and the
      // transcript should say so once — but distinct consecutive rules stay
      // distinct, so rapid mid-turn mode/model/effort changes each draw a line.
      const items = thread(state, action.id).items
      const last = items[items.length - 1]
      if (last?.kind === "notice" && last.text === action.text) return state
      return withThread(state, action.id, {
        items: [...items, { kind: "notice", id: mintItemId("notice"), text: action.text, at: Date.now() }],
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
          items: [
            ...items.slice(0, -1),
            { ...last, retryText: action.retryText, retryAttachments: action.retryAttachments },
          ],
        })
      }
      const withRow: ThreadItem[] = [
        ...items,
        {
          kind: "error",
          id: mintItemId("error"),
          title: action.title,
          reason: action.reason,
          detail: action.detail,
          retryText: action.retryText,
          retryAttachments: action.retryAttachments,
          local: action.local,
          at: Date.now(),
        },
      ]
      return withThread(state, action.id, {
        // A prompt that died mid-turn leaves tool calls spinning forever — but
        // only settle when the agent is what failed. `settle: false` is a
        // failure of *this device's connection*, which says nothing about the
        // work: see the note on `settleTools`.
        items: action.settle === false ? withRow : settleTools(withRow),
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
    /* The sniff above yields to a name that was chosen; this one is that name,
       so it replaces whatever the title was. */
    case "rename-session":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, title: action.title } : s
        ),
      }
    case "session-config":
      return withThread(state, action.id, {
        modes: action.modes,
        configOptions: action.configOptions ?? thread(state, action.id).configOptions,
        promptCapabilities:
          action.promptCapabilities ?? thread(state, action.id).promptCapabilities,
        canPause: action.canPause ?? thread(state, action.id).canPause,
      })
    case "paused":
      return withThread(state, action.id, {
        paused: action.paused,
        /* Absolute: a release clears the reason with the hold, so a card can
           never outlive the state that drew it. */
        pausedReason: action.paused ? action.reason ?? "user" : null,
        pausedError: action.paused ? action.error ?? null : null,
      })
    case "mode": {
      const t = thread(state, action.id)
      return t.modes
        ? withThread(state, action.id, { modes: { ...t.modes, currentModeId: action.modeId } })
        : state
    }
    case "config-options":
      return withThread(state, action.id, { configOptions: action.configOptions })
    case "usage": {
      const current = thread(state, action.id)
      return withThread(state, action.id, {
        usage: addUsage(current.usage, action.usage),
        /* The same reading, kept twice: summed for the thread's own total and
           filed under its turn for the footer that prints what this answer
           cost. One `turn_ended` per turn, journaled once, so neither can
           double-count on a replay. The duration rides the same event and is
           filed the same way — absent on turns that ended before the server
           measured it. */
        ...(action.turnId ? { turnUsage: { ...current.turnUsage, [action.turnId]: action.usage } } : null),
        ...(action.turnId && action.durationMs !== undefined
          ? { turnDuration: { ...current.turnDuration, [action.turnId]: action.durationMs } }
          : null),
      })
    }
    case "ttft":
      return withThread(state, action.id, { ttftMs: action.ms })
    case "turn-changes": {
      const current = thread(state, action.id)
      return withThread(state, action.id, {
        turnChanges: { ...current.turnChanges, [action.turn.turnId]: action.turn },
      })
    }
    /* The seed on open. Merged over, not replaced: a live nudge that landed
       while the GET was in flight is newer than the list it beat. */
    case "turn-changes-all": {
      const turnChanges = { ...thread(state, action.id).turnChanges }
      for (const turn of action.turns) if (!turnChanges[turn.turnId]?.ended) turnChanges[turn.turnId] = turn
      return withThread(state, action.id, { turnChanges })
    }
    /* Absolute, like the queue: the server sends the whole reading, never a
       delta, so there is nothing to merge. */
    case "quota":
      return withThread(state, action.id, { quota: action.quota })
    default:
      return state
  }
}

export const initialState: State = {
  sessions: [],
  threads: {},
}

// ---- context ----

/**
 * The store is an external store now, not a state context, and **the reducer
 * lives in here** rather than in `App`.
 *
 * Both halves of that are load-bearing, and neither works without the other.
 *
 * *Why not a state context.* A context consumer is re-rendered on every
 * provider commit whatever it went on to read, so `StateContext` could never
 * say "only this thread" — and the dock keeps every opened transcript
 * mounted, so one streamed token in a background thread re-rendered every
 * open transcript and re-ran each one's derivations. `useSyncExternalStore`
 * moves the comparison to the value the consumer actually named:
 * `useStoreSelect` publishes a snapshot and React's own `Object.is` decides
 * whether that consumer renders. The reducer already keeps the identities
 * that makes true — `withThread` replaces exactly one thread's object, and
 * every case that edits `sessions` maps untouched rows through — so a token
 * in thread A leaves thread B's snapshot referentially equal, and B does not
 * render at all.
 *
 * *Why the reducer moved.* It was `useReducer` in `App`, which meant every
 * dispatch re-rendered `App` and so recreated the element for the entire
 * tree — subscriptions cannot help a subtree React has already decided to
 * re-render. Owning the reducer here makes `children` a prop this component
 * does not touch, so on a dispatch React sees the same element reference and
 * bails out of the subtree; only `DispatchContext` consumers (a stable value,
 * so never) and the selectors that actually changed are woken.
 *
 * The ref is written in a layout effect and never during render: a render
 * pass can be thrown away, and a snapshot published from one would let a
 * subscriber read state that never committed. Layout rather than passive so
 * subscribers render before paint.
 */
export const DispatchContext = React.createContext<React.Dispatch<Action>>(() => {})

export interface StoreHandle {
  getState: () => State
  subscribe: (listener: () => void) => () => void
}

const StoreHandleContext = React.createContext<StoreHandle | null>(null)

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = React.useReducer(reducer, initialState)
  const stateRef = React.useRef(state)
  const listeners = React.useRef(new Set<() => void>())
  const handle = React.useMemo<StoreHandle>(
    () => ({
      getState: () => stateRef.current,
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
    }),
    []
  )
  React.useLayoutEffect(() => {
    stateRef.current = state
    /* Copied before the walk: a listener that unsubscribes as it runs (a
       consumer unmounting on the state it was just told about) would
       otherwise mutate the set being iterated. */
    for (const listener of [...listeners.current]) listener()
  }, [state])
  return (
    <DispatchContext.Provider value={dispatch}>
      <StoreHandleContext.Provider value={handle}>{children}</StoreHandleContext.Provider>
    </DispatchContext.Provider>
  )
}

/** The handle itself, for a consumer that reads state without watching it —
    `useActions` is the one: every read there is out of an event handler, long
    after the render that would have subscribed. */
export function useStoreHandle(): StoreHandle {
  const handle = React.useContext(StoreHandleContext)
  if (!handle) throw new Error("useStoreHandle outside StoreProvider")
  return handle
}

/**
 * Subscribe to one reading of the state. The selector MUST return something
 * the state itself holds (a slice, a thread, a row) — a selector that builds
 * a fresh object returns a new identity per notify and re-renders on every
 * dispatch, which is exactly the wide hook this exists to replace.
 */
export function useStoreSelect<T>(selector: (state: State) => T): T {
  const handle = useStoreHandle()
  const ref = React.useRef(selector)
  ref.current = selector
  const getSnapshot = React.useCallback(() => ref.current(handle.getState()), [handle])
  return React.useSyncExternalStore(handle.subscribe, getSnapshot)
}

/** This thread's state and nothing else: re-renders exactly when the reducer
    replaces this thread's object. The one hook every transcript-path consumer
    should be on — the dock keeps every opened transcript mounted, and this is
    what keeps a streamed token in thread A from re-rendering thread B. */
export function useThread(sessionId: string): ThreadState {
  return useStoreSelect((state) => state.threads[sessionId] ?? emptyThread)
}

/** One session's row. Stable across other sessions' changes: every reducer
    case that edits the list maps `s.id === id ? {…s} : s`, so an untouched
    row keeps its identity and only a full list refresh replaces them all. */
export function useSessionMeta(sessionId: string): SessionMeta | undefined {
  return useStoreSelect((state) => state.sessions.find((s) => s.id === sessionId))
}

/**
 * Which threads are mid-turn, for a list that draws a running mark per row.
 *
 * `threads` is replaced on every streamed token, so a list that reads it to
 * answer one boolean per row re-rendered thousands of times a turn to draw
 * the same marks. The derivation runs on each notify (one pass, no parsing)
 * and the map is *reused by identity* while its contents are unchanged, so
 * the store's own `Object.is` stops the render at the subscription.
 *
 * A missing entry means this client has never connected the thread, which is
 * not the same as a connected thread sitting idle: the caller falls back to
 * the server's `promptActive` for the first and must not for the second.
 */
export function useLiveTurnActive(): Map<string, boolean> {
  const prev = React.useRef<Map<string, boolean>>(new Map())
  return useStoreSelect((state) => {
    const next = new Map<string, boolean>()
    for (const [id, thread] of Object.entries(state.threads)) next.set(id, thread.turnActive)
    let same = next.size === prev.current.size
    if (same) {
      for (const [id, value] of next) {
        if (prev.current.get(id) !== value) {
          same = false
          break
        }
      }
    }
    if (!same) prev.current = next
    return prev.current
  })
}

/** Stable for the life of the reducer, so a consumer that reads only this
    never re-renders on state. */
export function useDispatch(): React.Dispatch<Action> {
  return React.useContext(DispatchContext)
}
