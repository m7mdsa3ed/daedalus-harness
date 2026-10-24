# Tracing: one record per model call, from whichever door a runtime has

## Context — what already ships

- **The agent meters every call at one seam** (`agent/src/metering.ts`, `Meter.record` on the AI
  SDK's `onLanguageModelCallEnd`): the root loop, its retries, subagents, the compaction summary
  and the title call all pass the same callback. It fires after the response is parsed and before
  any tool runs, so a cancelled turn still reports what the provider billed.
- **The SDK hands over the other half at the same seam.** `onLanguageModelCallStart` carries the
  prompt **exactly as sent** — `instructions`, the V3 `messages`, the *prepared* tool JSON — under
  a `callId` the end event repeats.
- **Per-step usage already rides the journal**: `usage_update` with `_meta.cache` and
  `_meta.daedalus.step`; the client sums the latter into `liveUsage`. Every runtime sends one.
- **A harness-private update has a door**: `SUBAGENT_UPDATE_KINDS` (`acp-bridge.ts`) lists the
  names the SDK's closed union would drop; the bridge forwards them whole.
- **A derived ledger has a precedent**: `recordWebSearchUsage` (`sessions.ts` ~1297) writes
  `web_search_usage` from the one place that sees every live, non-replay, non-mirrored update,
  names snapshotted. `project-stats.ts` reads it.
- **A mechanism is a column on the runtime's row, never a comparison against its id**
  (CLAUDE.md): `pauseVia`, `quotaProbe` (`{kind, command, args}`), `sharedProcess`,
  `workspaceLayout`. A user who repoints `command` at a fork repoints these with it.
- **The gateway shim** (`gateway-shim.ts`) already fronts a thread's provider requests byte for
  byte: `/gw/<key>/s/<sessionId>/<agentId>/…` names the thread, forwards to the profile's base
  URL and makes one repair. A proxy sees the request (the prompt) and the response (the bill).
- **The removed design** (`git show 032f5c36^`) had **four producers and no contract**: the
  agent's OTel spans (`agent/src/tracing.ts`), Claude Code's OTLP logs + raw request bodies
  (`otlp.ts`, `TELEMETRY_VIA`, `CLAUDE_OTLP_ENV`), the shim counting every request
  (`prompt-parts.ts` — which once froze every socket 43–156 ms a request until counting was
  taken off the response path), and the runtimes' own session files (`prompt-files.ts`:
  `claude-jsonl` with `prompt_snapshot`, `codex-rollout`, `opencode-sqlite`, each saying in words
  what it does *not* hold — `missing`). Each landed in a different place with a different shape
  and the client reconciled them (`source: agent | gateway | files | transcript`). What is kept:
  the dialect knowledge in each reader, the anchored split, the hash cache and loop yield,
  `missing` as noun phrases. What is not: spans, a span store, and four shapes.

## The unit

One **`ModelCall`** per provider request, whoever observed it.

```ts
interface ModelCall {
  callId: string;
  at: number;                         // epoch ms sent
  ms?: number;                        // wall time to the parsed response, when the door saw both ends
  who: "turn" | "subagent" | "compaction" | "title";
  childId?: string;
  step: number;                       // 1-based within the turn; the door fills it
  model: string;
  finishReason?: string;
  /** Which door built it. */
  source: "acp" | "otlp" | "proxy" | "files" | "usage";
  /** Exact — the provider's counters, `acp.Usage` shaped (fresh input, cache read/write beside it). */
  billed: acp.Usage;
  costUsd?: number;                   // only when the runtime says it (Claude Code's cost_usd)
  timing?: { ttftMs?: number; decodeMs?: number };
  /** ~ Where the prompt went. Present parts sum, with `unknown`, to fresh + cacheRead + cacheWrite.
      A part the door could not see is null and named in `missing`. */
  prompt?: { system: number | null; tools: number | null; mcp: number | null;
             user: number | null; assistant: number | null; results: number | null; unknown: number };
  missing?: string[];                 // "the system prompt", "tool schemas" — the door's own words
  /** ~ What the output was; `reasoning` exact when reported. */
  output?: { text: number; reasoning: number; toolCalls: number };
  /** Which section / which tool definition is the big one. Raw local counts (proportions only),
      sent when the prefix changes, never every step. */
  items?: { system: PrefixItem[]; tools: PrefixItem[]; mcp: PrefixItem[] };
}
```

## Design decisions

1. **The record is the contract; the door is the runtime's business.** Everything downstream —
   the wire event, the journal, the ledger, the panel, the Spend tab — sees `ModelCall` and
   nothing else. No consumer asks which runtime or which door; `source` and `missing` are drawn,
   never branched on.
2. **No spans.** A turn's timeline is already in the journal (`turn_started`/`turn_ended`, every
   tool call with its `at` and terminal status); `ModelCall`s fill the gaps between. Nothing is
   propagated or de-duplicated. External OTel export is out of scope (one env-gated agent file if
   ever named).
3. **One wire event**: `sessionUpdate: "_daedalus/model_call"`, a journaled `update` on the
   session it belongs to (a subagent's on the child's id). Listed in `SUBAGENT_UPDATE_KINDS`.
   The server-built ones take the same path the runtime's own updates take, so the bridge, the
   journal and the client cannot tell who built a record.
4. **Which door a runtime has is a column: `AgentDef.callsVia: CallDoor[]`**, ordered, data not
   code, seeded and backfilled like `quotaProbe`:
   ```ts
   type CallDoor =
     | { kind: "acp" }                                            // the runtime sends the record itself
     | { kind: "otlp"; dialect: "claude-otlp"; env: Record<string, string> }   // templated OTEL_* switches
     | { kind: "proxy"; dialect: "anthropic-messages" | "openai-chat" | "openai-responses" }
     | { kind: "files"; format: "claude-jsonl" | "codex-rollout" | "opencode-sqlite" };
   ```
   Seeds: `daedalus: [acp]`, `claude-code: [otlp, proxy(anthropic-messages), files(claude-jsonl)]`,
   `codex: [proxy(openai-responses), files(codex-rollout)]`, `opencode: [proxy(openai-chat),
   files(opencode-sqlite)]`. A fifth door is a union member, a file under `sources/`, and a seed
   — nothing else. **The implicit last door is `usage`**: every runtime's `usage_update`, billed
   only, never listed.
5. **One door per thread, chosen by what can attach.** When a thread spawns, the first door in
   the list whose `attach(thread)` answers is the thread's; the rest are not tried. `otlp` needs
   a booted receiver; `proxy` needs the thread to be behind the shim (a profile with a gateway —
   a Default or subscription profile is not); `files` needs the runtime's store on this machine
   and the *earned* ACP session id (it attaches when `acp_session` is proven, not before);
   `acp` always attaches. The choice is the thread's for its life and is said on
   `session_config` (`callsVia`), so the panel can say "from its telemetry" / "from the gateway"
   / "from its saved files" / "the provider's bill per step". **The double-count guard is this
   choice**: a `usage_update` is a row only on a thread whose door is `usage`.
6. **One server door for every source**: `recordCall(threadId, draft)` in
   `server/src/model-calls/index.ts`. It fills `step` and the open `turnId` from the bridge,
   anchors the parts to the billed prompt, emits the update onto the thread, writes the ledger
   row. Sources build drafts and call it; **a source never touches the bridge, the journal or the
   database.** The `acp` source is the degenerate one: the record arrives built, the door only
   files it.
7. **One counting path for every server-built record**: `prompt-parts.ts` — a `RequestShape`
   (`system[]` named, `tools[]` named, `messages[]` by role) → counts (gpt-tokenizer, a hash
   cache per text, the loop yielded every few ms) → `anchor(total, counts)`. Dialect adapters
   produce a `RequestShape` from an Anthropic Messages body, an OpenAI chat body, an OpenAI
   Responses body, a Claude `prompt_snapshot`, a Codex rollout, an OpenCode `instruction_state`
   row — six small functions, one shape, one counter. The agent counts at its own seam with the
   same library and the same `anchor` formula (fifteen lines, tested in both halves — the one
   duplicated piece, because the agent cannot import the server).
8. **Anchored, not simulated.** The provider's prompt total is the truth; local counts are
   proportions of it. A prefix larger than the invoice is scaled by one factor. A part a door
   could not see is `null`, its share lands in `unknown`, and `missing` says why in words — the
   panel draws "not available", never a smaller prompt and never "overhead" as if measured.
9. **Counting is never on a request's path.** The proxy copies the request body and reads usage
   off the response as it streams through (`message_start`/`message_delta`, `usage` in the final
   chunk, or the JSON body), and counts *after* the response has ended. The agent counts after
   the call answers. `files` reads from where it stopped, off a debounce. `otlp` is already
   asynchronous.
10. **A door trusts nothing it is handed.** `otlp`'s key in the path is the credential
    (`derive("otlp")` from `data/loopback-secret`); a body file is read only from the thread's
    own directory under `DATA_DIR`, deleted once counted, the directory wiped at boot; identity
    attributes (`user.email`, `organization.id`, `session.id`) are dropped. `proxy` reads the
    body it is already forwarding and stores none of it. `files` opens read-only and never
    writes to a runtime's store.
11. **Two stores, one source.** The journal is the thread's (replay, the panel); `model_calls`
    is the install's (cross-thread spend). Both are written by `recordCall`, so neither is a
    second reading of the other. Not exported by backup, like `web_search_usage`.
12. **Billed figures are `acp.Usage` everywhere** — the convention `lib/tokens.ts` draws from.
    Cost is only ever what a runtime reported; `models.pricing` is a later multiplication.
13. **Settings › Usage is the one surface that lists spend** (CLAUDE.md "Ops"); the thread's own
    reading is a thread-dock panel beside Changes, Plan, Agents, Details.

## Phases

### 1 — Agent: the `acp` door (`agent/src/trace.ts`, `test/trace.test.ts`)

- `gpt-tokenizer` back (`^4.1.0`). `Tracer.start(event)` parks by `callId`; `Tracer.end(event)`
  joins, counts, anchors, returns a `ModelCall` (`source: "acp"`). Pure beside it: `anchor`,
  `splitOutput`, `countPrefix` (MCP = `mcp__` prefix), `countMessages` (content-keyed bounded
  cache — the V3 prompt is rebuilt every call, so a `WeakMap` never hits).
- `turn.ts`: one helper composes `meter.record` with the tracer at the four `streamText` sites;
  `who`/`childId` from the caller; `items` on step 1 and when `deferMcpTools` changes the set.
- `agent/docs/managing.md`: the record replaces the `_meta.breakdown` paragraphs.

### 2 — Server core: the contract, the door, the ledger

- `protocol.ts`: `ModelCall`, `ModelCallUpdate`, `CallDoor`; `callsVia` on `session_config`.
  `SUBAGENT_UPDATE_KINDS` gets the name. `compat.ts`: one `FEATURES` entry, no bump.
- `db/schema.ts`: `agents.calls_via` (jsonb `CallDoor[]`); `model_calls` — ids, `turn_id`,
  `at`, `ms`, `who`, `child_id`, `step`, `agent_id`, `model`, `finish_reason`, `source`, billed
  columns, `cost_usd`, the six nullable part columns + `unknown`, `missing` (jsonb), the three
  nullable output columns, the snapshot columns `web_search_usage` has. No FK. Indexes
  `(session_id, at)`, `(at)`. `pnpm db:push`.
- `registry.ts`: the seeds above, backfilled where absent (a user's row is theirs); the `otlp`
  door's `env` is the templated `CLAUDE_OTLP_ENV` (`{otlpUrl}`, `{otlpBodies}`, empty when
  there is no receiver so the key prunes).
- `model-calls/index.ts`: `CallSource` (`attach(thread): Promise<Attached | null>`;
  `Attached = { spawnEnv?, stop() }`), the registry of sources by `kind`, `chooseDoor(thread)`,
  `recordCall`. `model-calls/prompt-parts.ts`: `RequestShape`, `countShape`, `anchor`, the
  dialect adapters. `model-calls/sources/acp.ts` and the implicit `usage` fallback.
- Wiring: `bridge-host.ts` asks `chooseDoor` at spawn and merges `spawnEnv` as it does
  `{gatewayUrl}`; `sessions.ts` calls `recordCall` for `_daedalus/model_call` and the `usage`
  fallback in the `recordWebSearchUsage` block; the bridge exposes the open `turnId` and a
  per-turn step counter the door reads.
- Routes: `GET /api/sessions/:id/calls` (paged by `at`; the panel's cold read) and
  `GET /api/usage/calls?from&to&groupBy=profile|model|project|agent|source`.
- Tests: `test:model-calls` — the door picks the first attachable source, a `usage` thread
  rows on `usage_update` and an `acp` thread does not, `anchor` sums (normal, overshoot, parts
  missing → `unknown`), snapshot columns, the six adapters each produce the same shape from a
  fixture.

### 3 — Server doors, one file each under `model-calls/sources/`, each shippable alone

- **`otlp.ts`** (Claude Code; logs only): `/otlp/:key/:threadId/v1/logs` (gzip, OTLP/JSON);
  `/v1/traces` and `/v1/metrics` 200-and-drop. Pairs `api_request` (billed, `cost_usd`,
  `duration_ms`, `model`) with `api_request_body` (file read, shaped by the Anthropic adapter,
  deleted) by request id. A body with no request in a few seconds is counted billed-less; a
  request with no body is a record with `prompt` absent. `test:otlp`: wrong key 404, a path
  outside the thread's directory refused, the pair becomes one record whose parts sum, the file
  is gone, identity dropped, traces/metrics record nothing.
- **`proxy.ts`** (any runtime behind the shim): a tap the shim calls with
  `(sessionId, requestBody, responseUsage, timing)` once a forwarded response has ended; the
  dialect is the door's (`anthropic-messages` / `openai-chat` / `openai-responses`), the shim
  spells none. Counting runs after the tap, never inside the forward. `test:gateway` gains: a
  streamed Messages reply yields one record with the body's parts; the forward's bytes are
  unchanged; a thread not on the shim does not attach.
- **`files.ts`** (`prompt-files.ts` revived as a door): the three readers (`claude-jsonl`
  reading `prompt_snapshot` + per-assistant-message `usage`; `codex-rollout` reading
  `token_count` events and the developer/system messages, no tool schemas; `opencode-sqlite`
  via `node:sqlite` read-only, context only). Attaches once the ACP session id is earned; tails
  from where it stopped on a debounced watch; a file that is missing, locked or newer than
  understood yields nothing (the thread stays on `usage`). `missing` is each reader's own
  phrase. `test:prompt-files` with one fixture per format.

### 4 — Client

- `store`: `thread.calls: ModelCall[]` on `_daedalus/model_call`, filed under the open turn;
  `thread.callsVia` from `session_config`.
- `lib/trace.ts` (pure, `trace.check.mjs`): group by turn; per-turn and per-thread sums of
  billed and of the ~ parts (null-aware); "cache saved"; the latest `items`; rows for a `usage`
  thread from `stepUsage` with no parts.
- `thread-view/trace-panel.tsx`, `ThreadSectionKind` `"trace"` in `SECTIONS` and
  `InspectorContext`. Kit only: `StatStrip` (prompt / cache saved / output / reasoning / calls /
  cost when any), one `DataTable` of calls — turn, step, who, model, stacked prompt bar (null
  parts hatched "n/a", `~` on every figure), billed, ttft, decode, finish. A row opens its
  `items`. One `Notice` at the top naming the door and, from `missing`, what it cannot see.
- Settings › Usage: a **Spend** `TabBar` tab on `/api/usage/calls` — `Segmented` group-by,
  `StatStrip`, `DataTable`.
- `context-indicator.tsx`: "Open in inspector" names the Trace panel.

### 5 — Docs, rule, changelog

- `CLAUDE.md`, one rule under "Protocol and transport": *A model call is one record
  (`_daedalus/model_call`), whoever observed it. Which door a runtime has is `AgentDef.callsVia`,
  ordered; the first that attaches is the thread's for its life and the only one that rows
  (`usage_update` rows only on a `usage` thread). Every door hands a draft to `recordCall` and
  touches nothing else; every server-built record is counted by `prompt-parts.ts` and anchored
  to the billed total; a part a door cannot see is `null` and named in `missing`, never
  "overhead". No spans.* → `docs/protocol.md` "Model calls".
- `docs/protocol.md`: the record, the event, the doors, the trust rules. `docs/ops.md`: the
  ledger and the Spend tab. `CHANGELOG.md` under `[Unreleased]`, one line per visible change.

## Checks

- `cd agent && pnpm test`; `cd server && pnpm exec tsc --noEmit && pnpm test:model-calls &&
  pnpm test:otlp && pnpm test:gateway && pnpm test:prompt-files`; `cd client && pnpm exec tsc -b`.
- Manual: a Daedalus thread with an MCP server linked → rows with parts, the `mcp` slice moves
  on toggle; a Claude Code thread → the same rows from its telemetry with `costUsd`; the same
  agent on a Default profile → `files` rows with `missing` named; a Codex thread on a gateway →
  `proxy` rows; one with none of these → billed-only rows and the notice; Spend sums them all.

## Out of scope, and when it comes back

- **OTel export to an external backend** — when someone names the backend; one env-gated agent
  file, and a relay from the `otlp` door for Claude Code.
- **A Codex OTLP dialect** — a second `otlp` dialect when its exporter's event names are written
  down; the door is dialect-keyed for exactly this.
- **Cost in currency for runtimes that report none** — `models.pricing` × the billed columns in
  `lib/trace.ts`, when the Spend tab is asked for money.
- **A transcript-inferred split** — not coming back; `missing` says what is not known instead.
