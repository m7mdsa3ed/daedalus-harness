import type * as acp from "@daedalus/acp"
import type { SessionFailure, SessionUpdate } from "@daedalus/protocol"
// Value import, but tools.ts imports only *types* from here — erased at build,
// so there is no runtime cycle.
import {
  applyTerminalMeta,
  askInfoOf,
  parentToolIdOf,
  parseTaskNotification,
  subagentItemId,
  toolNameOf,
  vendorMeta,
  spawnModelOf,
  workflowInfoOf,
} from "../tools"
import { mintItemId } from "./items"
import type {
  AsyncTaskItem,
  AutonomyItem,
  CompactionItem,
  ErrorItem,
  PlanItem,
  ShellItem,
  SubagentItem,
  TextItem,
  ThreadItem,
  ToolItem,
} from "./items"
import type { ThreadState } from "./thread"
import { addUsage } from "./messages"

// ---- update application (shared by live updates and journal rebuild) ----

/** When the step about to be added really began: the end of the last step on
    the same owner (a subagent's for its own, the thread's for the thread's) —
    or, for the first, the message that set the turn going. The agent was at
    work from then, whatever instant its first chunk or its tool call landed.
    Undefined where no earlier step has a stamp (a `session/load` narration). */
function stepFloor(items: ThreadItem[], owner: string | undefined): number | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.parentId !== owner) continue
    const end = "endedAt" in item ? item.endedAt : undefined
    const at = "at" in item ? item.at : undefined
    const start = "startedAt" in item ? item.startedAt : undefined
    return end ?? at ?? start
  }
  return undefined
}

function appendText(
  items: ThreadItem[],
  kind: TextItem["kind"],
  text: string,
  at?: number,
  parentId?: string,
  endedAt?: number
): ThreadItem[] {
  const last = items[items.length - 1]
  /* Same kind AND same owner: a subagent's prose and the parent's resuming
     after it are two runs, not one. Without the second test the parent's next
     sentence was glued onto the child's last one — inside the child's rail. */
  if (last && last.kind === kind && last.parentId === parentId) {
    /* The run's end moves with every chunk that joins it, so the item ends up
       holding the last one: a run the replay split at its size cap arrives as
       two merged events, and the second's end is the run's own. */
    return [...items.slice(0, -1), { ...last, text: last.text + text, endedAt: endedAt ?? last.endedAt }]
  }
  /* A thought's clock starts where the step before it ended, never later than
     its own first chunk (`TextItem.startedAt`). */
  const floor = kind === "thought" && at !== undefined ? stepFloor(items, parentId) : undefined
  const startedAt = floor !== undefined && floor <= at! ? floor : undefined
  return [...items, { kind, id: mintItemId(kind), text, at, endedAt, parentId, ...(startedAt !== undefined ? { startedAt } : {}) }]
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

/** ACP's two terminal tool statuses — after either, nothing more is coming for
    the call, so the update that carries one is the call's own ending. */
const isSettledStatus = (status: string | null | undefined): boolean =>
  status === "completed" || status === "failed"

const metaOf = (update: object): Record<string, unknown> | undefined =>
  (update as { _meta?: Record<string, unknown> | null })._meta ?? undefined

/* Each update's `_meta` carries only what changed alongside it: the launch
   update holds the one-shot `toolResponse`, while later ones repeat constants
   like `toolName` without it — so replacing wholesale would forget the launch
   record the moment the call completed. Merged all the way down through plain
   objects: an AIR client is sent `_meta.jetbrains.air` with only the keys that
   changed, so a merge that stopped one level deep wiped the rest of the `air`
   object on every update. Arrays and scalars replace. The terminal chunks are
   not read from here — `applyTerminalMeta` takes each update's own `_meta` —
   so a merge that keeps the last chunk loses nothing. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

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
    if (isPlainObject(a) && isPlainObject(b)) merged[key] = mergeMeta(a, b)
  }
  return merged
}

/* The AIR block on an update (`VENDOR_META.air`). */
const airMetaOf = (update: object): Record<string, unknown> | undefined =>
  vendorMeta(metaOf(update), "air") ?? undefined

const sessionFailureOf = (update: object): SessionFailure | null => {
  const raw = airMetaOf(update)?.sessionFailure
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== "string" || typeof raw.title !== "string") return null
  return raw as unknown as SessionFailure
}

/* An AIR session failure, as the transcript's error row. One row per failure
   id, placed where the first record of it arrived; a restatement under the
   same id replaces it only with a higher revision, so a replay or a stale
   repeat is a no-op. The actions are the agent's, and only the ones a client
   door already exists for are kept — `retry` is the row's own Retry, which
   re-sends the thread's last prompt. `login`/`new_session` have no door on a
   transcript row yet, and an action is never inferred from `category`. */
function upsertFailure(items: ThreadItem[], failure: SessionFailure, at?: number): ThreadItem[] {
  const id = `failure:${failure.id}`
  const revision = typeof failure.revision === "number" ? failure.revision : 0
  const index = items.findIndex((i) => i.kind === "error" && i.id === id)
  const prev = index >= 0 ? (items[index] as ErrorItem) : undefined
  if (prev && (prev.revision ?? 0) >= revision) return items
  const prompt = Array.isArray(failure.actions) && failure.actions.includes("retry")
    ? (items.filter((i) => i.kind === "user" && !i.parentId).at(-1) as TextItem | undefined)
    : undefined
  const item: ErrorItem = {
    kind: "error",
    id,
    title: failure.title,
    ...(failure.details ? { detail: failure.details } : {}),
    ...(prompt?.text ? { retryText: prompt.text } : {}),
    ...(prompt?.attachments?.length ? { retryAttachments: prompt.attachments } : {}),
    ...(failure.severity === "warning" ? { severity: "warning" as const } : {}),
    /* A warning is a retry in flight unless it is the agent's `advisory`, which
       is a note to keep. */
    ...(failure.severity === "warning" && failure.category !== "advisory" ? { transient: true } : {}),
    revision,
    at: prev?.at ?? at,
  }
  return prev ? items.map((i, n) => (n === index ? item : i)) : [...items, item]
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
  sessionId?: string,
  stamp?: number,
  historyText?: string,
  historyAttachments?: TextItem["attachments"],
  endStamp?: number
): ThreadItem[] {
  /* `allowUserChunks` is set only by the replay path, so it doubles as "this is
     history": replayed items get no timestamp rather than the reload's. The run's
     own end rides the same rule — an item with no honest start can have no
     honest length either. */
  const now = stamp ?? Date.now()
  const at = allowUserChunks ? undefined : now
  const endedAt = allowUserChunks ? undefined : endStamp
  /* Whose item this is. The vendor `_meta` naming a parent tool call (Claude
     Code's Task, or the child session OpenCode projects) wins over an update
     that arrived on a subagent's session (the RFD: `sessionId` names the
     child) — but only when that tool row exists. A workflow step's own Task
     tree arrives mirrored WITH the step's session id AND the Task attribution,
     and filing it under the step flattened the tree Claude Code's native
     transcript nests. But claude-agent-acp with native subagent sessions never
     sends the Task row at all, while every child update keeps its
     `parentToolUseId`: meta-first there filed the whole child under a head
     that never arrives, and it drew flat. So a missing tool yields to the
     session. No meta, but a session — the child's item. Neither — the
     thread's own. */
  // ponytail: O(n) scan per child update that carries both; index ids if replay of huge transcripts gets slow.
  const ownerOf = (metaParent: string | undefined): string | undefined =>
    metaParent !== undefined && (!sessionId || items.some((i) => i.id === metaParent))
      ? metaParent
      : sessionId
        ? subagentItemId(sessionId)
        : undefined
  const owner = ownerOf(parentToolIdOf(metaOf(update)))
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text") return items
      const kind = update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought"
      return appendText(items, kind, update.content.text, at, owner, endedAt)
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
      if (historyAttachments?.length) {
        const text = historyText ?? update.content.text
        const last = items[items.length - 1]
        if (last?.kind === "user" && !last.parentId) {
          return [
            ...items.slice(0, -1),
            { ...last, text: last.text + text, attachments: [...(last.attachments ?? []), ...historyAttachments] },
          ]
        }
        return [...items, { kind: "user", id: mintItemId("user"), text, at, attachments: historyAttachments }]
      }
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
        startedAt: now,
        at,
        // An agent may announce a call already finished, and then this is the
        // only update it ever sends.
        endedAt: allowUserChunks || !isSettledStatus(update.status) ? undefined : now,
      }
      const existing = items.find((i): i is ToolItem => i.kind === "tool" && i.id === item.id)
      /* A re-announced call is replaced wholesale, bar what it may have learned
         since: who it belongs to, and when it settled — a call that has reached
         a terminal status has not un-reached it. Claude Code's attribution is
         best-effort — a child's `tool_call` can go out before the runtime
         knows which Task it serves and be told on a later update — so an
         owner once learned is never forgotten. */
      item.parentId = owner ?? existing?.parentId
      item.name = item.name ?? existing?.name
      /* A re-announced call started when it was first announced — a
         restatement is later only because it was sent later. A call announced
         already finished (its one and only update) started where the step
         before it ended: stamping it at its arrival made its start its end,
         and the row had no length to say. */
      if (existing) item.startedAt = existing.startedAt
      else if (item.endedAt !== undefined) {
        const floor = stepFloor(items, item.parentId)
        if (floor !== undefined && floor <= item.endedAt) item.startedAt = floor
      }
      /* The FIRST ending, not the latest: a restatement arrives later simply
         because it was sent later, and the call did not end twice. */
      item.endedAt = existing?.endedAt ?? item.endedAt
      if (existing) {
        return items.map((i) => (i.kind === "tool" && i.id === item.id ? item : i))
      }
      return [...items, item]
    }
    case "tool_call_update":
      return items.map((i) => {
        if (i.kind !== "tool" || i.id !== update.toolCallId) return i
        const meta = mergeMeta(i.meta, metaOf(update))
        const status = update.status ?? i.status
        return {
          ...i,
          title: update.title ?? i.title,
          status,
          /* Where the call stopped, for the row to say how long it took once
             nothing is ticking any more. First one wins — a runtime that
             restates a terminal update has not moved the ending — and a
             `session/load` replay is left without one, its stamps being the
             reload's rather than the call's (`at` above makes the same call). */
          endedAt: i.endedAt ?? (allowUserChunks || !isSettledStatus(status) ? undefined : now),
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
          parentId: ownerOf(parentToolIdOf(meta)) ?? i.parentId,
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
      /* Except one: an AIR client that declared `planContentDelta` is sent a
         markdown plan whole once, and after that an empty `content` with the
         appended text at `_meta.jetbrains.air.contentDelta`. Only an empty
         content with a delta, onto a plan we hold, appends — anything else is
         a snapshot and replaces, as above. */
      const delta = airMetaOf(update)?.contentDelta
      if (content.type === "markdown" && content.content === "" && typeof delta === "string") {
        const held = items.find((i): i is PlanItem => i.kind === "plan" && i.id === plan.id)
        if (held) {
          return items.map((i) => (i === held ? { ...held, markdown: (held.markdown ?? "") + delta } : i))
        }
      }
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
      const daedalusBrief = vendorMeta(metaOf(update), "daedalus")?.prompt
      const spawnBrief = typeof daedalusBrief === "string" ? daedalusBrief : undefined
      const item: SubagentItem = {
        kind: "subagent",
        id,
        sessionId: update.subagentSessionId,
        name: update.name,
        task: update.task,
        capabilities: update.capabilities ?? {},
        workflow: workflowInfoOf(metaOf(update)) ?? existing?.workflow,
        ask: askInfoOf(metaOf(update)) ?? existing?.ask,
        /* A `session/load` restating the spawn keeps what the first one said. */
        model: spawnModelOf(metaOf(update)).model ?? existing?.model,
        role: spawnModelOf(metaOf(update)).role ?? existing?.role,
        /* Our runtime trims `task` for the RFD and sends the whole brief in
           `_meta.daedalus.prompt`. */
        prompt: update.prompt ?? spawnBrief ?? existing?.prompt,
        usage: existing?.usage,
        context: existing?.context,
        durationMs: existing?.durationMs,
        /* A restated spawn keeps the run it restates; a settled child spawned
           again is a wake, and its clock starts here. */
        runningSince: existing?.state === "running" ? (existing.runningSince ?? now) : now,
        state: "running",
        startedAt: existing?.startedAt ?? now,
        at: existing?.at ?? at,
        parentId: owner ?? existing?.parentId,
      }
      return existing
        ? items.map((i) => (i.kind === "subagent" && i.id === id ? item : i))
        : [...items, item]
    }
    case "subagent_state_update": {
      const id = subagentItemId(update.subagentSessionId)
      /* Only a running child's settle adds time — a restated end is not a second turn. */
      return items.map((i) =>
        i.kind === "subagent" && i.id === id
          ? {
              ...i,
              state: update.state,
              ...(i.state === "running"
                ? { durationMs: (i.durationMs ?? 0) + Math.max(0, now - (i.runningSince ?? i.startedAt)) }
                : {}),
            }
          : i
      )
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
        startedAt: existing?.startedAt ?? now,
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
        at: now,
        ...(owner ? { parentId: owner } : {}),
      }
      return [...items, item]
    }
    /* A `!` line the user ran, in the thread where it was run. Appended, like
       the autonomy row above: it is an act of the user's, not a patch to
       anything already on screen. Unlike the agent's own tool steps it fired no
       turn — the server ran the line and wrote this row — so `turnActive` never
       moved and the agent was never told. */
    case "_daedalus/shell": {
      /* Keyed by the caller's id, not appended: the composer draws the row the
         moment the line starts, and the `running`/`done` updates that follow are
         that same row with more said about it. The first update to arrive fixes
         its place, the way a compaction's first one does. */
      const id = `shell:${update.shellId}`
      const index = items.findIndex((i) => i.kind === "shell" && i.id === id)
      const prev = index >= 0 ? (items[index] as ShellItem) : undefined
      const output = update.output ?? ""
      const exitCode = update.exitCode ?? null
      const timedOut = update.timedOut ?? false
      /* The same update a second time — the fan-out and this device's own
         dispatch are the same news — must not rebuild the item, or the row
         re-renders for nothing. */
      if (
        prev &&
        prev.command === update.command &&
        prev.status === update.status &&
        prev.output === output &&
        prev.exitCode === exitCode &&
        prev.timedOut === timedOut
      ) {
        return items
      }
      const item: ShellItem = {
        kind: "shell",
        id,
        command: update.command,
        status: update.status,
        output,
        exitCode,
        timedOut,
        at: prev?.at ?? now,
        ...(owner ? { parentId: owner } : {}),
      }
      return index >= 0 ? items.map((i, n) => (n === index ? item : i)) : [...items, item]
    }
    /* A finished voice line, appended where it was said. Keyed by the caller's
       id, so this device's own dispatch and the fan-out of the same line are
       one row; a line is whole when it arrives, so there is nothing to patch. */
    case "_daedalus/voice": {
      const id = `voice:${update.voiceId}`
      if (items.some((i) => i.kind === "voice" && i.id === id)) return items
      return [...items, { kind: "voice", id, role: update.role, text: update.text, at: now }]
    }
    /* The AIR failure record rides a `session_info_update` (the rest of which
       — title, timestamps — is the server's to say, not the transcript's). The
       failure of a running turn also comes back on the prompt's response,
       which the server lifts onto `turn_ended.failure`; the socket hands that
       one here as this same update, so both doors are one reader. */
    case "session_info_update": {
      const failure = sessionFailureOf(update)
      return failure ? upsertFailure(items, failure, at) : items
    }
    /* ACP's `notice`: a warning, a deprecation, a config problem the agent
       reports without a turn failing. The error row in a softer tone. It
       carries no id, so its words are its key — a `session/load` restating
       one must not draw it twice, the same bargain task notifications make. */
    case "notice": {
      const id = `acp-notice:${update.title}\n${update.description ?? ""}`
      if (items.some((i) => i.kind === "error" && i.id === id)) return items
      const item: ErrorItem = {
        kind: "error",
        id,
        title: update.title,
        ...(update.description ? { reason: update.description } : {}),
        ...(update.severity === "error" ? {} : { severity: update.severity === "info" ? "info" : "warning" }),
        at,
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
  update: acp.UsageUpdate,
  at: number
): Pick<ThreadState, "stepUsage" | "stepAt" | "usageMark"> {
  const kept = { stepUsage: thread.stepUsage, stepAt: thread.stepAt, usageMark: thread.usageMark }
  if (!(update.used > 0)) return kept
  let tail: ThreadItem | undefined
  for (let i = thread.items.length - 1; i >= 0; i--) {
    if (!thread.items[i].parentId) {
      tail = thread.items[i]
      break
    }
  }
  if (!tail || thread.usageMark === tail.id) return kept
  return { stepUsage: { ...thread.stepUsage, [tail.id]: update }, stepAt: { ...thread.stepAt, [tail.id]: at }, usageMark: tail.id }
}

/** Folds a step's own bill into the running turn's, when the runtime says it. */
function liveStep(thread: ThreadState, update: acp.UsageUpdate): Pick<ThreadState, "liveUsage"> | null {
  const step = vendorMeta(update._meta, "daedalus")?.step as acp.Usage | null | undefined
  return step ? { liveUsage: addUsage(thread.liveUsage, step) } : null
}

/** Session-level (non-transcript) updates applied to ThreadState. */
export function applyMetaUpdate(
  thread: ThreadState,
  update: SessionUpdate,
  allowUserChunks = false,
  sessionId?: string,
  stamp?: number,
  historyText?: string,
  historyAttachments?: TextItem["attachments"],
  endStamp?: number
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
    return {
      ...thread,
      items: applySessionUpdate(thread.items, update, allowUserChunks, sessionId, stamp, historyText, historyAttachments),
    }
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
      return { ...thread, context: update, ...markStepUsage(thread, update, stamp ?? Date.now()), ...liveStep(thread, update) }
    default:
      return {
        ...thread,
        items: applySessionUpdate(thread.items, update, allowUserChunks, sessionId, stamp, historyText, historyAttachments, endStamp),
      }
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
export function settleTools(items: ThreadItem[]): ThreadItem[] {
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
