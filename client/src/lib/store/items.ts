import type * as acp from "@daedalus/acp"
import type {
  AsyncTaskState,
  AttachmentRef,
  SubagentState,
  WorkflowProgressEntry,
} from "@daedalus/protocol"
import type { TerminalState, WorkflowStepInfo } from "../tools"

// ---- thread item model ----

export interface TextItem {
  /** `notice` = transcript rule (interrupts): agent-authored, nobody typed it.
      `config` marks a mid-turn mode/model/effort/profile change row (a server
      `config_notice`), so view options can hide it. */
  kind: "user" | "agent" | "thought" | "notice"
  id: string
  text: string
  /** Set on `notice` rows that announce a setting change. */
  config?: boolean
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
  /** Epoch ms the run this item stands for stopped being written — the
      journal's stamp on the run's LAST chunk, which only the read that merged
      the run can know (see `endAt` on the protocol's `update`). Replay only,
      and only ever beside `at`: together they are a run's measured length, so
      a thought read back from history says "Thought for 12s" instead of having
      no end to subtract its start from. Live items have neither — the client
      times those off its own clock. */
  endedAt?: number
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
  /** This device's optimistic user bubble is awaiting server acceptance. */
  sending?: boolean
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
  /** Epoch ms the call reached a terminal status — the journal's stamp on the
      update that settled it (replay) or this device's clock (live). With
      `startedAt` it is the call's measured length, which is what a settled row
      has to print from: the live counter dies with the stream that fed it, and
      a reloaded transcript had no figure to fall back on. Absent on a call
      still open, and on one rebuilt from a `session/load` replay, whose stamps
      are the reload's and not the call's. */
  endedAt?: number
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
  /** The model the child runs on and the helper role that named it, when the
      runtime says (`_meta.daedalus` on the spawn — ACP's names neither). */
  model?: string
  role?: string
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
  /** Wall time this child spent running, summed over every wake — a child
      woken by a follow-up does not count the idle gap between its turns.
      Absent until its first turn settles. */
  durationMs?: number
  /** When the current run began: the spawn's stamp, or the wake's. */
  runningSince?: number
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
  /** Absent = an error. The agent's own reports come in softer tones too: an
      AIR `sessionFailure` of severity `warning`, and the ACP `notice` update
      (`warning`/`info`). Same row, same Copy — only the card's tone moves. */
  severity?: "warning" | "info"
  /** A status, not a record: an AIR warning that says what the agent is doing
      right now ("Reconnecting to Claude, attempt 1 of 10."). Drawn once, in the
      working line, for as long as it is the newest thing in the thread — never
      as a transcript row, which would be a permanent line about a passing
      condition. */
  transient?: boolean
  /** The create was refused because the agent's binary is missing — a setup
      step, drawn with the install line and a door to Settings › Agents. */
  notInstalled?: { install?: string }
  /** The agent's process ended under the turn this row closes: Continue is
      offered on it while it is the newest thing in the thread. */
  stopped?: boolean
  /** An AIR `sessionFailure`'s revision, on a row keyed `failure:<id>`: the
      agent restates a failure under the same id with a higher revision, and
      only a higher one may replace what is drawn. */
  revision?: number
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

/**
 * A `!` line the user ran against the thread's project, from the journaled
 * `_daedalus/shell` update.
 *
 * Not a prompt and not a tool call: nothing was sent to the agent and no turn
 * runs. It is a row the harness wrote into the thread's own conversation — the
 * command and what it printed — which is why it comes back on a reload (it is
 * journaled like any update) and why it reads as something that happened in the
 * thread rather than as a message anyone answered.
 */
export interface ShellItem {
  kind: "shell"
  /** `shell:<shellId>` — the id the server journals under, so the running row
      the composer drew and the updates that settle it are the same item. */
  id: string
  /** The line as it ran — a saved helper's own command when the line named one. */
  command: string
  /** `running` until the line settles. Not a turn: the thread's own
      `turnActive` never moves for this, so the row has to say its own state. */
  status: "running" | "done"
  /** stdout then stderr, joined as a terminal would have shown them. */
  output: string
  /** The exit code, or null when the process could not be started at all. */
  exitCode: number | null
  /** The shell was killed at the timeout; `output` is what it printed first. */
  timedOut: boolean
  at?: number
  /** Never set today — a `!` run is the thread's, not a step's — but every item
      carries the field so the row builder can read it without narrowing. */
  parentId?: string
}

/**
 * One finished line of a voice conversation held in front of the thread, from
 * the journaled `_daedalus/voice` update — what the person said, or what the
 * voice model said back.
 *
 * The `!` row's bargain: part of the conversation, back on a reload, but never
 * a prompt. The agent did not read it; what the voice model handed the agent
 * arrived as an ordinary user message beside it.
 */
export interface VoiceItem {
  kind: "voice"
  /** `voice:<voiceId>` — the caller's id, so the fan-out and this device's own
      dispatch of one line are one row. */
  id: string
  role: "user" | "assistant"
  text: string
  at?: number
  /** Never set — a voice line is the thread's — but every item carries it. */
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
  | ShellItem
  | VoiceItem

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

/* Synthetic ids used to be positional (`${kind}-${items.length}`), which
   collides the moment an item is *removed* (`drop-user-message`,
   `dismiss-error`): the next mint reuses a length already spent, so two rows
   share a React key and a dismiss deletes both. A module counter never
   repeats. Replay determinism is unaffected: a replay or re-fold rebuilds
   `items` wholesale in one commit, and nothing matches a synthetic id across
   runs — tool calls keep the agent's own toolCallId, plans and compactions
   carry their protocol ids, and notices dedupe by text. */
let itemSeq = 0
export const mintItemId = (kind: string): string => `${kind}-${++itemSeq}`
