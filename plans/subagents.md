# Daedalus Harness — Sub-agent support (nested transcripts)

## Context
ACP v1 has **no first-class sub-agent concept** — tool calls are a flat list, `ToolKind` has no
`agent`/`task`, and the only spec movement is the proxy-chains RFD (mechanism deferred). What exists
today is vendor-namespaced `_meta`, which the spec reserves for exactly this and requires clients to
tolerate ignoring:

- **claude-agent-acp** — opt-in: client advertises `clientCapabilities._meta["subagent-transcript"] = true`
  at `initialize`. Then Agent/Task tool calls carry `_meta.claudeCode.subagent = true`, and the
  subagent's text/thought/tool_call updates are forwarded tagged with
  `_meta.claudeCode.parentToolUseId` (nested to depth 5, each keyed by its own parent). Without the
  opt-in: legacy flat behavior. In both modes the Task tool result is preserved as fallback.
- **codex-acp** — no child stream: sub-agent launches are single tool calls carrying
  `_meta.codex.subagent` (thread identity + activity kept inside the one call).
- **Spec gift**: `ContentChunk` already has an optional `messageId` — "all chunks belonging to the
  same message share the same messageId; a change indicates a new message" — a *generic* stream
  identity for text, independent of any vendor.

Decisions locked (see assessment, 2026-08-26):
- **Store stays flat**; every `ThreadItem` gains optional `parentId`; the tree is derived at render.
  Replay, `tool_call_update` routing, journal rebuild, peer sync all keep working at any depth.
- **Text merging becomes stream-aware** (the latent bug: `appendText` merges into "last item of same
  kind" — six concurrent speakers would concatenate into one bubble). Merge key: `messageId` when
  present, else (kind + parentId) adjacency *within the stream*.
- **Vendor decoding quarantined in `lib/tools.ts`** (the existing quarantine file). Store and
  components speak only a normalized shape; when ACP standardizes, one decoder changes.
- **Permission slot → queue** (pre-existing overwrite bug at `actions.ts` onPermission; parallel
  subagents make it real).
- **Capability advertised always** — `_meta` is ignorable by spec; per-agent capability tables are
  the vendor knowledge our conventions forbid. But it lands in the same phase as rendering, since
  advertising alone changes what claude-agent-acp streams.
- **Nesting is best-effort presentation, never correctness**: an orphaned/unknown `parentId` renders
  at top level; a replay that arrives flat renders as today's transcript. Nothing is ever hidden
  because a parent is missing.

## Phase 1 — Stream-aware text (prerequisite; zero visible change)
`client/src/lib/store.tsx` only.
- `TextItem` gains `messageId?: string` and `parentId?: string`.
- `appendText(items, kind, text, at, stream)` where `stream = { messageId?, parentId? }`:
  merge into the **last item of the same stream** (same kind + same parentId, and same messageId when
  both sides have one — a changed messageId starts a new item even mid-stream), searching backwards,
  not just `items[items.length - 1]`. Appending text to a non-tail item is correct: the bubble a
  chunk belongs to is fixed by its stream, not by arrival order.
- Item ids include the stream so interleaved rebuilds stay deterministic:
  `${parentId ?? "main"}-${kind}-${items.length}` (lengths never repeat, so uniqueness holds).
- `applySessionUpdate` reads `update.messageId` for chunks; `parentId` stays undefined until Phase 2.
- Synthetic-interrupt notices (`SYNTHETIC_USER_RE`) unaffected — they never merge.

## Phase 2 — Normalized subagent contract
- `client/src/lib/tools.ts`: `subagentMetaOf(update: acp.SessionUpdate)` →
  `{ parentId?: string; isSubagentLaunch?: boolean; label?: string }`. Two decoders behind it:
  `_meta.claudeCode` (`parentToolUseId`, `subagent`) and `_meta.codex.subagent` (self-contained
  launch marker). Unknown namespaces → `{}`. This is the ONLY file that may mention a vendor name.
- `client/src/lib/store.tsx`: `ToolItem` gains `parentId?` and `subagent?: boolean`;
  `applySessionUpdate` stamps both from `subagentMetaOf` on `tool_call` / chunks
  (`tool_call_update` keeps its flat id lookup — a parent link never changes mid-call).
- The `_meta` fields flow through untouched everywhere else: server never interprets
  `session/update`, and the frame journal replays raw NDJSON — **no server change for the data path**.

## Phase 3 — Permission queue (independent; fixes a live bug)
- `client/src/lib/store.tsx`: `ThreadState.permission: PendingPermission | null` →
  `permissions: PendingPermission[]`; reducer action pushes; `resolve` removes **by identity**, not
  by clearing the slot (today a second concurrent request orphans the first promise — the agent
  waits forever on a dialog that no longer exists).
- `client/src/lib/actions.ts`: `onPermission` pushes; `onPeerAnswered(toolCallId)` removes the
  matching entry (the `_daedalus/request_answered` frame already carries `toolCallId`).
- `client/src/components/thread-view.tsx` + `tool-approval.tsx`: render the queue head (badge with
  remaining count); each pending request keeps its `toolCallId` so Phase 4 can attach it visually to
  the subagent row that asked.

## Phase 4 — Advertise + render the tree
- `client/src/lib/acp.ts` (handshake, ~line 181): add `_meta: { "subagent-transcript": true }` to
  `clientCapabilities`. Same commit as the rendering below — never advertise without Phase 1+2 in.
- `client/src/components/thread-view.tsx`: memoized partition of `thread.items` by
  `parentId ?? "main"` (orphans → "main"); `groupToolRuns` now runs **per stream** — a subagent's
  interleaved call must not split or pollute a main-agent run.
- `client/src/components/thread-items.tsx`: `SubagentRow` — a tool call with `subagent: true` OR
  with children. Header: title / status / live elapsed (reuse `StepRow` affordances). Body when
  expanded: the child stream rendered recursively through the same `ThreadItemView` + per-stream
  grouping (depth 5 costs nothing — it's the same component). Collapsed by default; the flat Task
  result content renders as the collapsed summary and is **suppressed when expanded** (it duplicates
  the child stream). A codex-style self-contained launch has no children and falls through to the
  tool call's own content — same component, two data sources.
- No new view-option in v1; collapsed-by-default is the control.

## Phase 5 — Journal bound (server; before forwarding becomes the default workload)
Forwarding multiplies traffic ~(1 + N subagents)×. `server/src/sessions.ts` keeps the journal as an
unbounded in-memory array (stderr got `STDERR_TAIL_LINES`; the journal got nothing).
- Add a byte-budgeted cap (e.g. `MAX_JOURNAL_BYTES`, order 8–16 MB/session). When exceeded, drop the
  oldest frames and record `journalBase` (count of dropped frames).
- Reattach with `cursor < journalBase` cannot be served by replay → close that peer with a distinct
  code/reason ("journal truncated — reload"); the client already knows how to rebuild a thread via
  the respawn + `session/load` path, which re-canonicalizes the journal. This is the same
  degradation contract as agent restart, so no new client machinery — just the reason string.
- Log when truncation happens (no silent caps).

## Verification
- `client`: `pnpm exec tsc -b`; `server`: `pnpm exec tsc --noEmit && pnpm test`.
- Extend `server/test/fake-agent.mjs` (fake-echo): behind a prompt keyword ("subagents"), emit a
  scripted burst — a `tool_call` marked `_meta.claudeCode.subagent`, interleaved
  `agent_message_chunk`s with distinct `messageId`s + `parentToolUseId`s from two fake children,
  a nested (depth-2) child, and two overlapping `session/request_permission`s. This exercises
  Phases 1–4 end-to-end with no credentials, and doubles as the pipe-test fixture for the journal
  cap in Phase 5.
- UI: user manual pass (project convention — no browser automation/screenshots). Checklist: chunks
  never cross-contaminate bubbles; collapse/expand; orphan fallback (replay a flat history);
  permission queue shows both requests; codex thread renders its launch as a single row.

## Risks / notes
- **Replay may arrive flat**: whether claude-agent-acp replays `_meta` on `session/load` is its
  business and may change — the orphan-to-top-level rule makes this cosmetic, not correctness.
- `messageId` is optional in the spec — the (kind + parentId) adjacency fallback must stay.
- Render cost at 6 concurrent streams: deferred until evidence; if chunk-rate re-renders hurt,
  batch dispatches in `acp.ts onUpdate` (rAF micro-batch) — do not pre-optimize.
- Vendor namespaces can drift with adapter releases; `subagentMetaOf` is the single blast radius.
- `usage_update` / ttft / `turnActive` are per-session, not per-stream — no change needed; first
  forwarded child chunk legitimately counts as first token.

## Critical files
- Modify: `client/src/lib/store.tsx`, `client/src/lib/tools.ts`, `client/src/lib/actions.ts`,
  `client/src/lib/acp.ts`, `client/src/components/thread-view.tsx`,
  `client/src/components/thread-items.tsx`, `client/src/components/tool-approval.tsx`,
  `server/src/sessions.ts`, `server/test/fake-agent.mjs`, `server/test/pipe.test.ts`.
- Follow patterns from: `lib/tools.ts` header comment (vendor quarantine rule),
  `store.tsx applySessionUpdate` (shared live/replay path — every change must hold for both),
  `sessions.ts STDERR_TAIL_LINES` (bounded-buffer precedent).

## Build order
Sequential, small enough to run directly (no workflow): 1 → 2 → 3 → 4 → 5, with `tsc` green after
each phase. Phases 1–3 are shippable independently and change nothing visible; Phase 4 is the
feature; Phase 5 is scheduled before enabling any future "forward by default" agent config.
